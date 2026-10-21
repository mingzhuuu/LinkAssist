use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UdpDataEvent {
    pub local_addr: String,
    pub remote_addr: String,
    pub data: Vec<u8>,
    pub timestamp: u64,
}

pub struct UdpManager {
    socket: Arc<RwLock<Option<Arc<UdpSocket>>>>,
    bound_addr: Arc<RwLock<Option<String>>>,
    read_task: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
}

impl UdpManager {
    pub fn new() -> Self {
        Self {
            socket: Arc::new(RwLock::new(None)),
            bound_addr: Arc::new(RwLock::new(None)),
            read_task: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn bind(&self, addr: &str, app_handle: AppHandle) -> AppResult<String> {
        // Release any previous socket first: overwriting the task handle below
        // would detach (not stop) the old read loop and leak the old binding.
        self.unbind().await?;

        let socket = UdpSocket::bind(addr)
            .await
            .map_err(|e| AppError::Tcp(format!("UDP bind failed: {}", e)))?;
        let bound_addr = socket
            .local_addr()
            .map_err(|e| AppError::Tcp(format!("Could not get local addr: {}", e)))?
            .to_string();

        let socket = Arc::new(socket);
        *self.socket.write().await = Some(socket.clone());
        *self.bound_addr.write().await = Some(bound_addr.clone());

        let read_bound_addr = bound_addr.clone();
        let read_socket = socket;
        let read_app = app_handle;

        let read_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                let result = timeout(Duration::from_millis(50), read_socket.recv_from(&mut buf)).await;
                match result {
                    Ok(Ok((n, remote_addr))) => {
                        if n == 0 {
                            continue;
                        }
                        let timestamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let _ = read_app.emit("udp-data-received", UdpDataEvent {
                            local_addr: read_bound_addr.clone(),
                            remote_addr: remote_addr.to_string(),
                            data: buf[..n].to_vec(),
                            timestamp,
                        });
                    }
                    Ok(Err(_)) => {
                        // Socket error, stop
                        break;
                    }
                    Err(_) => {
                        // Timeout — no data, continue polling
                        continue;
                    }
                }
            }
        });

        *self.read_task.write().await = Some(read_task);
        Ok(bound_addr)
    }

    pub async fn unbind(&self) -> AppResult<()> {
        // Abort read task first
        if let Some(task) = self.read_task.write().await.take() {
            task.abort();
            // The read task owns an Arc to the socket. Cancellation must finish
            // before dropping our Arc and allowing an immediate rebind.
            let _ = task.await;
        }
        *self.socket.write().await = None;
        *self.bound_addr.write().await = None;
        Ok(())
    }

    pub async fn send_to(&self, addr: &str, data: &[u8]) -> AppResult<usize> {
        let socket_guard = self.socket.read().await;
        let socket = socket_guard
            .as_ref()
            .ok_or_else(|| AppError::Tcp("UDP socket not bound".to_string()))?;
        socket
            .send_to(data, addr)
            .await
            .map_err(AppError::Io)
    }

    pub async fn is_bound(&self) -> bool {
        self.socket.read().await.is_some()
    }
}

impl Default for UdpManager {
    fn default() -> Self {
        Self::new()
    }
}
