mod ble;
mod channel_activity;
mod channel_registry;
mod commands;
mod core_http;
mod discovery;
mod error;
mod mcp_bridge;
mod mcp_tool_script;
mod mcp_tools;
mod persistence;
mod protocol;
mod recent_events;
mod script_helper;
mod script_markers;
mod serial;
mod snapshot;
mod tcp;
mod test_runner;

pub use error::{AppError, AppResult};

pub fn create_snapshot(output: &str) -> Result<snapshot::SnapshotReport, String> {
    let config = persistence::load_config_for_snapshot()?;
    let config = serde_json::to_value(config)
        .map_err(|error| format!("Cannot serialize LinkAssist configuration: {error}"))?;
    snapshot::create_snapshot(std::path::Path::new(output), config)
}

pub fn prepare_snapshot_runtime() -> Result<(), String> {
    snapshot::prepare_runtime()
}

use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

#[cfg(target_os = "windows")]
fn disable_dwm_window_transitions(window: &tauri::WebviewWindow) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED},
    };

    // Tauri and the app currently resolve different windows crate versions,
    // so reconstruct this crate's HWND wrapper from the shared raw pointer.
    let tauri_hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = HWND(tauri_hwnd.0);
    let disabled = 1_i32;

    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            std::ptr::from_ref(&disabled).cast(),
            std::mem::size_of_val(&disabled) as u32,
        )
    }
    .map_err(|error| error.to_string())
}

#[derive(Clone)]
pub struct AppState {
    pub ble_manager: Arc<Mutex<ble::BleManager>>,
    pub serial_manager: Arc<Mutex<serial::SerialManager>>,
    pub network_manager: Arc<Mutex<tcp::NetworkManager>>,
    pub protocol_manager: Arc<Mutex<protocol::ProtocolManager>>,
    pub recent_events: recent_events::RecentEventBuffer,
    pub channel_registry: channel_registry::ChannelRegistry,
    pub(crate) script_execution_registry: mcp_tool_script::ScriptExecutionRegistry,
    pub test_run_manager: test_runner::TestRunManager,
}

#[derive(Clone)]
pub(crate) struct UiLifecycle {
    state: Arc<AtomicU8>,
    frontend_ready: Arc<AtomicBool>,
}

#[derive(Clone)]
pub(crate) struct McpToolAccess {
    enabled: Arc<AtomicBool>,
}

impl McpToolAccess {
    fn new(enabled: bool) -> Self {
        Self {
            enabled: Arc::new(AtomicBool::new(enabled)),
        }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
    }
}

impl UiLifecycle {
    const HEADLESS: u8 = 0;
    const UI_REQUESTED: u8 = 1;
    const SHUTTING_DOWN: u8 = 2;

    fn new(headless: bool) -> Self {
        Self {
            state: Arc::new(AtomicU8::new(if headless {
                Self::HEADLESS
            } else {
                Self::UI_REQUESTED
            })),
            frontend_ready: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn request_ui(&self) -> Result<bool, ()> {
        loop {
            match self.state.load(Ordering::SeqCst) {
                Self::UI_REQUESTED => {
                    return Ok(self.frontend_ready.load(Ordering::SeqCst));
                }
                Self::SHUTTING_DOWN => return Err(()),
                Self::HEADLESS => {
                    if self
                        .state
                        .compare_exchange(
                            Self::HEADLESS,
                            Self::UI_REQUESTED,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_ok()
                    {
                        return Ok(self.frontend_ready.load(Ordering::SeqCst));
                    }
                }
                _ => return Err(()),
            }
        }
    }

    fn mark_frontend_ready(&self) -> bool {
        self.frontend_ready.store(true, Ordering::SeqCst);
        self.is_ui_requested()
    }

    pub(crate) fn is_ui_requested(&self) -> bool {
        self.state.load(Ordering::SeqCst) == Self::UI_REQUESTED
    }

    pub(crate) fn is_shutting_down(&self) -> bool {
        self.state.load(Ordering::SeqCst) == Self::SHUTTING_DOWN
    }

    pub(crate) fn begin_shutdown(&self) -> bool {
        self.state
            .compare_exchange(
                Self::HEADLESS,
                Self::SHUTTING_DOWN,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
    }

    pub(crate) fn mode(&self) -> &'static str {
        if self.is_ui_requested() {
            "ui"
        } else {
            "headless"
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct TrayRequests {
    pending_settings: Arc<AtomicBool>,
}

impl TrayRequests {
    fn request_settings(&self) {
        self.pending_settings.store(true, Ordering::SeqCst);
    }

    fn consume_pending_settings(&self) -> bool {
        self.pending_settings.swap(false, Ordering::SeqCst)
    }
}

const TRAY_EVENT_OPEN_SETTINGS: &str = "tray-open-settings";
const MCP_TOOLS_ENABLED_CHANGED_EVENT: &str = "mcp-tools-enabled-changed";
const TRAY_ID: &str = "main-tray";
const MCP_ENABLE_LABEL: &str = "Enable MCP Tools";
const MCP_DISABLE_LABEL: &str = "Disable MCP Tools";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn consume_tray_settings_request(tray_requests: tauri::State<'_, TrayRequests>) -> bool {
    tray_requests.consume_pending_settings()
}

#[tauri::command]
fn set_tray_visible(
    app_handle: tauri::AppHandle,
    visible: bool,
    ui_lifecycle: tauri::State<'_, UiLifecycle>,
    tray_requests: tauri::State<'_, TrayRequests>,
    mcp_tool_access: tauri::State<'_, McpToolAccess>,
) -> Result<(), String> {
    if let Some(tray) = app_handle.tray_by_id(TRAY_ID) {
        return tray.set_visible(visible).map_err(|error| error.to_string());
    }

    if visible {
        setup_tray(
            &app_handle,
            ui_lifecycle.inner(),
            tray_requests.inner(),
            mcp_tool_access.inner(),
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_mcp_tools_enabled(
    app_handle: tauri::AppHandle,
    enabled: bool,
    mcp_tool_access: tauri::State<'_, McpToolAccess>,
) -> Result<(), String> {
    persist_mcp_tools_enabled(&app_handle, mcp_tool_access.inner(), enabled)
}

#[tauri::command]
fn get_launch_mode(ui_lifecycle: tauri::State<'_, UiLifecycle>) -> &'static str {
    ui_lifecycle.mode()
}

#[tauri::command]
fn main_window_ready(
    app_handle: tauri::AppHandle,
    ui_lifecycle: tauri::State<'_, UiLifecycle>,
) -> Result<bool, String> {
    if !ui_lifecycle.mark_frontend_ready() {
        return Ok(false);
    }
    reveal_main_window(&app_handle)?;
    Ok(true)
}

pub(crate) fn reveal_main_window(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window is not available".to_string())?;
    window
        .unminimize()
        .map_err(|error| format!("Failed to restore main window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Failed to show main window: {error}"))?;
    // The window is created with skipTaskbar=true. Add it only after ShowWindow
    // so Windows 10 never observes both an early hidden registration and the
    // real visible registration as separate taskbar buttons.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    window
        .set_skip_taskbar(false)
        .map_err(|error| format!("Failed to add main window to the taskbar: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Failed to focus main window: {error}"))
}

/// Tray equivalent of the core HTTP `/ui/show` endpoint. The discovery-file
/// mode rewrite is left to the HTTP path; the mode field is informational and
/// only the HTTP handler holds the token needed to update it.
fn show_main_window_from_tray(app_handle: &tauri::AppHandle, ui_lifecycle: &UiLifecycle) {
    if ui_lifecycle.request_ui().is_err() {
        return; // Core is shutting down; ignore the request.
    }
    if let Err(error) = reveal_main_window(app_handle) {
        log::warn!("Failed to reveal the main window from the tray: {error}");
    }
}

/// Explicit user quit from the tray: unlike the idle-based `/core/shutdown`
/// path, this exits regardless of bridge leases or an active UI session.
fn exit_from_tray(app_handle: &tauri::AppHandle, ui_lifecycle: &UiLifecycle) {
    if let Err(error) = discovery::mark_explicit_shutdown_sync() {
        log::warn!("Failed to notify MCP bridges about explicit shutdown: {error}");
    }
    ui_lifecycle.begin_shutdown();
    let app_state = app_handle.state::<AppState>().inner().clone();
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = core_http::run_shutdown_hooks_and_exit(&app_state, app_handle).await;
    });
}

fn create_tray_menu(
    app: &tauri::AppHandle,
    mcp_tools_enabled: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let mcp_item = MenuItem::with_id(
        app,
        "toggle-mcp-tools",
        if mcp_tools_enabled {
            MCP_DISABLE_LABEL
        } else {
            MCP_ENABLE_LABEL
        },
        true,
        None::<&str>,
    )?;
    let close_item = MenuItem::with_id(app, "close", "Exit", true, None::<&str>)?;
    Menu::with_items(app, &[&open_item, &settings_item, &mcp_item, &close_item])
}

fn refresh_tray_menu(app_handle: &tauri::AppHandle, mcp_tools_enabled: bool) -> Result<(), String> {
    let Some(tray) = app_handle.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu = create_tray_menu(app_handle, mcp_tools_enabled)
        .map_err(|error| format!("Failed to rebuild the tray menu: {error}"))?;
    tray.set_menu(Some(menu))
        .map_err(|error| format!("Failed to update the tray menu: {error}"))
}

fn persist_mcp_tools_enabled(
    app_handle: &tauri::AppHandle,
    mcp_tool_access: &McpToolAccess,
    enabled: bool,
) -> Result<(), String> {
    let mut config = persistence::load_config(app_handle)?;
    mcp_tools::set_mcp_tools_enabled(&mut config, enabled).map_err(|error| error.to_string())?;
    persistence::save_config(app_handle, &config)?;
    mcp_tool_access.set_enabled(enabled);
    if let Err(error) = refresh_tray_menu(app_handle, enabled) {
        log::warn!("{error}");
    }
    if let Err(error) = app_handle.emit_to("main", MCP_TOOLS_ENABLED_CHANGED_EVENT, enabled) {
        log::warn!("Failed to emit the MCP status change: {error}");
    }
    Ok(())
}

fn setup_tray(
    app: &tauri::AppHandle,
    ui_lifecycle: &UiLifecycle,
    tray_requests: &TrayRequests,
    mcp_tool_access: &McpToolAccess,
) -> tauri::Result<()> {
    let menu = create_tray_menu(app, mcp_tool_access.is_enabled())?;

    let menu_ui_lifecycle = ui_lifecycle.clone();
    let menu_tray_requests = tray_requests.clone();
    let menu_mcp_tool_access = mcp_tool_access.clone();
    let click_ui_lifecycle = ui_lifecycle.clone();

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("LinkAssist")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app_handle, event| match event.id.as_ref() {
            "open" => show_main_window_from_tray(app_handle, &menu_ui_lifecycle),
            "settings" => {
                // Mark the request before revealing: a headless Core may still
                // be loading its frontend, so the emitted event can be lost
                // before the MainLayout listener registers. The frontend
                // consumes the pending flag on mount to cover that window.
                menu_tray_requests.request_settings();
                show_main_window_from_tray(app_handle, &menu_ui_lifecycle);
                if let Err(error) = app_handle.emit_to("main", TRAY_EVENT_OPEN_SETTINGS, ()) {
                    log::warn!("Failed to emit the tray settings request: {error}");
                }
            }
            "toggle-mcp-tools" => {
                let enabled = !menu_mcp_tool_access.is_enabled();
                if let Err(error) =
                    persist_mcp_tools_enabled(app_handle, &menu_mcp_tool_access, enabled)
                {
                    log::warn!("Failed to persist the MCP tools state: {error}");
                }
            }
            "close" => exit_from_tray(app_handle, &menu_ui_lifecycle),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window_from_tray(tray.app_handle(), &click_ui_lifecycle);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = discovery::clear_explicit_shutdown_sync() {
        eprintln!("Failed to clear the previous LinkAssist shutdown marker: {error}");
    }
    match prepare_ui_launch() {
        Ok(UiLaunchDecision::Start(core_lock)) => run_tauri_core(false, core_lock),
        Ok(UiLaunchDecision::SignaledExistingCore) => {}
        Err(error) => eprintln!("Failed to start LinkAssist UI: {error}"),
    }
}

pub fn run_core_headless() {
    match discovery::try_acquire_core_instance_lock() {
        Ok(Some(core_lock)) => run_tauri_core(true, core_lock),
        Ok(None) => {}
        Err(error) => eprintln!("Failed to start LinkAssist Core: {error}"),
    }
}

pub fn run_mcp_bridge() -> AppResult<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(mcp_bridge::run_stdio_bridge())
}

enum UiLaunchDecision {
    Start(discovery::CoreInstanceLock),
    SignaledExistingCore,
}

fn prepare_ui_launch() -> AppResult<UiLaunchDecision> {
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(core_lock) = discovery::try_acquire_core_instance_lock()? {
                if let Some(existing) = discovery::read_discovery().await {
                    if discovery::core_is_healthy(&existing).await
                        && discovery::post_core_control(&existing, "/ui/show")
                            .await
                            .is_ok()
                    {
                        return Ok(UiLaunchDecision::SignaledExistingCore);
                    }
                }
                return Ok(UiLaunchDecision::Start(core_lock));
            }

            if let Some(existing) = discovery::read_discovery().await {
                if discovery::core_is_healthy(&existing).await
                    && discovery::post_core_control(&existing, "/ui/show")
                        .await
                        .is_ok()
                {
                    return Ok(UiLaunchDecision::SignaledExistingCore);
                }
            }

            if Instant::now() >= deadline {
                return Err(AppError::Tcp(
                    "Timed out waiting for the existing Core to become ready".to_string(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
}

fn build_app_state() -> AppResult<AppState> {
    let script_execution_registry = mcp_tool_script::ScriptExecutionRegistry::default();
    Ok(AppState {
        ble_manager: Arc::new(Mutex::new(ble::BleManager::new())),
        serial_manager: Arc::new(Mutex::new(serial::SerialManager::new())),
        network_manager: Arc::new(Mutex::new(tcp::NetworkManager::new())),
        protocol_manager: Arc::new(Mutex::new(protocol::ProtocolManager::new()?)),
        recent_events: recent_events::RecentEventBuffer::new(),
        channel_registry: channel_registry::ChannelRegistry::new(),
        script_execution_registry: script_execution_registry.clone(),
        test_run_manager: test_runner::TestRunManager::with_script_execution_registry(
            script_execution_registry,
        ),
    })
}

fn run_tauri_core(headless: bool, core_lock: discovery::CoreInstanceLock) {
    let app_state = build_app_state().expect("Failed to init app state");
    let http_state = app_state.clone();
    let ui_lifecycle = UiLifecycle::new(headless);
    let http_ui_lifecycle = ui_lifecycle.clone();
    let tray_ui_lifecycle = ui_lifecycle.clone();
    let tray_requests = TrayRequests::default();
    let setup_tray_requests = tray_requests.clone();
    let mcp_tool_access = McpToolAccess::new(true);
    let http_mcp_tool_access = mcp_tool_access.clone();
    let tray_mcp_tool_access = mcp_tool_access.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = disable_dwm_window_transitions(&window) {
                    log::warn!("Failed to disable main-window DWM transitions: {error}");
                }
            }

            let config = persistence::load_config(app.handle()).unwrap_or_default();
            let simple_mode = config.ui.simple_mode;
            let mcp_tools_enabled = mcp_tools::mcp_tools_enabled(&config).unwrap_or(true);
            tray_mcp_tool_access.set_enabled(mcp_tools_enabled);
            if !simple_mode {
                if let Err(error) = setup_tray(
                    app.handle(),
                    &tray_ui_lifecycle,
                    &setup_tray_requests,
                    &tray_mcp_tool_access,
                ) {
                    log::warn!("Failed to initialize the tray icon: {error}");
                }
            }

            let app_handle = app.handle().clone();
            // tauri.conf.json creates the desktop window hidden. Do not call
            // hide() again for a headless launch: on Windows that can suspend
            // the hidden WebView before it reports frontend readiness. The
            // window is revealed only after an explicit UI request.
            tauri::async_runtime::spawn(core_http::serve_core_http(
                http_state.clone(),
                app_handle,
                http_ui_lifecycle.clone(),
                http_mcp_tool_access.clone(),
            ));
            Ok(())
        })
        .manage(app_state)
        .manage(ui_lifecycle)
        .manage(tray_requests)
        .manage(mcp_tool_access)
        .invoke_handler(tauri::generate_handler![
            greet,
            get_launch_mode,
            main_window_ready,
            consume_tray_settings_request,
            set_tray_visible,
            set_mcp_tools_enabled,
            commands::ble::start_ble_scan,
            commands::ble::stop_ble_scan,
            commands::ble::get_ble_devices,
            commands::ble::get_ble_pairing_statuses,
            commands::ble::connect_ble_device,
            commands::ble::disconnect_ble_device,
            commands::ble::get_gatt_services,
            commands::ble::read_ble_characteristic,
            commands::ble::write_ble_characteristic,
            commands::ble::subscribe_ble_notifications,
            commands::ble::unsubscribe_ble_notifications,
            commands::serial::list_serial_ports,
            commands::serial::open_serial_port,
            commands::serial::close_serial_port,
            commands::serial::send_serial_data,
            commands::serial::receive_serial_data,
            commands::serial::get_serial_connections,
            commands::tcp::tcp_connect,
            commands::tcp::tcp_disconnect,
            commands::tcp::tcp_send,
            commands::tcp::tcp_receive,
            commands::tcp::tcp_list_connections,
            commands::tcp::tcp_server_start,
            commands::tcp::tcp_server_stop,
            commands::tcp::tcp_server_accept,
            commands::tcp::tcp_server_send,
            commands::tcp::tcp_server_receive,
            commands::tcp::tcp_server_disconnect_client,
            commands::tcp::tcp_server_list_clients,
            commands::tcp::udp_bind,
            commands::tcp::udp_unbind,
            commands::tcp::udp_send,
            commands::tcp::udp_receive,
            commands::protocol::parse_data,
            commands::protocol::set_parser_mode,
            commands::protocol::get_parser_mode,
            commands::protocol::set_field_definitions,
            commands::protocol::get_field_definitions,
            commands::protocol::load_lua_script,
            commands::protocol::validate_lua_script,
            commands::protocol::get_protocol_templates,
            commands::protocol::apply_protocol_template,
            commands::protocol::get_lua_protocol_file_summary,
            commands::protocol::parse_data_with_lua_file,
            commands::protocol::encode_field_with_lua_file,
            commands::protocol::encode_transaction_with_lua_file,
            commands::protocol::match_transaction_response_with_lua_file,
            commands::script::parse_lua_automation_script,
            commands::script::parse_lua_automation_file,
            commands::script::parse_lua_canvas_lifecycle_file,
            commands::script_helper::call_lua_script_helper_file,
            commands::mcp::get_mcp_tool_meta,
            commands::mcp::run_mcp_tool_script_file,
            commands::channel::register_channel_connection,
            commands::channel::unregister_channel_connection,
            commands::persistence::save_app_config,
            commands::persistence::load_app_config,
            commands::persistence::export_to_file,
            commands::persistence::append_to_file,
            commands::persistence::import_from_file,
            commands::persistence::get_executable_directory,
            commands::test_runner::load_test_runner_catalog,
            commands::test_runner::start_test_run,
            commands::test_runner::get_test_run,
            commands::test_runner::list_test_runs,
            commands::test_runner::cancel_test_run,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let _ = discovery::remove_discovery_for_current_process_sync();
            return;
        }

        // The tray owns the app lifetime: closing the main window hides it
        // while the Core keeps running (exit lives in the tray menu). Detached
        // terminal windows close for real.
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = event
        {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.hide();
                    #[cfg(any(target_os = "windows", target_os = "linux"))]
                    if let Err(error) = window.set_skip_taskbar(true) {
                        log::warn!("Failed to remove hidden main window from the taskbar: {error}");
                    }
                }
            }
        }
    });
    drop(core_lock);
}

#[cfg(test)]
mod tests {
    use super::{McpToolAccess, UiLifecycle};

    #[test]
    fn headless_ui_waits_for_an_explicit_request_and_frontend_readiness() {
        let lifecycle = UiLifecycle::new(true);
        assert_eq!(lifecycle.mode(), "headless");
        assert!(!lifecycle.mark_frontend_ready());
        assert!(lifecycle.request_ui().unwrap());
        assert_eq!(lifecycle.mode(), "ui");
    }

    #[test]
    fn normal_ui_is_requested_from_start_but_waits_until_frontend_is_ready() {
        let lifecycle = UiLifecycle::new(false);
        assert_eq!(lifecycle.mode(), "ui");
        assert!(!lifecycle.request_ui().unwrap());
        assert!(lifecycle.mark_frontend_ready());
    }

    #[test]
    fn shutdown_and_ui_request_are_mutually_exclusive() {
        let lifecycle = UiLifecycle::new(true);
        assert!(lifecycle.begin_shutdown());
        assert!(lifecycle.is_shutting_down());
        assert!(lifecycle.request_ui().is_err());

        let promoted = UiLifecycle::new(true);
        assert!(!promoted.request_ui().unwrap());
        assert!(!promoted.begin_shutdown());
    }

    #[test]
    fn mcp_tool_access_can_be_disabled_and_enabled_again() {
        let access = McpToolAccess::new(true);
        assert!(access.is_enabled());
        access.set_enabled(false);
        assert!(!access.is_enabled());
        access.set_enabled(true);
        assert!(access.is_enabled());
    }
}
