pub mod io;
pub mod port;

pub use io::SerialIoManager;
pub use port::{list_ports, PortInfo, SerialConfig};

pub struct SerialManager {
    pub io: SerialIoManager,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            io: SerialIoManager::new(),
        }
    }
}

impl Default for SerialManager {
    fn default() -> Self {
        Self::new()
    }
}
