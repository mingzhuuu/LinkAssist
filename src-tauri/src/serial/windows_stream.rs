//! Keep COM driver calls (including CloseHandle) off Tokio's shared IOCP reactor.
//! A driver that stalls while closing must not freeze timers, HTTP or other ports.
use std::future::Future;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, RawHandle};
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc as blocking, Arc,
};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use serialport::SerialPort;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{mpsc, oneshot, watch};

const READ_SLICE: Duration = Duration::from_millis(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_CHUNK: usize = 256;

#[repr(C)]
struct CommTimeouts {
    read_interval_timeout: u32,
    read_total_timeout_multiplier: u32,
    read_total_timeout_constant: u32,
    write_total_timeout_multiplier: u32,
    write_total_timeout_constant: u32,
}

#[link(name = "kernel32")]
extern "system" {
    fn SetCommTimeouts(handle: RawHandle, timeouts: *const CommTimeouts) -> i32;
}

fn configure_comm_timeouts(handle: RawHandle) -> io::Result<()> {
    let timeouts = CommTimeouts {
        read_interval_timeout: u32::MAX,
        read_total_timeout_multiplier: u32::MAX,
        read_total_timeout_constant: READ_SLICE.as_millis() as u32,
        write_total_timeout_multiplier: 0,
        write_total_timeout_constant: WRITE_TIMEOUT.as_millis() as u32,
    };
    if unsafe { SetCommTimeouts(handle, &timeouts) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

trait PortIo: Read + Write + Send + 'static {
    fn dsr_ready(&mut self) -> io::Result<bool>;
}

impl PortIo for serialport::COMPort {
    fn dsr_ready(&mut self) -> io::Result<bool> {
        self.read_data_set_ready().map_err(io::Error::other)
    }
}

struct WriteRequest {
    bytes: Vec<u8>,
    reply: oneshot::Sender<io::Result<usize>>,
}

#[derive(Clone)]
pub(super) struct Shutdown {
    stopped: Arc<AtomicBool>,
    finished: watch::Receiver<bool>,
}

impl Shutdown {
    pub(super) async fn close(mut self) -> io::Result<()> {
        self.stopped.store(true, Ordering::Release);
        tokio::time::timeout(CLOSE_TIMEOUT, self.finished.wait_for(|done| *done))
            .await
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Serial driver did not finish closing within 3 seconds",
                )
            })?
            .map_err(|_| io::Error::other("Serial worker exited unexpectedly"))?;
        Ok(())
    }
}

pub(super) struct SerialStream {
    incoming: mpsc::Receiver<io::Result<Vec<u8>>>,
    writes: blocking::Sender<WriteRequest>,
    pending_write: Option<oneshot::Receiver<io::Result<usize>>>,
    buffered: Vec<u8>,
    offset: usize,
    write_chunk: usize,
    shutdown: Shutdown,
}

impl SerialStream {
    pub(super) async fn open(
        builder: serialport::SerialPortBuilder,
        dtr_dsr: bool,
        baud_rate: u32,
    ) -> io::Result<Self> {
        let mut stream = Self::spawn(
            move || {
                let mut port = builder
                    .timeout(READ_SLICE)
                    .open_native()
                    .map_err(io::Error::other)?;
                configure_comm_timeouts(port.as_raw_handle())?;
                if dtr_dsr {
                    port.write_data_terminal_ready(true)
                        .map_err(io::Error::other)?;
                }
                let _ = port.clear(serialport::ClearBuffer::All);
                Ok(port)
            },
            dtr_dsr,
        )
        .await?;
        // Keep each write below roughly half a second even at low baud rates.
        stream.write_chunk = ((baud_rate / 24) as usize).clamp(1, WRITE_CHUNK);
        Ok(stream)
    }

    async fn spawn<P: PortIo>(
        open: impl FnOnce() -> io::Result<P> + Send + 'static,
        dtr_dsr: bool,
    ) -> io::Result<Self> {
        let (incoming_tx, incoming) = mpsc::channel(16);
        let (writes, requests) = blocking::channel();
        let (ready_tx, ready) = oneshot::channel();
        let (finished_tx, finished) = watch::channel(false);
        let stopped = Arc::new(AtomicBool::new(false));
        let shutdown = Shutdown {
            stopped: stopped.clone(),
            finished,
        };
        let stream = Self {
            incoming,
            writes,
            pending_write: None,
            buffered: Vec::new(),
            offset: 0,
            write_chunk: WRITE_CHUNK,
            shutdown,
        };
        std::thread::Builder::new()
            .name("serial-driver".into())
            .spawn(move || {
                match open() {
                    Ok(mut port) => {
                        if ready_tx.send(Ok(())).is_ok() {
                            run_port(&mut port, requests, incoming_tx, &stopped, dtr_dsr);
                        }
                        // The handle is owned and released ONLY on this dedicated thread.
                        drop(port);
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
                let _ = finished_tx.send(true);
            })?;
        tokio::time::timeout(CLOSE_TIMEOUT, ready)
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Serial driver open timed out"))?
            .map_err(|_| io::Error::other("Serial worker failed to open"))??;
        Ok(stream)
    }

    pub(super) fn shutdown_handle(&self) -> Shutdown {
        self.shutdown.clone()
    }
}

fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "Serial port closed")
}

fn run_port<P: PortIo>(
    port: &mut P,
    requests: blocking::Receiver<WriteRequest>,
    incoming: mpsc::Sender<io::Result<Vec<u8>>>,
    stopped: &AtomicBool,
    dtr_dsr: bool,
) {
    let mut buf = [0u8; 4096];
    let mut pending = None;
    while !stopped.load(Ordering::Acquire) {
        // Even when receive delivery is backpressured, writes and close keep working.
        match requests.try_recv() {
            Ok(request) => {
                let result = write_port(port, &request.bytes, stopped, dtr_dsr);
                let failed = result.is_err();
                let _ = request.reply.send(result);
                if failed {
                    break;
                }
            }
            Err(blocking::TryRecvError::Disconnected) => break,
            Err(blocking::TryRecvError::Empty) => {}
        }
        if pending.is_none() {
            pending = match port.read(&mut buf) {
                Ok(0) => None,
                Ok(n) => Some(Ok(buf[..n].to_vec())),
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut
                            | io::ErrorKind::WouldBlock
                            | io::ErrorKind::Interrupted
                    ) =>
                {
                    None
                }
                Err(error) => Some(Err(error)),
            };
        }
        if let Some(packet) = pending.take() {
            let failed = packet.is_err();
            match incoming.try_send(packet) {
                Ok(()) if failed => break,
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => break,
                Err(mpsc::error::TrySendError::Full(packet)) => {
                    pending = Some(packet);
                    std::thread::sleep(READ_SLICE);
                }
            }
        }
    }
}

fn write_port<P: PortIo>(
    port: &mut P,
    bytes: &[u8],
    stopped: &AtomicBool,
    dtr_dsr: bool,
) -> io::Result<usize> {
    let deadline = Instant::now() + WRITE_TIMEOUT;
    while dtr_dsr && !port.dsr_ready()? {
        if stopped.load(Ordering::Acquire) {
            return Err(closed());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "DSR not ready"));
        }
        std::thread::sleep(READ_SLICE);
    }
    if stopped.load(Ordering::Acquire) {
        return Err(closed());
    }
    port.write_all(bytes)?;
    Ok(bytes.len())
}

impl AsyncRead for SerialStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.offset == self.buffered.len() {
            match std::task::ready!(self.incoming.poll_recv(cx)) {
                Some(Ok(bytes)) => {
                    self.buffered = bytes;
                    self.offset = 0;
                }
                Some(Err(error)) => return Poll::Ready(Err(error)),
                None => return Poll::Ready(Ok(())),
            }
        }
        let n = buf.remaining().min(self.buffered.len() - self.offset);
        buf.put_slice(&self.buffered[self.offset..self.offset + n]);
        self.offset += n;
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for SerialStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.shutdown.stopped.load(Ordering::Acquire) {
            return Poll::Ready(Err(closed()));
        }
        if self.pending_write.is_none() {
            if bytes.is_empty() {
                return Poll::Ready(Ok(0));
            }
            let (reply, receive) = oneshot::channel();
            if self
                .writes
                .send(WriteRequest {
                    bytes: bytes[..bytes.len().min(self.write_chunk)].to_vec(),
                    reply,
                })
                .is_err()
            {
                return Poll::Ready(Err(closed()));
            }
            self.pending_write = Some(receive);
        }
        let result = std::task::ready!(Pin::new(
            self.pending_write.as_mut().expect("pending write exists")
        )
        .poll(cx));
        self.pending_write = None;
        Poll::Ready(result.unwrap_or_else(|_| Err(closed())))
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Writes are acknowledged only after WriteFile completes. FlushFileBuffers
        // can wait forever for hardware flow control and must not be used here.
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.shutdown.stopped.store(true, Ordering::Release);
        Poll::Ready(Ok(()))
    }
}

impl Drop for SerialStream {
    fn drop(&mut self) {
        self.shutdown.stopped.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Default)]
    struct FakePort {
        input: VecDeque<u8>,
        written: Arc<Mutex<Vec<u8>>>,
        drop_gate: Option<blocking::Receiver<()>>,
        fail_write: bool,
    }
    impl Read for FakePort {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.input.is_empty() {
                std::thread::sleep(READ_SLICE);
                return Err(io::ErrorKind::TimedOut.into());
            }
            let n = buf.len().min(self.input.len());
            for byte in &mut buf[..n] {
                *byte = self.input.pop_front().unwrap();
            }
            Ok(n)
        }
    }
    impl Write for FakePort {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail_write {
                return Err(io::ErrorKind::TimedOut.into());
            }
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            panic!("must not flush a COM driver")
        }
    }
    impl PortIo for FakePort {
        fn dsr_ready(&mut self) -> io::Result<bool> {
            Ok(true)
        }
    }
    impl Drop for FakePort {
        fn drop(&mut self) {
            if let Some(gate) = &self.drop_gate {
                let _ = gate.recv();
            }
        }
    }

    #[tokio::test]
    async fn preserves_raw_bytes_across_read_and_write_chunks() {
        let bytes: Vec<u8> = (0..=255).cycle().take(1025).collect();
        let mut port = FakePort::default();
        port.input = bytes.iter().copied().collect();
        let written = port.written.clone();
        let mut stream = SerialStream::spawn(|| Ok(port), false).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        let mut received = vec![0; bytes.len()];
        for chunk in received.chunks_mut(17) {
            stream.read_exact(chunk).await.unwrap();
        }
        assert_eq!(received, bytes);
        assert_eq!(*written.lock().unwrap(), bytes);
        stream.shutdown_handle().close().await.unwrap();
    }

    #[tokio::test]
    async fn closing_idle_port_does_not_wait_for_input() {
        let stream = SerialStream::spawn(|| Ok(FakePort::default()), false)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(500), stream.shutdown_handle().close())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn receive_backpressure_does_not_block_writes_or_close() {
        let mut port = FakePort::default();
        port.input = vec![42; 4096 * 40].into();
        let written = port.written.clone();
        let mut stream = SerialStream::spawn(|| Ok(port), false).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        tokio::time::timeout(
            Duration::from_millis(500),
            stream.write_all(b"display clock\r"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(*written.lock().unwrap(), b"display clock\r");
        tokio::time::timeout(Duration::from_millis(500), stream.shutdown_handle().close())
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stalled_driver_drop_leaves_runtime_alive_and_close_times_out() {
        let (release, gate) = blocking::channel();
        let mut port = FakePort::default();
        port.drop_gate = Some(gate);
        let stream = SerialStream::spawn(|| Ok(port), false).await.unwrap();
        let shutdown = stream.shutdown_handle();
        drop(stream);
        let close = tokio::spawn(shutdown.close());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !close.is_finished(),
            "must acknowledge actual driver release, not just task cancellation"
        );
        assert_eq!(
            close.await.unwrap().unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        release.send(()).unwrap();
    }

    #[tokio::test]
    async fn write_failure_stops_transport_and_reports_failure() {
        let mut port = FakePort::default();
        port.fail_write = true;
        let mut stream = SerialStream::spawn(|| Ok(port), false).await.unwrap();
        assert_eq!(
            stream.write_all(b"x").await.unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        assert!(stream.write_all(b"y").await.is_err());
        assert_eq!(stream.read(&mut [0; 1]).await.unwrap(), 0);
        stream.shutdown_handle().close().await.unwrap();
    }
}
