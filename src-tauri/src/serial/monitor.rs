//! USBPcap userspace adapter. No COM handle is opened by this module.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbCaptureConfig {
    pub bus: u16,
    pub address: u16,
    pub in_endpoint: u8,
    pub out_endpoint: u8,
    pub profile: String,
    pub packet_size: usize,
}
impl UsbCaptureConfig {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.bus == 0
            || !(1..=127).contains(&self.address)
            || !(129..=143).contains(&self.in_endpoint)
            || !(1..=15).contains(&self.out_endpoint)
        {
            return Err("Configure the USBPcap bus, device address (1–127), and data IN/OUT endpoints first".into());
        }
        if !["raw", "serial", "ftdi"].contains(&self.profile.as_str())
            || ![8, 16, 32, 64, 512, 1024].contains(&self.packet_size)
        {
            return Err("Unsupported USB payload profile or endpoint packet size".into());
        }
        Ok(())
    }
}

pub(super) fn validate_com_name(path: &str) -> Result<(), String> {
    if path
        .to_ascii_uppercase()
        .strip_prefix("COM")
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        Ok(())
    } else {
        Err("Expected a COM port name".into())
    }
}

enum CaptureProcess {
    Command(Child),
    #[cfg(windows)]
    Elevated(std::net::TcpStream),
}

impl CaptureProcess {
    fn stop(&mut self) -> Result<(), String> {
        match self {
            Self::Command(child) => {
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    child.kill().map_err(|e| e.to_string())?;
                }
                let _ = child.wait();
            }
            #[cfg(windows)]
            Self::Elevated(stream) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct MonitorManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<CaptureProcess>>>>>,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRecord {
    channel_id: String,
    connection_id: String,
    direction: String,
    sequence: String,
    request_id: String,
    timestamp_ticks: String,
    timestamp: u64,
    status: u32,
    completed_bytes: u32,
    flags: u32,
    offset: u32,
    data: Vec<u8>,
    source: String,
}
fn le16(b: &[u8], p: usize) -> u16 {
    u16::from_le_bytes([b[p], b[p + 1]])
}
fn le32(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]])
}
fn packet(
    b: &[u8],
    cfg: &UsbCaptureConfig,
    timestamp: u64,
    seq: u64,
    channel: &str,
    id: &str,
) -> Result<Option<MonitorRecord>, String> {
    if b.len() < 27 {
        return Err("Truncated USBPcap header".into());
    }
    let header = le16(b, 0) as usize;
    let length = le32(b, 23) as usize;
    if header < 27 || header > b.len() || length > b.len() - header {
        return Err("Truncated USBPcap payload; increase capture snaplen".into());
    }
    if le16(b, 17) != cfg.bus || le16(b, 19) != cfg.address || b[22] != 3 {
        return Ok(None);
    }
    let rx = b[21] == cfg.in_endpoint;
    if !rx && b[21] != cfg.out_endpoint {
        return Ok(None);
    }
    // Capture IN completion and OUT submission, never both halves of one URB.
    if (b[16] & 1 != 0) != rx {
        return Ok(None);
    }
    let mut data = b[header..header + length].to_vec();
    if rx && cfg.profile == "ftdi" {
        data.clear();
        for chunk in b[header..header + length].chunks(cfg.packet_size) {
            if chunk.len() < 2 {
                return Err("Incomplete FTDI modem-status header".into());
            }
            data.extend_from_slice(&chunk[2..]);
        }
    }
    if data.is_empty() && le32(b, 10) == 0 {
        return Ok(None);
    }
    Ok(Some(MonitorRecord {
        channel_id: channel.into(),
        connection_id: id.into(),
        direction: if rx { "rx" } else { "tx" }.into(),
        sequence: seq.to_string(),
        request_id: u64::from_le_bytes(b[2..10].try_into().map_err(|_| "Invalid URB ID")?)
            .to_string(),
        timestamp_ticks: (timestamp * 1000).to_string(),
        timestamp,
        status: if rx { le32(b, 10) } else { 0 },
        completed_bytes: data.len() as u32,
        flags: 0,
        offset: 0,
        data,
        source: if cfg.profile == "raw" {
            "USB BULK"
        } else {
            "USB SERIAL"
        }
        .into(),
    }))
}
struct Pcap<R> {
    reader: R,
    big: bool,
    nano: bool,
}
impl<R: Read> Pcap<R> {
    fn new(mut reader: R) -> Result<Self, String> {
        let mut h = [0u8; 24];
        reader.read_exact(&mut h).map_err(|e| {
            format!(
                "USBPcap did not start: {e}. Check driver installation and capture permissions."
            )
        })?;
        let (big, nano) = match &h[..4] {
            [0xd4, 0xc3, 0xb2, 0xa1] => (false, false),
            [0xa1, 0xb2, 0xc3, 0xd4] => (true, false),
            [0x4d, 0x3c, 0xb2, 0xa1] => (false, true),
            [0xa1, 0xb2, 0x3c, 0x4d] => (true, true),
            _ => return Err("Expected classic USBPcap PCAP, not pcapng".into()),
        };
        let p = Self { reader, big, nano };
        if p.number(&h, 20) != 249 {
            return Err("PCAP link type must be USBPCAP (249)".into());
        }
        Ok(p)
    }
    fn number(&self, b: &[u8], o: usize) -> u32 {
        if self.big {
            u32::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
        } else {
            le32(b, o)
        }
    }
    fn next(&mut self) -> Result<Option<(u64, Vec<u8>)>, String> {
        let mut h = [0u8; 16];
        match self.reader.read(&mut h[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
        self.reader
            .read_exact(&mut h[1..])
            .map_err(|e| e.to_string())?;
        let len = self.number(&h, 8) as usize;
        if len > 1024 * 1024 || len < 27 || self.number(&h, 12) as usize != len {
            return Err("Oversized or truncated PCAP record".into());
        }
        let mut b = vec![0u8; len];
        self.reader.read_exact(&mut b).map_err(|e| e.to_string())?;
        let timestamp = self.number(&h, 0) as u64 * 1000
            + self.number(&h, 4) as u64 / if self.nano { 1_000_000 } else { 1000 };
        Ok(Some((timestamp, b)))
    }
}
pub(crate) fn executable(directory: Option<&str>) -> Result<std::path::PathBuf, String> {
    if let Some(directory) = directory.map(str::trim).filter(|s| !s.is_empty()) {
        let directory = std::path::Path::new(directory);
        if !directory.is_absolute() {
            return Err("Choose an absolute USBPcap installation directory.".into());
        }
        for suffix in ["USBPcapCMD.exe", "extcap/USBPcapCMD.exe"] {
            let path = directory.join(suffix);
            if path.is_file() {
                return Ok(path);
            }
        }
        return Err("USBPcapCMD.exe not found in the selected directory (or its extcap folder). Choose the USBPcap/Wireshark installation directory, or clear it to use automatic detection.".into());
    }
    #[cfg(windows)]
    for path in super::usb_windows::installed_executables() {
        if path.is_file() {
            return Ok(path);
        }
    }
    for root in [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
    ]
    .into_iter()
    .flatten()
    {
        for suffix in ["USBPcap/USBPcapCMD.exe", "Wireshark/extcap/USBPcapCMD.exe"] {
            let path = std::path::PathBuf::from(&root).join(suffix);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err("USBPcapCMD.exe not found. See the USBPcap installation guide below.".into())
}
impl MonitorManager {
    pub fn stop_all(&self) {
        let ids = self
            .sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let child = self
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned();
        if let Some(child) = child {
            child.lock().map_err(|e| e.to_string())?.stop()?;
        }
        Ok(())
    }
    pub fn start(
        &self,
        path: String,
        channel: String,
        manual: Option<UsbCaptureConfig>,
        app: AppHandle,
        directory: Option<&str>,
        request_elevation: bool,
    ) -> Result<String, String> {
        validate_com_name(&path)?;
        if let Some(cfg) = &manual {
            cfg.validate()?;
        }
        if !cfg!(windows) {
            return Err("USBPcap monitoring requires Windows".into());
        }
        let (cfg, process, stdout) = start_capture(&path, manual, directory, request_elevation)?;
        let child = Arc::new(Mutex::new(process));
        let id = format!("monitor:{}", uuid::Uuid::new_v4());
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), child.clone());
        let sessions = self.sessions.clone();
        let worker_id = id.clone();
        let worker_child = child.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let spawn = std::thread::Builder::new()
            .name("usbpcap-reader".into())
            .spawn(move || {
                let result = (|| -> Result<(), String> {
                    let mut reader = Pcap::new(stdout)?;
                    let _ = ready_tx.send(Ok(()));
                    let mut seq = 0;
                    while let Some((timestamp, bytes)) = reader.next()? {
                        seq += 1;
                        if let Some(row) =
                            packet(&bytes, &cfg, timestamp, seq, &channel, &worker_id)?
                        {
                            app.emit("serial-monitor-data", vec![row])
                                .map_err(|e| e.to_string())?;
                        }
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = ready_tx.send(Err(error.clone()));
                    let _ = app.emit(
                        "serial-connection-error",
                        serde_json::json!({"connectionId":worker_id,"error":error}),
                    );
                }
                if let Ok(mut child) = worker_child.lock() {
                    let _ = child.stop();
                }
                if let Ok(mut sessions) = sessions.lock() {
                    sessions.remove(&worker_id);
                }
                let _ = app.emit(
                    "serial-connection-closed",
                    serde_json::json!({"connectionId":worker_id}),
                );
            });
        if let Err(error) = spawn {
            let _ = self.stop(&id);
            self.sessions.lock().map_err(|e| e.to_string())?.remove(&id);
            return Err(error.to_string());
        }
        match ready_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => Ok(id),
            result => {
                let _ = self.stop(&id);
                Err(match result {
                    Ok(Err(e)) => e,
                    _ => "USBPcap startup timed out. Check installation and capture permissions."
                        .into(),
                })
            }
        }
    }
}

type CaptureStream = (UsbCaptureConfig, CaptureProcess, Box<dyn Read + Send>);

fn start_capture(
    path: &str,
    manual: Option<UsbCaptureConfig>,
    directory: Option<&str>,
    request_elevation: bool,
) -> Result<CaptureStream, String> {
    #[cfg(not(windows))]
    let _ = request_elevation;
    let cfg = if let Some(cfg) = &manual {
        #[cfg(windows)]
        {
            super::usb_windows::check_usb_port(path)?;
            executable(directory)?;
            if let Err(error) = super::usb_windows::check_capture_access(cfg.bus) {
                if request_elevation && error.starts_with("Access denied") {
                    return start_elevated_capture(path, manual.as_ref());
                }
                return Err(error);
            }
        }
        cfg.clone()
    } else {
        let report = super::usb_discovery::inspect(path, directory);
        #[cfg(windows)]
        if request_elevation && report.status == "access_denied" {
            return start_elevated_capture(path, None);
        }
        report.capture.ok_or(report.message)?
    };
    cfg.validate()?;
    let executable = executable(directory)?;
    let mut command = Command::new(executable);
    command
        .args([
            "-d",
            &format!(r"\\.\USBPcap{}", cfg.bus),
            "--devices",
            &cfg.address.to_string(),
            "-s",
            "1048576",
            "-b",
            "4194304",
            "-o",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = command.spawn().map_err(|e| e.to_string())?;
    let stdout = process.stdout.take().ok_or("Missing USBPcap output pipe")?;
    Ok((cfg, CaptureProcess::Command(process), Box::new(stdout)))
}

#[cfg(windows)]
fn start_elevated_capture(
    path: &str,
    manual: Option<&UsbCaptureConfig>,
) -> Result<CaptureStream, String> {
    let (cfg, reader) = super::monitor_elevation::start(path, manual)?;
    let stream = reader.get_ref().try_clone().map_err(|e| e.to_string())?;
    Ok((cfg, CaptureProcess::Elevated(stream), Box::new(reader)))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_installation_directory_is_explicit_and_supports_wireshark() {
        assert!(executable(Some("relative/path"))
            .unwrap_err()
            .contains("absolute"));
        let root = std::env::temp_dir().join(format!(
            "linkassist-usbpcap-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let directory = root.to_str().unwrap();
        // A bad explicit path must not silently fall back to an installed copy.
        assert!(executable(Some(directory))
            .unwrap_err()
            .contains("selected directory"));
        std::fs::create_dir(root.join("extcap")).unwrap();
        let extcap = root.join("extcap/USBPcapCMD.exe");
        std::fs::write(&extcap, []).unwrap();
        assert_eq!(executable(Some(directory)).unwrap(), extcap);
        let direct = root.join("USBPcapCMD.exe");
        std::fs::write(&direct, []).unwrap();
        assert_eq!(executable(Some(directory)).unwrap(), direct);
        std::fs::remove_file(direct).unwrap();
        std::fs::remove_file(extcap).unwrap();
        std::fs::remove_dir(root.join("extcap")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    fn config() -> UsbCaptureConfig {
        UsbCaptureConfig {
            bus: 1,
            address: 3,
            in_endpoint: 129,
            out_endpoint: 2,
            profile: "serial".into(),
            packet_size: 64,
        }
    }
    fn usb(rx: bool) -> Vec<u8> {
        let mut b = vec![0; 30];
        b[0] = 27;
        b[16] = u8::from(rx);
        b[17] = 1;
        b[19] = 3;
        b[21] = if rx { 129 } else { 2 };
        b[22] = 3;
        b[23] = 3;
        b[27..].copy_from_slice(&[1, 2, 3]);
        b
    }
    #[test]
    fn filters_direction_and_device() {
        let cfg = config();
        let b = usb(true);
        assert_eq!(
            packet(&b, &cfg, 100, 1, "c", "m").unwrap().unwrap().data,
            [1, 2, 3]
        );
        let mut b = usb(false);
        assert_eq!(
            packet(&b, &cfg, 100, 1, "c", "m")
                .unwrap()
                .unwrap()
                .direction,
            "tx"
        );
        b[16] = 1;
        assert!(packet(&b, &cfg, 0, 0, "c", "m").unwrap().is_none());
        b[19] = 4;
        assert!(packet(&b, &cfg, 0, 0, "c", "m").unwrap().is_none());
    }
    #[test]
    fn strips_ftdi_per_packet() {
        let mut cfg = config();
        cfg.profile = "ftdi".into();
        let mut b = usb(true);
        b.resize(27 + 67, 0);
        b[23] = 67;
        b[27 + 2] = 42;
        b[27 + 64 + 2] = 43;
        let row = packet(&b, &cfg, 0, 0, "c", "m").unwrap().unwrap();
        assert_eq!(row.data.len(), 63);
        assert_eq!(row.data[0], 42);
        assert_eq!(row.data[62], 43);
    }
    #[test]
    fn rejects_corrupt_packets() {
        assert!(packet(&[0; 26], &config(), 0, 0, "c", "m").is_err());
        let mut b = usb(true);
        b[23] = 100;
        assert!(packet(&b, &config(), 0, 0, "c", "m").is_err());
        assert!(Pcap::new(&[0u8; 24][..]).is_err());
    }
    #[test]
    fn reads_classic_pcap() {
        let mut b = vec![0; 24];
        b[..4].copy_from_slice(&[0xd4, 0xc3, 0xb2, 0xa1]);
        b[20] = 249;
        b.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 30, 0, 0, 0, 30, 0, 0, 0]);
        b.extend(usb(true));
        let mut p = Pcap::new(&b[..]).unwrap();
        let (t, row) = p.next().unwrap().unwrap();
        assert_eq!(t, 1000);
        assert_eq!(row.len(), 30);
        assert!(p.next().unwrap().is_none());
    }
    #[test]
    fn rejects_other_interfaces_and_transfer_types() {
        for (offset, value) in [(17, 2), (19, 4), (21, 130), (22, 1)] {
            let mut b = usb(true);
            b[offset] = value;
            assert!(packet(&b, &config(), 0, 0, "c", "m").unwrap().is_none());
        }
    }
    #[test]
    fn reads_big_endian_nanosecond_timestamps() {
        let mut b = vec![0; 24];
        b[..4].copy_from_slice(&[0xa1, 0xb2, 0x3c, 0x4d]);
        b[23] = 249;
        for value in [2u32, 123_000_000, 30, 30] {
            b.extend(value.to_be_bytes());
        }
        b.extend(usb(true));
        assert_eq!(Pcap::new(&b[..]).unwrap().next().unwrap().unwrap().0, 2123);
    }
    #[test]
    fn rejects_truncated_and_oversized_records() {
        for length in [26u32, 1_048_577] {
            let mut b = vec![0; 24];
            b[..4].copy_from_slice(&[0xd4, 0xc3, 0xb2, 0xa1]);
            b[20] = 249;
            for value in [0u32, 0, length, length] {
                b.extend(value.to_le_bytes());
            }
            assert!(Pcap::new(&b[..]).unwrap().next().is_err());
        }
    }
}
