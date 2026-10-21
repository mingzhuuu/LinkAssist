use crate::error::{AppError, AppResult};
use crate::serial::port::SerialConfig;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{interval, timeout, Duration, Instant, sleep};
use tokio_serial::{DataBits, FlowControl, Parity, SerialStream, StopBits};

// Short read slices keep the stream lock hold time bounded so concurrent
// sends are delayed by at most one slice instead of a full receive_timeout.
const SERIAL_READ_POLL_MS: u64 = 10;
const SERIAL_RECEIVE_BUFFER_POLL_MS: u64 = 10;
const SERIAL_BUFFERED_PACKET_LIMIT: usize = 128;
const SERIAL_MAX_PACKET_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialDataEvent {
    pub connection_id: String,
    pub data: Vec<u8>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialErrorEvent {
    pub connection_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectionClosedEvent {
    pub connection_id: String,
}

#[derive(Debug, Clone)]
pub enum FlowControlType {
    None,
    RtsCts,
    DtrDsr,
    XonXoff,
}

impl From<&str> for FlowControlType {
    fn from(s: &str) -> Self {
        match s {
            "none" => FlowControlType::None,
            "rts_cts" => FlowControlType::RtsCts,
            "dtr_dsr" => FlowControlType::DtrDsr,
            "xon_xoff" => FlowControlType::XonXoff,
            "hardware" => FlowControlType::RtsCts,
            "software" => FlowControlType::XonXoff,
            _ => FlowControlType::None,
        }
    }
}

pub struct SerialConnection {
    stream: Arc<tokio::sync::Mutex<SerialStream>>,
    read_task: Option<tokio::task::JoinHandle<()>>,
    flow_control: FlowControlType,
    receive_timeout: Duration,
    buffered_packets: Arc<Mutex<VecDeque<Vec<u8>>>>,
}

pub struct SerialIoManager {
    connections: Arc<RwLock<HashMap<String, SerialConnection>>>,
}

impl SerialIoManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn open(&self, config: &SerialConfig, app_handle: AppHandle) -> AppResult<String> {
        let (stream, flow_control) = build_serial_stream(config)?;
        let connection_id = config.path.clone();
        let receive_timeout = Duration::from_millis(config.receive_timeout_ms.max(1));

        let stream = Arc::new(tokio::sync::Mutex::new(stream));
        let read_stream = stream.clone();
        let read_conn_id = connection_id.clone();
        let read_app = app_handle.clone();
        let buffered_packets = Arc::new(Mutex::new(VecDeque::new()));
        let read_buffered_packets = buffered_packets.clone();

        let read_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let mut packet = Vec::new();
            let mut last_byte_at = Instant::now();
            loop {
                let result = {
                    let mut stream_guard = read_stream.lock().await;
                    timeout(
                        Duration::from_millis(SERIAL_READ_POLL_MS),
                        stream_guard.read(&mut buf),
                    )
                    .await
                };
                match result {
                    Ok(Ok(0)) => {
                        emit_serial_packet(&read_app, &read_conn_id, &read_buffered_packets, &mut packet).await;
                        let _ = read_app.emit("serial-connection-error", SerialErrorEvent {
                            connection_id: read_conn_id.clone(),
                            error: "Connection closed".to_string(),
                        });
                        let _ = read_app.emit("serial-connection-closed", SerialConnectionClosedEvent {
                            connection_id: read_conn_id.clone(),
                        });
                        break;
                    }
                    Ok(Ok(n)) => {
                        packet.extend_from_slice(&buf[..n]);
                        last_byte_at = Instant::now();
                        // A gapless stream never hits the idle branch; flush
                        // oversized packets so memory stays bounded.
                        if packet.len() >= SERIAL_MAX_PACKET_BYTES {
                            emit_serial_packet(&read_app, &read_conn_id, &read_buffered_packets, &mut packet).await;
                        }
                    }
                    Ok(Err(e)) => {
                        emit_serial_packet(&read_app, &read_conn_id, &read_buffered_packets, &mut packet).await;
                        let _ = read_app.emit("serial-connection-error", SerialErrorEvent {
                            connection_id: read_conn_id.clone(),
                            error: e.to_string(),
                        });
                        let _ = read_app.emit("serial-connection-closed", SerialConnectionClosedEvent {
                            connection_id: read_conn_id.clone(),
                        });
                        break;
                    }
                    Err(_) => {
                        // Packet boundary: no new bytes for at least receive_timeout.
                        if !packet.is_empty() && last_byte_at.elapsed() >= receive_timeout {
                            emit_serial_packet(&read_app, &read_conn_id, &read_buffered_packets, &mut packet).await;
                        }
                    }
                }
            }
        });

        let mut connections = self.connections.write().await;
        connections.insert(
            connection_id.clone(),
            SerialConnection {
                stream,
                read_task: Some(read_task),
                flow_control,
                receive_timeout,
                buffered_packets,
            },
        );
        drop(connections);

        let monitor_conn_id = connection_id.clone();
        let monitor_app = app_handle.clone();
        let monitor_connections = self.connections.clone();
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_secs(2));
            loop {
                ticker.tick().await;
                let connections = monitor_connections.read().await;
                if !connections.contains_key(&monitor_conn_id) {
                    break;
                }
                drop(connections);
                let ports = crate::serial::port::list_ports();
                let still_exists = ports.iter().any(|p| p.path == monitor_conn_id);
                if !still_exists {
                    let _ = monitor_app.emit(
                        "serial-connection-closed",
                        SerialConnectionClosedEvent {
                            connection_id: monitor_conn_id.clone(),
                        },
                    );
                    let mut connections = monitor_connections.write().await;
                    if let Some(conn) = connections.remove(&monitor_conn_id) {
                        if let Some(task) = conn.read_task {
                            task.abort();
                        }
                    }
                    break;
                }
            }
        });

        Ok(connection_id)
    }

    pub async fn close(&self, connection_id: &str) -> AppResult<()> {
        let mut connections = self.connections.write().await;
        let conn = connections
            .remove(connection_id)
            .ok_or_else(|| AppError::Serial(format!("Connection not found: {}", connection_id)))?;
        if let Some(task) = conn.read_task {
            task.abort();
        }
        Ok(())
    }

    pub async fn send(&self, connection_id: &str, data: &[u8]) -> AppResult<usize> {
        let connections = self.connections.read().await;
        let conn = connections
            .get(connection_id)
            .ok_or_else(|| AppError::Serial(format!("Connection not found: {}", connection_id)))?;

        if matches!(conn.flow_control, FlowControlType::DtrDsr) {
            let mut stream = conn.stream.lock().await;
            use serialport::SerialPort;
            
            const DSR_TIMEOUT_MS: u64 = 5000;
            const DSR_CHECK_INTERVAL_MS: u64 = 10;
            let mut waited_ms: u64 = 0;
            
            loop {
                match stream.read_data_set_ready() {
                    Ok(true) => break,
                    Ok(false) => {
                        if waited_ms >= DSR_TIMEOUT_MS {
                            return Err(AppError::Serial("DSR not ready - device not responding".to_string()));
                        }
                        drop(stream);
                        sleep(Duration::from_millis(DSR_CHECK_INTERVAL_MS)).await;
                        waited_ms += DSR_CHECK_INTERVAL_MS;
                        stream = conn.stream.lock().await;
                    }
                    Err(e) => {
                        return Err(AppError::Serial(format!("Failed to read DSR state: {}", e)));
                    }
                }
            }
            
            stream.write_all(data).await.map_err(AppError::Io)?;
            Ok(data.len())
        } else {
            let mut stream = conn.stream.lock().await;
            stream.write_all(data).await.map_err(AppError::Io)?;
            Ok(data.len())
        }
    }

    pub async fn receive(&self, connection_id: &str, _buf_size: usize) -> AppResult<Vec<u8>> {
        let connections = self.connections.read().await;
        let conn = connections
            .get(connection_id)
            .ok_or_else(|| AppError::Serial(format!("Connection not found: {}", connection_id)))?;

        let buffered_packets = conn.buffered_packets.clone();
        let receive_timeout = conn.receive_timeout + Duration::from_millis(SERIAL_READ_POLL_MS);
        drop(connections);

        let deadline = Instant::now() + receive_timeout;
        loop {
            if let Some(packet) = {
                let mut packets = buffered_packets.lock().await;
                packets.pop_front()
            } {
                return Ok(packet);
            }

            let now = Instant::now();
            if now >= deadline {
                return Ok(Vec::new());
            }

            let sleep_duration = std::cmp::min(
                Duration::from_millis(SERIAL_RECEIVE_BUFFER_POLL_MS),
                deadline.saturating_duration_since(now),
            );
            sleep(sleep_duration).await;
        }
    }

    pub async fn is_open(&self, connection_id: &str) -> bool {
        let connections = self.connections.read().await;
        connections.contains_key(connection_id)
    }

    pub async fn list_open(&self) -> Vec<String> {
        let connections = self.connections.read().await;
        connections.keys().cloned().collect()
    }
}

async fn emit_serial_packet(
    app_handle: &AppHandle,
    connection_id: &str,
    buffered_packets: &Arc<Mutex<VecDeque<Vec<u8>>>>,
    packet: &mut Vec<u8>,
) {
    if packet.is_empty() {
        return;
    }

    let emitted_packet = std::mem::take(packet);

    {
        let mut packets = buffered_packets.lock().await;
        if packets.len() >= SERIAL_BUFFERED_PACKET_LIMIT {
            packets.pop_front();
        }
        packets.push_back(emitted_packet.clone());
    }

    let _ = app_handle.emit(
        "serial-data-received",
        SerialDataEvent {
            connection_id: connection_id.to_string(),
            data: emitted_packet,
            timestamp: current_timestamp_ms(),
        },
    );
}

fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_serial_stream(config: &SerialConfig) -> AppResult<(SerialStream, FlowControlType)> {
    let data_bits = match config.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => return Err(AppError::Serial(format!("Invalid data bits: {}", config.data_bits))),
    };

    let stop_bits = match config.stop_bits {
        1 => StopBits::One,
        2 => StopBits::Two,
        _ => return Err(AppError::Serial(format!("Invalid stop bits: {}", config.stop_bits))),
    };

    let parity = match config.parity.as_str() {
        "none" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => return Err(AppError::Serial(format!("Invalid parity: {}", config.parity))),
    };

    let flow_control_type = FlowControlType::from(config.flow_control.as_str());
    
    let flow_control = match flow_control_type {
        FlowControlType::None => FlowControl::None,
        FlowControlType::RtsCts => FlowControl::Hardware,
        FlowControlType::DtrDsr => FlowControl::None,
        FlowControlType::XonXoff => FlowControl::Software,
    };

    let builder = tokio_serial::new(&config.path, config.baud_rate)
        .data_bits(data_bits)
        .stop_bits(stop_bits)
        .parity(parity)
        .flow_control(flow_control);

    let stream = SerialStream::open(&builder).map_err(|e| AppError::Serial(e.to_string()))?;
    
    let mut stream = stream;
    if matches!(flow_control_type, FlowControlType::DtrDsr) {
        use serialport::SerialPort;
        stream.write_data_terminal_ready(true)
            .map_err(|e| AppError::Serial(format!("Failed to set DTR: {}", e)))?;
    }

    Ok((stream, flow_control_type))
}
