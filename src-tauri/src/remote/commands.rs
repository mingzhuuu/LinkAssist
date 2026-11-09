use super::{protocol::Reply, RemoteAccess, Status};
use serde_json::Value;
use tauri::{AppHandle, State, WebviewWindow};

#[tauri::command]
pub async fn remote_list_directory(window: WebviewWindow, path: String) -> Result<Value, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut directory = if path.is_empty() {
            std::path::PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).map_err(|e| e.to_string())?)
        } else { std::path::PathBuf::from(path) };
        if directory.is_file() { directory.pop(); }
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for item in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            if entries.len() >= 5000 { return Err("Folder contains more than 5000 entries; enter a subfolder path".into()); }
            entries.push(serde_json::json!({ "name": item.file_name().to_string_lossy(), "path": item.path().to_string_lossy(), "directory": item.path().is_dir() }));
        }
        entries.sort_by_key(|entry| (entry["directory"].as_bool() != Some(true), entry["name"].as_str().unwrap_or("").to_lowercase()));
        Ok(serde_json::json!({ "path": directory.to_string_lossy(), "parent": directory.parent().map(|p| p.to_string_lossy()), "entries": entries }))
    }).await.map_err(|e| e.to_string())?
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the local main window can manage remote access".into())
    }
}

#[tauri::command]
pub async fn remote_status(
    app: AppHandle,
    state: State<'_, RemoteAccess>,
) -> Result<Status, String> {
    state.load_profiles(&app).await?;
    Ok(state.status().await)
}

#[tauri::command]
pub async fn remote_reconnect(
    app: AppHandle,
    state: State<'_, RemoteAccess>,
    id: String,
) -> Result<(), String> {
    state.reconnect(&app, &id).await
}

#[tauri::command]
pub async fn remote_request_active(
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    id: String,
) -> Result<bool, String> {
    main_only(&window)?;
    Ok(state.request_active(&id).await)
}

#[tauri::command]
pub async fn remote_enable(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    enabled: bool,
) -> Result<(), String> {
    main_only(&window)?;
    state.enable(&app, enabled).await
}
#[tauri::command]
pub async fn remote_invite(
    persistent: Option<bool>,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
) -> Result<String, String> {
    main_only(&window)?;
    state.invite(&app, persistent).await
}
#[tauri::command]
pub async fn remote_approve(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    main_only(&window)?;
    state.approve(&app, request_id, allow).await
}
#[tauri::command]
pub async fn remote_revoke(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    state.revoke(&app, &id).await
}
#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    invitation: String,
) -> Result<(), String> {
    main_only(&window)?;
    state.connect(&app, invitation).await
}
#[tauri::command]
pub async fn remote_disconnect(
    app: AppHandle,
    state: State<'_, RemoteAccess>,
) -> Result<(), String> {
    state.disconnect(&app).await;
    Ok(())
}
#[tauri::command]
pub async fn remote_action(
    state: State<'_, RemoteAccess>,
    action: String,
    args: Value,
) -> Result<Value, String> {
    state.action(action, args).await
}
#[tauri::command]
pub async fn remote_snapshot(state: State<'_, RemoteAccess>) -> Result<Option<Value>, String> {
    Ok(state.client_snapshot().await)
}
#[tauri::command]
pub async fn remote_publish(
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    snapshot: Value,
) -> Result<(), String> {
    main_only(&window)?;
    state.publish(snapshot).await
}
#[tauri::command]
pub async fn remote_respond(
    window: WebviewWindow,
    state: State<'_, RemoteAccess>,
    id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<bool, String> {
    main_only(&window)?;
    Ok(state.respond(id, Reply { value, error }).await)
}

#[tauri::command]
pub async fn remote_set_no_approval(app: AppHandle, window: WebviewWindow, state: State<'_, RemoteAccess>, enabled: bool) -> Result<(), String> {
    main_only(&window)?;
    state.set_no_approval(&app, enabled).await
}
