use crate::ble::gatt::GattService;
use crate::ble::pairing::BlePairingStatus;
use crate::ble::scanner::BleDevice;
use crate::ble::{BleManager, NotificationConsumer};
use crate::error::AppError;
use crate::recent_events::{current_timestamp_ms, RecentEventBuffer};
use crate::AppState;
use btleplug::api::{Central as _, CentralEvent, ConnectionParameters, Peripheral as _, WriteType};
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time::{interval, Duration};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleNotificationEvent {
    pub device_id: String,
    pub service_uuid: String,
    pub char_uuid: String,
    pub data: Vec<u8>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleConnectionClosedEvent {
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BleConnectionParameters {
    pub interval_us: u32,
    pub latency: u16,
    pub supervision_timeout_us: u32,
}

impl From<ConnectionParameters> for BleConnectionParameters {
    fn from(parameters: ConnectionParameters) -> Self {
        Self {
            interval_us: parameters.interval_us,
            latency: parameters.latency,
            supervision_timeout_us: parameters.supervision_timeout_us,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BleConnectionInfo {
    pub device_id: String,
    pub is_connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_parameters: Option<BleConnectionParameters>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleSubscriptionReady {
    pub ready: bool,
    pub cursor: u64,
    pub current_cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription_id: Option<String>,
}

pub async fn acquire_ble_exclusive_lease(state: &AppState) -> OwnedMutexGuard<()> {
    let gate = state.ble_manager.lock().await.connect_gate.clone();
    gate.lock_owned().await
}

async fn publish_ble_connection_closed(
    ble_manager: &Arc<Mutex<BleManager>>,
    recent_events: &RecentEventBuffer,
    app_handle: &AppHandle,
    device_id: &str,
) -> bool {
    if !ble_manager.lock().await.claim_connection_closed(device_id) {
        return false;
    }

    // The pump/monitor that detected the close may be aborted by explicit
    // disconnect immediately after claiming this lifecycle. Detach the actual
    // publication before the next cancellation point so a claimed close can
    // never disappear without waking cursor waiters.
    let publisher_events = recent_events.clone();
    let publisher_app = app_handle.clone();
    let publisher_device_id = device_id.to_string();
    let publisher = tokio::spawn(async move {
        let timestamp = current_timestamp_ms();
        let event = BleConnectionClosedEvent {
            device_id: publisher_device_id,
        };
        publisher_events
            .push_serializable("ble-connection-closed", timestamp, event.clone())
            .await;
        let _ = publisher_app.emit("ble-connection-closed", event);
    });
    let _ = publisher.await;
    true
}

fn ble_operation_error(
    stage: &str,
    retryable: bool,
    device_id: &str,
    scan_active: bool,
    cause: impl ToString,
) -> AppError {
    AppError::Ble(
        json!({
            "code": "ble_operation_failed",
            "stage": stage,
            "retryable": retryable,
            "deviceId": device_id,
            "scanActive": scan_active,
            "cause": cause.to_string(),
        })
        .to_string(),
    )
}

/// Poll the connection every 2s and emit `ble-connection-closed` when the
/// device silently drops. Adapter disconnect events remove the polling delay
/// once the OS reports link loss; polling remains as a platform-safe fallback.
/// Shared by the Tauri command and the MCP tool path.
pub fn spawn_ble_connection_monitor(
    ble_manager: Arc<Mutex<BleManager>>,
    recent_events: RecentEventBuffer,
    app_handle: AppHandle,
    device_id: String,
    mut central_events: Option<Pin<Box<dyn Stream<Item = CentralEvent> + Send>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(2));
        loop {
            enum MonitorSignal {
                Poll,
                CentralEvent(Option<CentralEvent>),
            }

            let signal = if let Some(events) = central_events.as_mut() {
                tokio::select! {
                    _ = ticker.tick() => MonitorSignal::Poll,
                    event = events.next() => MonitorSignal::CentralEvent(event),
                }
            } else {
                ticker.tick().await;
                MonitorSignal::Poll
            };

            let disconnected = match signal {
                MonitorSignal::Poll => {
                    let manager = ble_manager.lock().await;
                    let still_connected = manager.connections.is_connected(&device_id).await;
                    drop(manager);
                    !still_connected
                }
                MonitorSignal::CentralEvent(Some(CentralEvent::DeviceDisconnected(id))) => {
                    id.to_string() == device_id
                }
                MonitorSignal::CentralEvent(Some(_)) => false,
                MonitorSignal::CentralEvent(None) => {
                    log::warn!(
                        "BLE adapter event stream ended for {}; falling back to polling",
                        device_id
                    );
                    central_events = None;
                    false
                }
            };

            if !disconnected {
                continue;
            }

            publish_ble_connection_closed(&ble_manager, &recent_events, &app_handle, &device_id)
                .await;
            let mut manager = ble_manager.lock().await;
            // Remove our own handle first: cleanup_device_tasks aborts the
            // monitor entry, and aborting ourselves would cancel the
            // disconnect below at its next await point.
            manager.monitor_tasks.remove(&device_id);
            manager.cleanup_device_tasks(&device_id);
            let _ = manager.connections.disconnect(&device_id).await;
            break;
        }
    })
}

async fn install_ble_connection_monitor(state: &AppState, app_handle: AppHandle, device_id: &str) {
    let adapter = {
        let mut manager = state.ble_manager.lock().await;
        if let Some(old_task) = manager.monitor_tasks.remove(device_id) {
            old_task.abort();
        }
        manager.mark_connection_open(device_id);
        manager
            .scanner
            .get_adapter()
            .await
            .map(|adapter| adapter.clone())
    };
    let central_events = match adapter {
        Ok(adapter) => match adapter.events().await {
            Ok(events) => Some(events),
            Err(error) => {
                log::warn!(
                    "Failed to subscribe to BLE adapter events for {}: {}; using polling fallback",
                    device_id,
                    error
                );
                None
            }
        },
        Err(error) => {
            log::warn!(
                "BLE adapter unavailable while monitoring {}: {}; using polling fallback",
                device_id,
                error
            );
            None
        }
    };
    let mut manager = state.ble_manager.lock().await;
    let task = spawn_ble_connection_monitor(
        state.ble_manager.clone(),
        state.recent_events.clone(),
        app_handle,
        device_id.to_string(),
        central_events,
    );
    manager.monitor_tasks.insert(device_id.to_string(), task);
}

async fn read_ble_connection_info(
    connections: &crate::ble::BleConnectionManager,
    device_id: &str,
) -> BleConnectionInfo {
    let is_connected = connections.is_connected(device_id).await;
    let connection_parameters = match connections.get_peripheral(device_id).await {
        Ok(peripheral) => match peripheral.connection_parameters().await {
            Ok(Some(parameters)) => {
                log::info!(
                    "BLE connection parameters for {}: interval={}us, latency={}, supervision_timeout={}us",
                    device_id,
                    parameters.interval_us,
                    parameters.latency,
                    parameters.supervision_timeout_us
                );
                Some(parameters.into())
            }
            Ok(None) => {
                log::debug!(
                    "BLE connection parameters are unavailable for {} on this platform",
                    device_id
                );
                None
            }
            Err(btleplug::Error::NotSupported(_)) => {
                log::debug!(
                    "BLE connection parameters are unsupported for {} on this platform",
                    device_id
                );
                None
            }
            Err(error) => {
                log::warn!(
                    "Failed to read BLE connection parameters for {}: {}",
                    device_id,
                    error
                );
                None
            }
        },
        Err(error) => {
            log::warn!(
                "BLE connection disappeared before parameters were read for {}: {}",
                device_id,
                error
            );
            None
        }
    };

    BleConnectionInfo {
        device_id: device_id.to_string(),
        is_connected,
        connection_parameters,
    }
}

async fn read_verified_ble_connection_info(
    connections: &crate::ble::BleConnectionManager,
    device_id: &str,
) -> Result<BleConnectionInfo, AppError> {
    let info = read_ble_connection_info(connections, device_id).await;
    if info.is_connected {
        Ok(info)
    } else {
        Err(ble_operation_error(
            "connectAndVerify",
            true,
            device_id,
            false,
            "device disconnected before connection setup completed",
        ))
    }
}

async fn pause_ble_scan_for_connect(
    state: &AppState,
    device_id: &str,
    scan_was_active: bool,
) -> Result<(), AppError> {
    let pause_error = state
        .ble_manager
        .lock()
        .await
        .scanner
        .stop_scan()
        .await
        .err();
    let remained_active = state.ble_manager.lock().await.scanner.is_scanning().await;
    if pause_error.is_some() || remained_active {
        if scan_was_active {
            let _ = state.ble_manager.lock().await.scanner.start_scan().await;
        }
        let scan_active = state.ble_manager.lock().await.scanner.is_scanning().await;
        let cause = pause_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "scanner remained active after stop_scan".to_string());
        return Err(ble_operation_error(
            "pauseScan",
            true,
            device_id,
            scan_active,
            cause,
        ));
    }
    Ok(())
}

/// Shared UI/MCP connection flow. It resolves the target while scanning is
/// still available, pauses scanning before connect, retries once, and verifies
/// the OS connection state before reporting success.
pub async fn connect_ble_device_reliably(
    state: &AppState,
    app_handle: AppHandle,
    device_id: &str,
) -> Result<BleConnectionInfo, AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    let (connections, scan_was_active, already_connected) = {
        let mut manager = state.ble_manager.lock().await;
        let connections = manager.connections.clone();
        let scan_was_active = manager.scanner.is_scanning().await;
        let already_connected = connections.is_connected(device_id).await;
        if !already_connected {
            manager.cleanup_device_tasks(device_id);
        }
        (connections, scan_was_active, already_connected)
    };

    if already_connected {
        pause_ble_scan_for_connect(state, device_id, scan_was_active).await?;
        install_ble_connection_monitor(state, app_handle, device_id).await;
        return read_verified_ble_connection_info(&connections, device_id).await;
    }

    let peripheral = crate::ble::find_peripheral_for_connect(&state.ble_manager, device_id)
        .await
        .map_err(|error| {
            ble_operation_error("resolvePeripheral", true, device_id, scan_was_active, error)
        })?;

    pause_ble_scan_for_connect(state, device_id, scan_was_active).await?;

    let mut last_error = "connection verification failed".to_string();
    for attempt in 1..=2 {
        match connections.connect(peripheral.clone()).await {
            Ok(()) if connections.is_connected(device_id).await => {
                install_ble_connection_monitor(state, app_handle, device_id).await;
                return read_verified_ble_connection_info(&connections, device_id).await;
            }
            Ok(()) => {
                last_error = format!(
                    "connection verification returned false on attempt {}",
                    attempt
                );
                let _ = connections.disconnect(device_id).await;
            }
            Err(error) => {
                last_error = format!("connect attempt {} failed: {}", attempt, error);
            }
        }

        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    if scan_was_active {
        if let Err(error) = state.ble_manager.lock().await.scanner.start_scan().await {
            last_error = format!("{}; failed to restore scan: {}", last_error, error);
        }
    }
    let scan_active = state.ble_manager.lock().await.scanner.is_scanning().await;

    Err(ble_operation_error(
        "connectAndVerify",
        true,
        device_id,
        scan_active,
        last_error,
    ))
}

pub async fn disconnect_ble_device_reliably(
    state: &AppState,
    app_handle: AppHandle,
    device_id: &str,
) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    let connections = {
        let mut manager = state.ble_manager.lock().await;
        // Abort both event producers before disconnect so the explicit close
        // path is the only publisher. This also releases all subscription ids.
        manager.cleanup_device_tasks(device_id);
        manager.connections.clone()
    };

    // `BleConnectionManager::disconnect` removes the host-side connection
    // before awaiting the OS disconnect. Even if that OS call fails, this
    // lifecycle is closed from the Core's perspective and waiters must wake.
    let disconnect_result = connections.disconnect(device_id).await;
    state
        .channel_registry
        .unregister_connection(device_id)
        .await;
    publish_ble_connection_closed(
        &state.ble_manager,
        &state.recent_events,
        &app_handle,
        device_id,
    )
    .await;
    disconnect_result
}

async fn ensure_notification_pump_locked(
    state: &AppState,
    app_handle: AppHandle,
    device_id: &str,
    manager: &mut BleManager,
) -> Result<(), AppError> {
    if manager
        .notification_tasks
        .get(device_id)
        .is_some_and(|task| !task.is_finished())
    {
        return Ok(());
    }
    if let Some(finished) = manager.notification_tasks.remove(device_id) {
        finished.abort();
    }

    let peripheral = manager.connections.get_peripheral(device_id).await?;
    let mut stream = peripheral
        .notifications()
        .await
        .map_err(|error| ble_operation_error("notificationPump", true, device_id, false, error))?;
    let notif_device_id = device_id.to_string();
    let notif_app = app_handle;
    let recent_events = state.recent_events.clone();
    let pump_peripheral = peripheral.clone();
    let pump_manager = state.ble_manager.clone();

    let task = tokio::spawn(async move {
        while let Some(notification) = stream.next().await {
            let service_uuids = pump_peripheral
                .services()
                .into_iter()
                .filter(|service| {
                    service
                        .characteristics
                        .iter()
                        .any(|characteristic| characteristic.uuid == notification.uuid)
                })
                .map(|service| service.uuid.to_string())
                .collect::<Vec<_>>();
            let service_uuids = if service_uuids.is_empty() {
                vec![String::new()]
            } else {
                service_uuids
            };

            for service_uuid in service_uuids {
                let timestamp = current_timestamp_ms();
                let event = BleNotificationEvent {
                    device_id: notif_device_id.clone(),
                    service_uuid,
                    char_uuid: notification.uuid.to_string(),
                    data: notification.value.clone(),
                    timestamp,
                };
                recent_events
                    .push_serializable("ble-notification-received", timestamp, event.clone())
                    .await;
                let _ = notif_app.emit("ble-notification-received", event);
            }
        }

        publish_ble_connection_closed(&pump_manager, &recent_events, &notif_app, &notif_device_id)
            .await;
    });
    manager
        .notification_tasks
        .insert(device_id.to_string(), task);
    Ok(())
}

pub async fn subscribe_ble_notification_consumer(
    state: &AppState,
    app_handle: AppHandle,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
    consumer: NotificationConsumer,
) -> Result<BleSubscriptionReady, AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    let subscription_id = match &consumer {
        NotificationConsumer::Ui => None,
        NotificationConsumer::Mcp(subscription_id) => Some(subscription_id.clone()),
    };

    // Keep the manager lock from pump creation until the first physical subscription
    // completes. Otherwise a concurrent second holder could observe the
    // pending registry entry and report ready before notifications are active.
    let mut manager = state.ble_manager.lock().await;
    ensure_notification_pump_locked(state, app_handle, device_id, &mut manager).await?;
    let peripheral = manager.connections.get_peripheral(device_id).await?;
    let needs_physical_subscribe =
        manager.add_notification_consumer(device_id, service_uuid, char_uuid, consumer.clone());
    if needs_physical_subscribe {
        if let Err(error) = crate::ble::gatt::subscribe_notifications(
            &peripheral,
            device_id,
            service_uuid,
            char_uuid,
        )
        .await
        {
            manager.remove_notification_consumer(
                device_id,
                service_uuid,
                char_uuid,
                consumer.clone(),
            );
            if !manager.device_has_notification_consumers(device_id) {
                if let Some(task) = manager.notification_tasks.remove(device_id) {
                    task.abort();
                }
            }
            return Err(ble_operation_error(
                "subscribe",
                true,
                device_id,
                false,
                error,
            ));
        }
    }
    drop(manager);

    let cursor = state.recent_events.checkpoint().await;
    Ok(BleSubscriptionReady {
        ready: true,
        cursor,
        current_cursor: cursor,
        subscription_id,
    })
}

async fn unsubscribe_ble_notification_consumer_inner(
    state: &AppState,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
    consumer: NotificationConsumer,
) -> Result<(), AppError> {
    // Serialize holder removal and the final physical unsubscribe for the same
    // reason as subscribe: another holder must not race through the gap.
    let mut manager = state.ble_manager.lock().await;
    let peripheral = manager.connections.get_peripheral(device_id).await?;
    let needs_physical_unsubscribe =
        manager.remove_notification_consumer(device_id, service_uuid, char_uuid, consumer.clone());
    if needs_physical_unsubscribe {
        if let Err(error) =
            crate::ble::gatt::unsubscribe_notifications(&peripheral, service_uuid, char_uuid).await
        {
            manager.add_notification_consumer(device_id, service_uuid, char_uuid, consumer.clone());
            return Err(ble_operation_error(
                "unsubscribe",
                true,
                device_id,
                false,
                error,
            ));
        }

        if !manager.device_has_notification_consumers(device_id) {
            if let Some(task) = manager.notification_tasks.remove(device_id) {
                task.abort();
            }
        }
    }

    Ok(())
}

pub async fn unsubscribe_ble_notification_consumer(
    state: &AppState,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
    consumer: NotificationConsumer,
) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    unsubscribe_ble_notification_consumer_inner(state, device_id, service_uuid, char_uuid, consumer)
        .await
}

pub async fn unsubscribe_ble_notification_subscription(
    state: &AppState,
    subscription_id: &str,
) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    let endpoint = state
        .ble_manager
        .lock()
        .await
        .notification_endpoint_for_subscription(subscription_id);
    let Some(endpoint) = endpoint else {
        // Disconnect cleanup may have already released this token.
        return Ok(());
    };
    unsubscribe_ble_notification_consumer_inner(
        state,
        &endpoint.0,
        &endpoint.1,
        &endpoint.2,
        NotificationConsumer::Mcp(subscription_id.to_string()),
    )
    .await
}

pub async fn unsubscribe_ble_notification_mcp_endpoint(
    state: &AppState,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(state).await;
    let mut manager = state.ble_manager.lock().await;
    let peripheral = manager.connections.get_peripheral(device_id).await?;
    let (removed_ids, needs_physical_unsubscribe) =
        manager.take_mcp_notification_consumers(device_id, service_uuid, char_uuid);
    if removed_ids.is_empty() {
        return Ok(());
    }

    if needs_physical_unsubscribe {
        if let Err(error) =
            crate::ble::gatt::unsubscribe_notifications(&peripheral, service_uuid, char_uuid).await
        {
            for subscription_id in removed_ids {
                manager.add_notification_consumer(
                    device_id,
                    service_uuid,
                    char_uuid,
                    NotificationConsumer::Mcp(subscription_id),
                );
            }
            return Err(ble_operation_error(
                "unsubscribe",
                true,
                device_id,
                false,
                error,
            ));
        }

        if !manager.device_has_notification_consumers(device_id) {
            if let Some(task) = manager.notification_tasks.remove(device_id) {
                task.abort();
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_ble_scan(state: State<'_, AppState>) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(&state).await;
    let mut manager = state.ble_manager.lock().await;
    manager.scanner.start_scan().await
}

#[tauri::command]
pub async fn stop_ble_scan(state: State<'_, AppState>) -> Result<(), AppError> {
    let _exclusive_lease = acquire_ble_exclusive_lease(&state).await;
    let mut manager = state.ble_manager.lock().await;
    manager.scanner.stop_scan().await
}

#[tauri::command]
pub async fn get_ble_devices(state: State<'_, AppState>) -> Result<Vec<BleDevice>, AppError> {
    let mut manager = state.ble_manager.lock().await;
    manager.scanner.refresh_devices().await
}

#[tauri::command]
pub async fn get_ble_pairing_statuses(
    device_ids: Vec<String>,
) -> Result<Vec<BlePairingStatus>, AppError> {
    let mut statuses = Vec::with_capacity(device_ids.len());
    for device_id in device_ids {
        statuses.push(crate::ble::pairing::get_pairing_status(&device_id).await);
    }
    Ok(statuses)
}

#[tauri::command]
pub async fn connect_ble_device(
    state: State<'_, AppState>,
    app: AppHandle,
    device_id: String,
) -> Result<BleConnectionInfo, AppError> {
    connect_ble_device_reliably(&state, app, &device_id).await
}

#[tauri::command]
pub async fn disconnect_ble_device(
    state: State<'_, AppState>,
    app: AppHandle,
    device_id: String,
) -> Result<(), AppError> {
    disconnect_ble_device_reliably(&state, app, &device_id).await
}

#[tauri::command]
pub async fn get_gatt_services(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Vec<GattService>, AppError> {
    let manager = state.ble_manager.lock().await;
    let peripheral = manager.connections.get_peripheral(&device_id).await?;
    drop(manager);
    crate::ble::gatt::discover_services(&peripheral).await
}

#[tauri::command]
pub async fn read_ble_characteristic(
    state: State<'_, AppState>,
    device_id: String,
    service_uuid: String,
    char_uuid: String,
) -> Result<Vec<u8>, AppError> {
    let manager = state.ble_manager.lock().await;
    let peripheral = manager.connections.get_peripheral(&device_id).await?;
    drop(manager);
    crate::ble::gatt::read_characteristic(&peripheral, &device_id, &service_uuid, &char_uuid).await
}

#[tauri::command]
pub async fn write_ble_characteristic(
    state: State<'_, AppState>,
    device_id: String,
    service_uuid: String,
    char_uuid: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    let manager = state.ble_manager.lock().await;
    let peripheral = manager.connections.get_peripheral(&device_id).await?;
    drop(manager);
    crate::ble::gatt::write_characteristic(
        &peripheral,
        &service_uuid,
        &char_uuid,
        &data,
        WriteType::WithResponse,
    )
    .await
}

#[tauri::command]
pub async fn subscribe_ble_notifications(
    state: State<'_, AppState>,
    app: AppHandle,
    device_id: String,
    service_uuid: String,
    char_uuid: String,
) -> Result<BleSubscriptionReady, AppError> {
    subscribe_ble_notification_consumer(
        &state,
        app,
        &device_id,
        &service_uuid,
        &char_uuid,
        NotificationConsumer::Ui,
    )
    .await
}

#[tauri::command]
pub async fn unsubscribe_ble_notifications(
    state: State<'_, AppState>,
    device_id: String,
    service_uuid: String,
    char_uuid: String,
) -> Result<(), AppError> {
    unsubscribe_ble_notification_consumer(
        &state,
        &device_id,
        &service_uuid,
        &char_uuid,
        NotificationConsumer::Ui,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_info_uses_frontend_field_names() {
        let info = BleConnectionInfo {
            device_id: "device-1".to_string(),
            is_connected: true,
            connection_parameters: Some(BleConnectionParameters {
                interval_us: 30_000,
                latency: 0,
                supervision_timeout_us: 2_000_000,
            }),
        };

        let value = serde_json::to_value(info).expect("connection info should serialize");
        assert_eq!(value["deviceId"], "device-1");
        assert_eq!(value["isConnected"], true);
        assert_eq!(value["connectionParameters"]["intervalUs"], 30_000);
        assert_eq!(value["connectionParameters"]["latency"], 0);
        assert_eq!(
            value["connectionParameters"]["supervisionTimeoutUs"],
            2_000_000
        );
    }

    #[test]
    fn structured_ble_error_includes_stage_and_retry_context() {
        let message =
            ble_operation_error("connectAndVerify", true, "device-1", false, "failed").to_string();
        assert!(message.contains("\"stage\":\"connectAndVerify\""));
        assert!(message.contains("\"retryable\":true"));
        assert!(message.contains("\"deviceId\":\"device-1\""));
        assert!(message.contains("\"scanActive\":false"));
    }
}
