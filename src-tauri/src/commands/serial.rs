use crate::error::AppError;
use crate::serial::{list_ports, PortInfo, SerialConfig};
use crate::AppState;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn start_serial_monitor(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
    channel_id: String,
    capture: crate::serial::monitor::UsbCaptureConfig,
    manual: Option<bool>,
    usbpcap_directory: Option<String>,
    request_elevation: Option<bool>,
) -> Result<Option<String>, String> {
    let manager = state.serial_manager.lock().await.monitor.clone();
    tokio::task::spawn_blocking(move || {
        let capture = manual.unwrap_or(false).then_some(capture);
        let result = manager.start(
            path,
            channel_id,
            capture,
            app,
            usbpcap_directory.as_deref(),
            request_elevation.unwrap_or(false),
        );
        #[cfg(windows)]
        if matches!(&result, Err(error) if error == crate::serial::monitor_elevation::CANCELLED) {
            return Ok(None);
        }
        result.map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn inspect_serial_monitor(
    path: String,
    usbpcap_directory: Option<String>,
) -> Result<crate::serial::usb_discovery::MonitorDiscovery, AppError> {
    tokio::task::spawn_blocking(move || {
        crate::serial::usb_discovery::inspect(&path, usbpcap_directory.as_deref())
    })
    .await
    .map_err(|e| AppError::Serial(format!("USB discovery failed: {e}")))
}

#[tauri::command]
pub async fn check_usbpcap(usbpcap_directory: Option<String>) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        crate::serial::usb_discovery::check_setup(usbpcap_directory.as_deref())
            .map_err(AppError::Serial)
    })
    .await
    .map_err(|e| AppError::Serial(e.to_string()))?
}

#[tauri::command]
pub async fn open_usbpcap_install_guide() -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("https://desowin.org/usbpcap/")
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| AppError::Serial(format!("Could not open USBPcap website: {e}")))?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err(AppError::Serial(
        "USBPcap monitoring requires Windows.".into(),
    ))
}

#[tauri::command]
pub async fn stop_serial_monitor(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    let manager = state.serial_manager.lock().await.monitor.clone();
    tokio::task::spawn_blocking(move || manager.stop(&connection_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_serial_ports(_state: State<'_, AppState>) -> Result<Vec<PortInfo>, AppError> {
    tokio::task::spawn_blocking(list_ports)
        .await
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
    if connection_id.starts_with("monitor:") {
        let manager = state.serial_manager.lock().await.monitor.clone();
        return tokio::task::spawn_blocking(move || manager.stop(&connection_id))
            .await
            .map_err(|e| AppError::Serial(e.to_string()))?
            .map_err(AppError::Serial);
    }
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
pub async fn get_serial_connections(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let manager = state.serial_manager.lock().await.io.clone();
    Ok(manager.list_open().await)
}
