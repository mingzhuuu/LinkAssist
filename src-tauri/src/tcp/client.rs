use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpDataEvent {
    pub connection_id: String,
    pub data: Vec<u8>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpErrorEvent {
    pub connection_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpConnectionClosedEvent {
    pub connection_id: String,
}

pub struct TcpClientConnection {
    pub id: String,
    pub remote_addr: String,
    writer: Arc<tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    read_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct TcpClientManager {
    connections: Arc<RwLock<HashMap<String, TcpClientConnection>>>,
}

impl TcpClientManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn connect(&self, addr: &str, app_handle: AppHandle) -> AppResult<String> {
        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| AppError::Tcp(format!("Connect failed: {}", e)))?;
        let sock_ref = socket2::SockRef::from(&stream);
        let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(5));
        let _ = sock_ref.set_tcp_keepalive(&keepalive);
        let id = Uuid::new_v4().to_string();

        let (read_half, write_half) = stream.into_split();
        let writer = Arc::new(tokio::sync::Mutex::new(write_half));

        let read_conn_id = id.clone();
        let read_app = app_handle;

        let read_task = tokio::spawn(async move {
            let mut reader = read_half;
            let mut buf = vec![0u8; 4096];
            loop {
                let result = timeout(Duration::from_millis(50), reader.read(&mut buf)).await;
                match result {
                    Ok(Ok(0)) => {
                        let _ = read_app.emit("tcp-connection-error", TcpErrorEvent {
                            connection_id: read_conn_id.clone(),
                            error: "Connection closed".to_string(),
                        });
                        let _ = read_app.emit("tcp-connection-closed", TcpConnectionClosedEvent {
                            connection_id: read_conn_id.clone(),
                        });
                        break;
                    }
                    Ok(Ok(n)) => {
                        let timestamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let _ = read_app.emit("tcp-data-received", TcpDataEvent {
                            connection_id: read_conn_id.clone(),
                            data: buf[..n].to_vec(),
                            timestamp,
                        });
                    }
                    Ok(Err(e)) => {
                        let _ = read_app.emit("tcp-connection-error", TcpErrorEvent {
                            connection_id: read_conn_id.clone(),
                            error: e.to_string(),
                        });
                        let _ = read_app.emit("tcp-connection-closed", TcpConnectionClosedEvent {
                            connection_id: read_conn_id.clone(),
                        });
                        break;
                    }
                    Err(_) => {
                        // Timeout — no data, continue polling
                        continue;
                    }
                }
            }
        });

        let mut connections = self.connections.write().await;
        connections.insert(
            id.clone(),
            TcpClientConnection {
                id: id.clone(),
                remote_addr: addr.to_string(),
                writer,
                read_task: Some(read_task),
            },
        );
        Ok(id)
    }

    pub async fn disconnect(&self, id: &str) -> AppResult<()> {
        let mut connections = self.connections.write().await;
        let conn = connections
            .remove(id)
            .ok_or_else(|| AppError::Tcp(format!("Connection not found: {}", id)))?;
        if let Some(task) = conn.read_task {
            task.abort();
        }
        Ok(())
    }

    pub async fn send(&self, id: &str, data: &[u8]) -> AppResult<usize> {
        let connections = self.connections.read().await;
        let conn = connections
            .get(id)
            .ok_or_else(|| AppError::Tcp(format!("Connection not found: {}", id)))?;
        let mut writer = conn.writer.lock().await;
        writer.write_all(data).await.map_err(AppError::Io)?;
        Ok(data.len())
    }

    pub async fn list_connections(&self) -> Vec<(String, String)> {
        let connections = self.connections.read().await;
        connections
            .values()
            .map(|c| (c.id.clone(), c.remote_addr.clone()))
            .collect()
    }
}

impl Default for TcpClientManager {
    fn default() -> Self {
        Self::new()
    }
}
