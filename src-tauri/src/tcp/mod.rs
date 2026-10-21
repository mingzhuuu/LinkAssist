pub mod client;
pub mod server;
pub mod udp;

pub use client::TcpClientManager;
pub use server::TcpServerManager;
pub use udp::UdpManager;

pub struct NetworkManager {
    pub tcp_client: TcpClientManager,
    pub tcp_server: TcpServerManager,
    pub udp: UdpManager,
}

impl NetworkManager {
    pub fn new() -> Self {
        Self {
            tcp_client: TcpClientManager::new(),
            tcp_server: TcpServerManager::new(),
            udp: UdpManager::new(),
        }
    }
}

impl Default for NetworkManager {
    fn default() -> Self {
        Self::new()
    }
}
