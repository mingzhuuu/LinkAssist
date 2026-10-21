use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

const APP_IDENTIFIER: &str = "com.linkassist.desktop";

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AppConfig {
    pub channels: Vec<ChannelConfig>,
    pub ui: UiConfig,
    pub protocol: ProtocolConfig,
    #[serde(default)]
    pub canvases: Option<serde_json::Value>,
    #[serde(default)]
    pub saved_commands: Option<serde_json::Value>,
    #[serde(default)]
    pub mcp_tools: Option<serde_json::Value>,
    #[serde(default)]
    pub ble_uuid_names: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ChannelConfig {
    pub id: String,
    pub name: String,
    pub channel_type: String, // "ble" | "serial" | "tcp"
    #[serde(default)]
    pub settings: serde_json::Value, // channel-specific settings
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UiConfig {
    pub left_panel_width: f64,
    pub right_panel_width: f64,
    #[serde(default)]
    pub center_panel_width: Option<f64>,
    #[serde(default = "default_center_split")]
    pub center_split_ratio: f64,
    #[serde(default = "default_center_top_visible")]
    pub center_top_visible: bool,
    #[serde(default = "default_center_bottom_visible")]
    pub center_bottom_visible: bool,
    #[serde(default = "default_right_panel_visible")]
    pub right_panel_visible: bool,
    #[serde(default)]
    pub simple_mode: bool,
    #[serde(default)]
    pub active_channel_id: Option<String>,
    pub data_view_mode: String,
    #[serde(default = "default_theme")]
    pub theme_mode: String,
    #[serde(default = "default_send_format")]
    pub send_format: String,
    #[serde(default = "default_receive_format")]
    pub receive_format: String,
    #[serde(default = "default_channel_panel_visible")]
    pub channel_panel_visible: bool,
    #[serde(default)]
    pub show_input_prefix: bool,
    #[serde(default)]
    pub show_timestamp: bool,
    #[serde(default)]
    pub show_received: bool,
    #[serde(default)]
    pub terminal_channel_settings: Option<serde_json::Value>,
    #[serde(default)]
    pub window_state: Option<WindowState>,
    #[serde(default)]
    pub terminal_layout: Option<serde_json::Value>,
    #[serde(default = "default_restore_canvas_layout")]
    pub restore_canvas_layout: bool,
    #[serde(default)]
    pub channel_quick_open_selected_ids: Vec<String>,
    #[serde(default)]
    pub file_dialog_dirs: FileDialogDirs,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct FileDialogDirs {
    #[serde(default)]
    pub layout: String,
    #[serde(default)]
    pub mcp: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub script: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

fn default_center_split() -> f64 {
    0.5
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_send_format() -> String {
    "ascii".to_string()
}

fn default_receive_format() -> String {
    "hex".to_string()
}

fn default_channel_panel_visible() -> bool {
    true
}

fn default_center_top_visible() -> bool {
    true
}

fn default_center_bottom_visible() -> bool {
    true
}

fn default_right_panel_visible() -> bool {
    true
}

fn default_restore_canvas_layout() -> bool {
    true
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            left_panel_width: 40.0,
            right_panel_width: 360.0,
            center_panel_width: Some(560.0),
            center_split_ratio: 0.5,
            center_top_visible: true,
            center_bottom_visible: true,
            right_panel_visible: true,
            simple_mode: false,
            active_channel_id: None,
            data_view_mode: "text".to_string(),
            theme_mode: "dark".to_string(),
            send_format: "ascii".to_string(),
            receive_format: "hex".to_string(),
            channel_panel_visible: true,
            show_input_prefix: false,
            show_timestamp: false,
            show_received: true,
            terminal_channel_settings: None,
            window_state: None,
            terminal_layout: None,
            restore_canvas_layout: true,
            channel_quick_open_selected_ids: Vec::new(),
            file_dialog_dirs: FileDialogDirs::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProtocolConfig {
    pub mode: String,
    pub field_definitions: serde_json::Value,
    pub lua_script: String,
    #[serde(default)]
    pub linked_channel_id: Option<String>,
    #[serde(default)]
    pub linked_service_uuid: Option<String>,
    #[serde(default)]
    pub linked_char_uuid: Option<String>,
}

impl Default for ProtocolConfig {
    fn default() -> Self {
        Self {
            mode: "Passthrough".to_string(),
            field_definitions: serde_json::Value::Array(vec![]),
            lua_script: String::new(),
            linked_channel_id: None,
            linked_service_uuid: None,
            linked_char_uuid: None,
        }
    }
}

fn config_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = crate::snapshot::runtime_config_path()? {
        return Ok(path);
    }
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    fs::create_dir_all(&app_dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(app_dir.join("config.json"))
}

pub fn save_config(app_handle: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app_handle)?;
    save_config_to_path(&path, config)
}

fn save_config_to_path(path: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    let json =
        serde_json::to_string_pretty(config).map_err(|e| format!("Serialize error: {}", e))?;
    // Each writer owns a sibling temporary file. Concurrent UI/MCP saves must
    // not truncate or rename another writer's in-progress snapshot.
    let tmp_path = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
        .map_err(|e| format!("Create temporary config error: {}", e))?;
    let result = (|| {
        file.write_all(json.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        file.sync_all().map_err(|e| format!("Sync error: {}", e))?;
        Ok(())
    })();
    // Close before replacement, including on Windows.
    drop(file);
    let result = result
        .and_then(|()| fs::rename(&tmp_path, path).map_err(|e| format!("Rename error: {}", e)));
    if result.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    result
}

pub fn load_config(app_handle: &tauri::AppHandle) -> Result<AppConfig, String> {
    let path = config_path(app_handle)?;
    load_config_from_path(&path)
}

pub fn load_config_for_bridge() -> Result<AppConfig, String> {
    let path = crate::snapshot::runtime_config_path()?.unwrap_or_else(standalone_config_path);
    load_config_from_path(&path)
}

pub fn load_config_for_snapshot() -> Result<AppConfig, String> {
    let path = crate::snapshot::runtime_config_path()?.unwrap_or_else(standalone_config_path);
    // Frontend persistence is debounced by 300 ms. Waiting beyond that boundary
    // captures edits made immediately before the CLI command without stopping the
    // running UI or taking ownership of its Core lock.
    std::thread::sleep(Duration::from_millis(400));
    load_stable_snapshot_config(&path, 10, Duration::from_millis(40))
}

fn load_stable_snapshot_config(
    path: &std::path::Path,
    attempts: usize,
    interval: Duration,
) -> Result<AppConfig, String> {
    for attempt in 0..attempts {
        let first = read_optional_config_bytes(path)?;
        std::thread::sleep(interval);
        let second = read_optional_config_bytes(path)?;
        if first == second {
            return match second {
                Some(json) => serde_json::from_slice(&json).map_err(|error| {
                    format!(
                        "Snapshot configuration '{}' is not valid JSON: {error}",
                        path.display()
                    )
                }),
                None => Ok(AppConfig::default()),
            };
        }
        if attempt + 1 == attempts {
            break;
        }
    }
    Err(format!(
        "LinkAssist configuration kept changing while the snapshot was being created; retry when the current edit is saved: {}",
        path.display()
    ))
}

fn read_optional_config_bytes(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Failed to read snapshot configuration '{}': {error}",
            path.display()
        )),
    }
}

fn load_config_from_path(path: &std::path::Path) -> Result<AppConfig, String> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let json = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    match serde_json::from_str(&json) {
        Ok(config) => Ok(config),
        Err(e) => {
            // A corrupt config would otherwise block startup forever; keep the
            // broken file for inspection and continue with defaults.
            let backup = path.with_extension("json.corrupt");
            let _ = fs::copy(&path, &backup);
            eprintln!(
                "Config parse error ({}); backed up corrupt file to {} and using defaults",
                e,
                backup.display()
            );
            Ok(AppConfig::default())
        }
    }
}

fn standalone_config_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join("Library").join("Application Support"))
        .unwrap_or_else(std::env::temp_dir);

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".local").join("share"))
        })
        .unwrap_or_else(std::env::temp_dir);

    base.join(APP_IDENTIFIER).join("config.json")
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "linkassist-persistence-{name}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn concurrent_saves_leave_one_complete_config_and_no_temporary_files() {
        let directory = test_path("concurrent").with_extension("");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("config.json");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut config = AppConfig::default();
                    config.protocol.lua_script = format!("writer-{index}").repeat(1024);
                    barrier.wait();
                    save_config_to_path(&path, &config).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let saved: AppConfig = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(
            (0..8).any(|index| saved.protocol.lua_script == format!("writer-{index}").repeat(1024))
        );
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn failed_replacement_removes_only_its_temporary_file() {
        let directory = test_path("failed-save").with_extension("");
        fs::create_dir(&directory).unwrap();
        let path = directory.join("config.json");
        // A non-empty directory cannot be replaced with a file.
        fs::create_dir(&path).unwrap();
        fs::write(path.join("keep"), b"original").unwrap();
        assert!(save_config_to_path(&path, &AppConfig::default()).is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(fs::read(path.join("keep")).unwrap(), b"original");
        fs::remove_file(path.join("keep")).unwrap();
        fs::remove_dir(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn stable_snapshot_load_is_strict_and_does_not_replace_invalid_config() {
        let path = test_path("invalid");
        fs::write(&path, b"{not-json").unwrap();

        let error = load_stable_snapshot_config(&path, 1, Duration::ZERO).unwrap_err();
        assert!(error.contains("is not valid JSON"));
        assert_eq!(fs::read(&path).unwrap(), b"{not-json");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stable_snapshot_load_accepts_a_complete_config() {
        let path = test_path("valid");
        let config = AppConfig::default();
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();

        let loaded = load_stable_snapshot_config(&path, 1, Duration::ZERO).unwrap();
        assert!(loaded.channels.is_empty());
        assert_eq!(loaded.ui.theme_mode, config.ui.theme_mode);

        fs::remove_file(path).unwrap();
    }
}
