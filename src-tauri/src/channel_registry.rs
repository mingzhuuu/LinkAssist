use crate::error::{AppError, AppResult};
use crate::persistence::load_config;
use crate::serial::SerialConfig;
use crate::AppState;
use btleplug::api::WriteType;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::RwLock;

/// Maps a UI channel id to its live transport connection so headless callers
/// (MCP Lua tools) can address "the current channel" without frontend state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBinding {
    /// "serial" | "tcp-client" | "tcp-server" | "udp" | "ble"
    pub channel_type: String,
    pub connection_id: String,
    /// Default UDP destination for `send` on udp channels.
    #[serde(default)]
    pub target_addr: Option<String>,
}

#[derive(Clone, Default)]
pub struct ChannelRegistry {
    inner: Arc<RwLock<HashMap<String, ChannelBinding>>>,
}

impl ChannelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, channel_id: String, binding: ChannelBinding) {
        self.inner.write().await.insert(channel_id, binding);
    }

    pub async fn unregister(&self, channel_id: &str) {
        self.inner.write().await.remove(channel_id);
    }

    /// Remove every binding that points at the given connection. Used when a
    /// transport closes and only the connection id is known.
    pub async fn unregister_connection(&self, connection_id: &str) {
        self.inner
            .write()
            .await
            .retain(|_, binding| binding.connection_id != connection_id);
    }

    /// Remove bindings by channel type; tcp-server and udp are singletons.
    pub async fn unregister_type(&self, channel_type: &str) {
        self.inner
            .write()
            .await
            .retain(|_, binding| binding.channel_type != channel_type);
    }

    pub async fn get(&self, channel_id: &str) -> Option<ChannelBinding> {
        self.inner.read().await.get(channel_id).cloned()
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SendOptions {
    /// UDP destination override.
    pub addr: Option<String>,
    /// tcp-server: send to one client instead of broadcasting.
    pub client_id: Option<String>,
    /// BLE write target (required for ble channels).
    pub service_uuid: Option<String>,
    pub char_uuid: Option<String>,
    /// BLE write without response.
    pub without_response: bool,
}

/// Send bytes to whatever connection the binding points at. Returns a JSON
/// summary suitable for returning straight to Lua/MCP callers.
pub async fn send_to_channel_binding(
    state: &AppState,
    channel_id: &str,
    binding: &ChannelBinding,
    data: &[u8],
    options: &SendOptions,
) -> AppResult<Value> {
    match binding.channel_type.as_str() {
        "serial" => {
            let manager = state.serial_manager.lock().await;
            if !manager.io.is_open(&binding.connection_id).await {
                drop(manager);
                state.channel_registry.unregister(channel_id).await;
                return Err(AppError::Serial(format!(
                    "Serial connection for channel '{}' is closed; call open_current_channel() first",
                    channel_id
                )));
            }
            let bytes_written = manager.io.send(&binding.connection_id, data).await?;
            Ok(json!({ "ok": true, "bytesWritten": bytes_written }))
        }
        "tcp-client" => {
            let manager = state.network_manager.lock().await;
            match manager.tcp_client.send(&binding.connection_id, data).await {
                Ok(bytes_written) => Ok(json!({ "ok": true, "bytesWritten": bytes_written })),
                Err(error) => {
                    drop(manager);
                    if error.to_string().contains("not found") {
                        state.channel_registry.unregister(channel_id).await;
                    }
                    Err(error)
                }
            }
        }
        "tcp-server" => {
            let manager = state.network_manager.lock().await;
            if let Some(client_id) = options.client_id.as_deref() {
                let bytes_written = manager.tcp_server.send_to_client(client_id, data).await?;
                return Ok(json!({ "ok": true, "bytesWritten": bytes_written, "clients": 1 }));
            }
            let clients = manager.tcp_server.list_clients().await;
            if clients.is_empty() {
                return Err(AppError::Tcp("No TCP client connected".to_string()));
            }
            let mut sent = 0usize;
            let mut errors = Vec::new();
            for (client_id, addr) in clients {
                match manager.tcp_server.send_to_client(&client_id, data).await {
                    Ok(_) => sent += 1,
                    Err(error) => errors.push(format!("{}: {}", addr, error)),
                }
            }
            if sent == 0 {
                return Err(AppError::Tcp(format!(
                    "Broadcast failed for every client: {}",
                    errors.join("; ")
                )));
            }
            Ok(json!({
                "ok": true,
                "bytesWritten": data.len(),
                "clients": sent,
                "errors": errors,
            }))
        }
        "udp" => {
            let addr = options
                .addr
                .clone()
                .or_else(|| binding.target_addr.clone())
                .ok_or_else(|| {
                    AppError::Tcp(
                        "UDP send needs a target: pass { addr = \"ip:port\" } or configure the channel's target address"
                            .to_string(),
                    )
                })?;
            let manager = state.network_manager.lock().await;
            let bytes_written = manager.udp.send_to(&addr, data).await?;
            Ok(json!({ "ok": true, "bytesWritten": bytes_written, "addr": addr }))
        }
        "ble" => {
            let (Some(service_uuid), Some(char_uuid)) =
                (options.service_uuid.as_deref(), options.char_uuid.as_deref())
            else {
                return Err(AppError::Ble(
                    "BLE send needs { serviceUuid = ..., charUuid = ... } in the options table"
                        .to_string(),
                ));
            };
            let peripheral = {
                let manager = state.ble_manager.lock().await;
                manager.connections.get_peripheral(&binding.connection_id).await
            };
            let peripheral = match peripheral {
                Ok(peripheral) => peripheral,
                Err(error) => {
                    state.channel_registry.unregister(channel_id).await;
                    return Err(error);
                }
            };
            let write_type = if options.without_response {
                WriteType::WithoutResponse
            } else {
                WriteType::WithResponse
            };
            crate::ble::gatt::write_characteristic(&peripheral, service_uuid, char_uuid, data, write_type)
                .await?;
            Ok(json!({ "ok": true, "bytesWritten": data.len() }))
        }
        other => Err(AppError::Protocol(format!(
            "Channel '{}' has unsupported binding type '{}'",
            channel_id, other
        ))),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TcpChannelSettings {
    mode: String,
    client_address: String,
    server_address: String,
    udp_bind_address: String,
    udp_target_address: String,
}

/// Check whether the binding's transport is still alive.
async fn binding_is_alive(state: &AppState, binding: &ChannelBinding) -> bool {
    match binding.channel_type.as_str() {
        "serial" => {
            state
                .serial_manager
                .lock()
                .await
                .io
                .is_open(&binding.connection_id)
                .await
        }
        "tcp-client" => {
            let manager = state.network_manager.lock().await;
            manager
                .tcp_client
                .list_connections()
                .await
                .iter()
                .any(|(id, _)| id == &binding.connection_id)
        }
        "tcp-server" => state.network_manager.lock().await.tcp_server.is_listening().await,
        "udp" => state.network_manager.lock().await.udp.is_bound().await,
        "ble" => {
            let manager = state.ble_manager.lock().await;
            manager.connections.is_connected(&binding.connection_id).await
        }
        _ => false,
    }
}

/// Open (or reuse) the channel's transport using the config saved by the UI,
/// register it, and return `{ channelType, connectionId, alreadyOpen }`.
pub async fn open_channel_from_config(
    state: &AppState,
    app_handle: &AppHandle,
    channel_id: &str,
) -> AppResult<Value> {
    if let Some(binding) = state.channel_registry.get(channel_id).await {
        if binding_is_alive(state, &binding).await {
            return Ok(json!({
                "channelType": binding.channel_type,
                "connectionId": binding.connection_id,
                "alreadyOpen": true,
            }));
        }
        state.channel_registry.unregister(channel_id).await;
    }

    let config = load_config(app_handle).map_err(AppError::Protocol)?;
    let channel = config
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| {
            AppError::Protocol(format!("Channel '{}' not found in saved config", channel_id))
        })?;

    match channel.channel_type.as_str() {
        "serial" => {
            let serial_config: SerialConfig = serde_json::from_value(channel.settings.clone())
                .map_err(AppError::Serde)?;
            if serial_config.path.is_empty() {
                return Err(AppError::Serial(format!(
                    "Channel '{}' has no saved serial port path",
                    channel_id
                )));
            }
            let manager = state.serial_manager.lock().await;
            let connection_id = manager.io.open(&serial_config, app_handle.clone()).await?;
            drop(manager);
            let binding = ChannelBinding {
                channel_type: "serial".to_string(),
                connection_id: connection_id.clone(),
                target_addr: None,
            };
            state
                .channel_registry
                .register(channel_id.to_string(), binding)
                .await;
            Ok(json!({ "channelType": "serial", "connectionId": connection_id, "alreadyOpen": false }))
        }
        "tcp" => {
            let settings: TcpChannelSettings = serde_json::from_value(channel.settings.clone())
                .map_err(AppError::Serde)?;
            let mode = if settings.mode.is_empty() { "client" } else { settings.mode.as_str() };
            match mode {
                "client" => {
                    if settings.client_address.is_empty() {
                        return Err(AppError::Tcp(format!(
                            "Channel '{}' has no saved TCP client address",
                            channel_id
                        )));
                    }
                    let manager = state.network_manager.lock().await;
                    let connection_id = manager
                        .tcp_client
                        .connect(&settings.client_address, app_handle.clone())
                        .await?;
                    drop(manager);
                    let binding = ChannelBinding {
                        channel_type: "tcp-client".to_string(),
                        connection_id: connection_id.clone(),
                        target_addr: None,
                    };
                    state
                        .channel_registry
                        .register(channel_id.to_string(), binding)
                        .await;
                    Ok(json!({ "channelType": "tcp-client", "connectionId": connection_id, "alreadyOpen": false }))
                }
                "server" => {
                    if settings.server_address.is_empty() {
                        return Err(AppError::Tcp(format!(
                            "Channel '{}' has no saved TCP server address",
                            channel_id
                        )));
                    }
                    let manager = state.network_manager.lock().await;
                    let bound_addr = manager
                        .tcp_server
                        .start_listening(&settings.server_address, app_handle.clone())
                        .await?;
                    drop(manager);
                    let connection_id = format!("server:{}", bound_addr);
                    let binding = ChannelBinding {
                        channel_type: "tcp-server".to_string(),
                        connection_id: connection_id.clone(),
                        target_addr: None,
                    };
                    state
                        .channel_registry
                        .register(channel_id.to_string(), binding)
                        .await;
                    Ok(json!({ "channelType": "tcp-server", "connectionId": connection_id, "alreadyOpen": false }))
                }
                "udp" => {
                    if settings.udp_bind_address.is_empty() {
                        return Err(AppError::Tcp(format!(
                            "Channel '{}' has no saved UDP bind address",
                            channel_id
                        )));
                    }
                    let manager = state.network_manager.lock().await;
                    let bound_addr = manager
                        .udp
                        .bind(&settings.udp_bind_address, app_handle.clone())
                        .await?;
                    drop(manager);
                    let connection_id = format!("udp:{}", bound_addr);
                    let target_addr = if settings.udp_target_address.is_empty() {
                        None
                    } else {
                        Some(settings.udp_target_address.clone())
                    };
                    let binding = ChannelBinding {
                        channel_type: "udp".to_string(),
                        connection_id: connection_id.clone(),
                        target_addr,
                    };
                    state
                        .channel_registry
                        .register(channel_id.to_string(), binding)
                        .await;
                    Ok(json!({ "channelType": "udp", "connectionId": connection_id, "alreadyOpen": false }))
                }
                other => Err(AppError::Tcp(format!(
                    "Channel '{}' has unknown TCP mode '{}'",
                    channel_id, other
                ))),
            }
        }
        "ble" => {
            let device_id = channel
                .settings
                .get("lastConnectedDeviceId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| {
                    AppError::Ble(format!(
                        "Channel '{}' has no last-connected BLE device to reopen",
                        channel_id
                    ))
                })?;

            crate::commands::ble::connect_ble_device_reliably(
                state,
                app_handle.clone(),
                &device_id,
            )
            .await?;

            let binding = ChannelBinding {
                channel_type: "ble".to_string(),
                connection_id: device_id.clone(),
                target_addr: None,
            };
            state
                .channel_registry
                .register(channel_id.to_string(), binding)
                .await;
            Ok(json!({ "channelType": "ble", "connectionId": device_id, "alreadyOpen": false }))
        }
        other => Err(AppError::Protocol(format!(
            "Channel '{}' has unknown type '{}'",
            channel_id, other
        ))),
    }
}
