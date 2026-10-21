use crate::error::AppError;
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub addr: String,
}

#[tauri::command]
pub async fn tcp_connect(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    addr: String,
) -> Result<String, AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_client.connect(&addr, app_handle).await
}

#[tauri::command]
pub async fn tcp_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_client.disconnect(&connection_id).await
}

#[tauri::command]
pub async fn tcp_send(
    state: State<'_, AppState>,
    connection_id: String,
    data: Vec<u8>,
) -> Result<usize, AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_client.send(&connection_id, &data).await
}

#[tauri::command]
pub async fn tcp_receive(
    state: State<'_, AppState>,
    _connection_id: String,
) -> Result<Vec<u8>, AppError> {
    // Data is now pushed via events; kept for backward compatibility
    let _manager = state.network_manager.lock().await;
    Ok(Vec::new())
}

#[tauri::command]
pub async fn tcp_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfo>, AppError> {
    let manager = state.network_manager.lock().await;
    let list = manager.tcp_client.list_connections().await;
    Ok(list
        .into_iter()
        .map(|(id, addr)| ConnectionInfo { id, addr })
        .collect())
}

#[tauri::command]
pub async fn tcp_server_start(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    addr: String,
) -> Result<String, AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_server.start_listening(&addr, app_handle).await
}

#[tauri::command]
pub async fn tcp_server_stop(
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<(), AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_server.stop_listening(&app_handle).await
}

#[tauri::command]
pub async fn tcp_server_accept(
    _state: State<'_, AppState>,
    _app_handle: AppHandle,
) -> Result<String, AppError> {
    Err(AppError::Tcp(
        "Auto-accept is enabled. Clients are accepted automatically when server starts."
            .to_string(),
    ))
}

#[tauri::command]
pub async fn tcp_server_send(
    state: State<'_, AppState>,
    client_id: String,
    data: Vec<u8>,
) -> Result<usize, AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_server.send_to_client(&client_id, &data).await
}

#[tauri::command]
pub async fn tcp_server_receive(
    state: State<'_, AppState>,
    _client_id: String,
) -> Result<Vec<u8>, AppError> {
    // Data is now pushed via events; kept for backward compatibility
    let _manager = state.network_manager.lock().await;
    Ok(Vec::new())
}

#[tauri::command]
pub async fn tcp_server_disconnect_client(
    state: State<'_, AppState>,
    client_id: String,
) -> Result<(), AppError> {
    let manager = state.network_manager.lock().await;
    manager.tcp_server.disconnect_client(&client_id).await
}

#[tauri::command]
pub async fn tcp_server_list_clients(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionInfo>, AppError> {
    let manager = state.network_manager.lock().await;
    let list = manager.tcp_server.list_clients().await;
    Ok(list
        .into_iter()
        .map(|(id, addr)| ConnectionInfo { id, addr })
        .collect())
}

#[tauri::command]
pub async fn udp_bind(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    addr: String,
) -> Result<String, AppError> {
    let manager = state.network_manager.lock().await;
    manager.udp.bind(&addr, app_handle).await
}

#[tauri::command]
pub async fn udp_unbind(state: State<'_, AppState>) -> Result<(), AppError> {
    let manager = state.network_manager.lock().await;
    manager.udp.unbind().await
}

#[tauri::command]
pub async fn udp_send(
    state: State<'_, AppState>,
    addr: String,
    data: Vec<u8>,
) -> Result<usize, AppError> {
    let manager = state.network_manager.lock().await;
    manager.udp.send_to(&addr, &data).await
}

#[tauri::command]
pub async fn udp_receive(
    state: State<'_, AppState>,
) -> Result<UdpReceiveResult, AppError> {
    // Data is now pushed via events; kept for backward compatibility
    let _manager = state.network_manager.lock().await;
    Ok(UdpReceiveResult { data: Vec::new(), addr: String::new() })
}

#[derive(Serialize)]
pub struct UdpReceiveResult {
    pub data: Vec<u8>,
    pub addr: String,
}
