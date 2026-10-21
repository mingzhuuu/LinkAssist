use crate::error::{AppError, AppResult};
use crate::tcp::client::{TcpDataEvent, TcpErrorEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpClientConnectedEvent {
    pub id: String,
    pub addr: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpClientDisconnectedEvent {
    pub id: String,
    pub addr: String,
}

pub struct TcpServerClient {
    pub id: String,
    pub addr: String,
    writer: Arc<tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    read_task: Option<tokio::task::JoinHandle<()>>,
}

pub struct TcpServerManager {
    clients: Arc<RwLock<HashMap<String, TcpServerClient>>>,
    listening_addr: Arc<RwLock<Option<String>>>,
    accept_task: Arc<RwLock<Option<tokio::task::JoinHandle<()>>>>,
}

impl TcpServerManager {
    pub fn new() -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            listening_addr: Arc::new(RwLock::new(None)),
            accept_task: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn start_listening(&self, addr: &str, app_handle: AppHandle) -> AppResult<String> {
        // Tear down any previous listener first: overwriting the task handle
        // below would detach (not stop) a still-running accept loop, and
        // rebinding the same port would fail while it lives.
        self.stop_listening(&app_handle).await?;

        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| AppError::Tcp(format!("Bind failed: {}", e)))?;
        let bound_addr = listener
            .local_addr()
            .map_err(|e| AppError::Tcp(format!("Could not get local addr: {}", e)))?
            .to_string();

        *self.listening_addr.write().await = Some(bound_addr.clone());

        let clients_arc = self.clients.clone();
        let app = app_handle;

        let accept_handle = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        let sock_ref = socket2::SockRef::from(&stream);
                        let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(5));
                        let _ = sock_ref.set_tcp_keepalive(&keepalive);
                        let id = Uuid::new_v4().to_string();
                        let addr_str = addr.to_string();

                        let (read_half, write_half) = stream.into_split();
                        let writer = Arc::new(tokio::sync::Mutex::new(write_half));

                        // Emit client connected event
                        let _ = app.emit("tcp-client-connected", TcpClientConnectedEvent {
                            id: id.clone(),
                            addr: addr_str.clone(),
                        });

                        // Spawn read task for this client
                        let read_client_id = id.clone();
                        let read_client_addr = addr_str.clone();
                        let read_app = app.clone();
                        let read_clients = clients_arc.clone();

                        let read_task = tokio::spawn(async move {
                            let mut reader = read_half;
                            let mut buf = vec![0u8; 4096];
                            loop {
                                let result =
                                    timeout(Duration::from_millis(50), reader.read(&mut buf)).await;
                                match result {
                                    Ok(Ok(0)) => {
                                        // Client disconnected
                                        let _ = read_app.emit(
                                            "tcp-client-disconnected",
                                            TcpClientDisconnectedEvent {
                                                id: read_client_id.clone(),
                                                addr: read_client_addr.clone(),
                                            },
                                        );
                                        let _ = read_app.emit(
                                            "tcp-connection-error",
                                            TcpErrorEvent {
                                                connection_id: read_client_id.clone(),
                                                error: "Client disconnected".to_string(),
                                            },
                                        );
                                        read_clients.write().await.remove(&read_client_id);
                                        break;
                                    }
                                    Ok(Ok(n)) => {
                                        let timestamp = std::time::SystemTime::now()
                                            .duration_since(std::time::UNIX_EPOCH)
                                            .unwrap_or_default()
                                            .as_millis()
                                            as u64;
                                        let _ = read_app.emit(
                                            "tcp-data-received",
                                            TcpDataEvent {
                                                connection_id: read_client_id.clone(),
                                                data: buf[..n].to_vec(),
                                                timestamp,
                                            },
                                        );
                                    }
                                    Ok(Err(e)) => {
                                        let _ = read_app.emit(
                                            "tcp-client-disconnected",
                                            TcpClientDisconnectedEvent {
                                                id: read_client_id.clone(),
                                                addr: read_client_addr.clone(),
                                            },
                                        );
                                        let _ = read_app.emit(
                                            "tcp-connection-error",
                                            TcpErrorEvent {
                                                connection_id: read_client_id.clone(),
                                                error: e.to_string(),
                                            },
                                        );
                                        read_clients.write().await.remove(&read_client_id);
                                        break;
                                    }
                                    Err(_) => continue,
                                }
                            }
                        });

                        clients_arc.write().await.insert(
                            id.clone(),
                            TcpServerClient {
                                id,
                                addr: addr_str,
                                writer,
                                read_task: Some(read_task),
                            },
                        );
                    }
                    Err(_) => {
                        // Listener closed or error, exit loop
                        break;
                    }
                }
            }
        });

        *self.accept_task.write().await = Some(accept_handle);
        Ok(bound_addr)
    }

    pub async fn stop_listening(&self, app_handle: &AppHandle) -> AppResult<()> {
        // Abort accept loop
        if let Some(task) = self.accept_task.write().await.take() {
            task.abort();
            // Abort only schedules cancellation. Wait until the listener is
            // dropped before a subsequent start tries to bind the same port.
            let _ = task.await;
        }
        *self.listening_addr.write().await = None;
        // Abort all client read tasks and tell the frontend they are gone
        let mut clients = self.clients.write().await;
        for (_, client) in clients.drain() {
            if let Some(task) = client.read_task {
                task.abort();
            }
            let _ = app_handle.emit(
                "tcp-client-disconnected",
                TcpClientDisconnectedEvent {
                    id: client.id,
                    addr: client.addr,
                },
            );
        }
        Ok(())
    }

    pub async fn send_to_client(&self, client_id: &str, data: &[u8]) -> AppResult<usize> {
        let clients = self.clients.read().await;
        let client = clients
            .get(client_id)
            .ok_or_else(|| AppError::Tcp(format!("Client not found: {}", client_id)))?;
        let mut writer = client.writer.lock().await;
        writer.write_all(data).await.map_err(AppError::Io)?;
        Ok(data.len())
    }

    pub async fn disconnect_client(&self, client_id: &str) -> AppResult<()> {
        let mut clients = self.clients.write().await;
        let client = clients
            .remove(client_id)
            .ok_or_else(|| AppError::Tcp(format!("Client not found: {}", client_id)))?;
        if let Some(task) = client.read_task {
            task.abort();
        }
        Ok(())
    }

    pub async fn list_clients(&self) -> Vec<(String, String)> {
        let clients = self.clients.read().await;
        clients
            .values()
            .map(|c| (c.id.clone(), c.addr.clone()))
            .collect()
    }

    pub async fn is_listening(&self) -> bool {
        self.accept_task.read().await.is_some()
    }
}

impl Default for TcpServerManager {
    fn default() -> Self {
        Self::new()
    }
}
