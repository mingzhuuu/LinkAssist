use crate::persistence::{load_config as do_load, save_config as do_save, AppConfig};
use tokio::io::AsyncWriteExt;

#[tauri::command]
pub async fn save_app_config(
    app_handle: tauri::AppHandle,
    config: AppConfig,
) -> Result<(), String> {
    do_save(&app_handle, &config)
}

#[tauri::command]
pub async fn load_app_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    do_load(&app_handle)
}

#[tauri::command]
pub async fn export_to_file(path: String, content: String) -> Result<(), String> {
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
pub async fn append_to_file(path: String, content: String) -> Result<(), String> {
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("Failed to open file for append: {}", e))?;
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Failed to append file: {}", e))
}

#[tauri::command]
pub async fn import_from_file(path: String) -> Result<String, String> {
    let path = crate::snapshot::resolve_path(&path);
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub async fn get_executable_directory() -> Result<String, String> {
    let executable = std::env::current_exe()
        .map_err(|e| format!("Failed to locate the LinkAssist executable: {e}"))?;
    executable
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| "The LinkAssist executable has no parent directory".to_string())
}
