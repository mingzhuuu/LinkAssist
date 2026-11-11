pub mod io;
pub mod port;
pub mod monitor;
pub mod usb_discovery;
#[cfg(windows)]
pub(crate) mod monitor_elevation;
#[cfg(windows)]
mod usb_windows;
#[cfg(windows)]
mod windows_stream;

pub use io::SerialIoManager;
pub use port::{list_ports, PortInfo, SerialConfig};

pub struct SerialManager {
    pub io: SerialIoManager,
    pub monitor: monitor::MonitorManager,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            io: SerialIoManager::new(),
            monitor: monitor::MonitorManager::default(),
        }
    }
}

impl Default for SerialManager {
    fn default() -> Self {
        Self::new()
    }
}
