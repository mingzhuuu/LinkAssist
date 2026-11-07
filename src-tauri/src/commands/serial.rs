use crate::error::AppError;
use crate::serial::{list_ports, PortInfo, SerialConfig};
use crate::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn list_serial_ports(_state: State<'_, AppState>) -> Result<Vec<PortInfo>, AppError> {
    tokio::task::spawn_blocking(list_ports).await
        .map_err(|error| AppError::Serial(format!("Port enumeration failed: {error}")))
}

#[tauri::command]
pub async fn open_serial_port(
    state: State<'_, AppState>,
    app: AppHandle,
    config: SerialConfig,
) -> Result<String, AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    manager.open(&config, app).await
}

#[tauri::command]
pub async fn close_serial_port(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    manager.close(&connection_id).await
}

#[tauri::command]
pub async fn send_serial_data(
    state: State<'_, AppState>,
    connection_id: String,
    data: Vec<u8>,
) -> Result<usize, AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    manager.send(&connection_id, &data).await
}

#[tauri::command]
pub async fn receive_serial_data(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<u8>, AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    manager.receive(&connection_id, 4096).await
}

#[tauri::command]
pub async fn get_serial_connections(
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    Ok(manager.list_open().await)
}
