use crate::ble::gatt::BleWriteType;
use crate::ble::{scanner::BleDevice, NotificationConsumer};
use crate::channel_activity::{emit_channel_activity, ChannelActivityEvent, ToolInvocationContext};
use crate::commands::ble::BleNotificationEvent;
use crate::persistence::{load_config, save_config, AppConfig};
use crate::protocol::{lua_engine::LuaEngine, FieldDefinition, ParserMode};
use crate::recent_events::{current_timestamp_ms, CoreEvent, EventWaitResult};
use crate::script_markers::{ensure_lua_script_kind, LuaScriptKind};
use crate::serial::{list_ports, SerialConfig};
use crate::{AppError, AppResult, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolScript {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub expose_to_mcp: bool,
    #[serde(default)]
    pub source_type: McpToolScriptSourceType,
    #[serde(default)]
    pub inline_lua: String,
    #[serde(default, alias = "filePath", alias = "path")]
    pub lua_path: Option<String>,
    #[serde(default = "empty_schema")]
    pub input_schema: Value,
    #[serde(default = "default_use_current_channel")]
    pub use_current_channel: bool,
    #[serde(default)]
    pub target_channel_id: Option<String>,
    #[serde(default)]
    pub protocol_file: Option<String>,
    #[serde(default)]
    pub protocol_resource_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolScriptMeta {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "empty_schema", alias = "input_schema")]
    pub input_schema: Value,
    #[serde(default, alias = "protocol_file")]
    pub protocol_file: Option<String>,
    #[serde(default, alias = "exclusive_group")]
    pub exclusive_group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolScriptPreview {
    pub tools: Vec<McpToolScriptMeta>,
}

#[derive(Debug, Clone)]
pub struct McpResolvedScriptTool {
    pub script: McpToolScript,
    pub meta: McpToolScriptMeta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpToolScriptSourceType {
    Inline,
    File,
}

impl Default for McpToolScriptSourceType {
    fn default() -> Self {
        Self::File
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolsConfig {
    #[serde(default = "default_mcp_tools_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub scripts: Vec<McpToolScript>,
}

impl Default for McpToolsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scripts: Vec::new(),
        }
    }
}

fn default_mcp_tools_enabled() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetBleNotificationsDataArgs {
    #[serde(default)]
    seconds: Option<u64>,
    #[serde(default)]
    count: Option<usize>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetBleDevicesArgs {
    #[serde(default)]
    name_keyword: Option<String>,
    #[serde(default)]
    exact_name: Option<String>,
    #[serde(default)]
    connectable_only: bool,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    wait_timeout_ms: Option<u64>,
    #[serde(default)]
    poll_interval_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BleWaitNotificationArgs {
    after_cursor: u64,
    device_id: String,
    service_uuid: String,
    char_uuid: String,
    #[serde(default = "default_notification_wait_timeout_ms")]
    timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolTransactionRequestArgs {
    file_path: String,
    #[serde(default)]
    resource_root: Option<String>,
    device_id: String,
    transaction_id: String,
    #[serde(default = "empty_json_object")]
    values: Value,
    #[serde(default = "default_protocol_transaction_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_true")]
    strict: bool,
}

fn default_notification_wait_timeout_ms() -> u64 {
    5_000
}

fn default_protocol_transaction_timeout_ms() -> u64 {
    5_000
}

fn default_true() -> bool {
    true
}

fn empty_json_object() -> Value {
    json!({})
}

pub fn tool_definitions_with_config(config: &AppConfig) -> Vec<McpToolDefinition> {
    let mut definitions = builtin_tool_definitions();
    definitions.extend(exposed_script_tools(config));
    definitions
}

pub fn exposed_script_tools(config: &AppConfig) -> Vec<McpToolDefinition> {
    exposed_script_entries(config)
        .into_iter()
        .map(|entry| {
            tool(
                &entry.meta.name,
                &entry.meta.description,
                entry.meta.input_schema,
            )
        })
        .collect()
}

pub fn find_exposed_script(
    config: &AppConfig,
    name: &str,
) -> AppResult<Option<McpResolvedScriptTool>> {
    Ok(exposed_script_entries(config)
        .into_iter()
        .find_map(|mut entry| {
            if entry.meta.name == name {
                entry.script.name = entry.meta.name.clone();
                entry.script.description = entry.meta.description.clone();
                entry.script.input_schema = entry.meta.input_schema.clone();
                if entry.meta.protocol_file.is_some() {
                    entry.script.protocol_file = entry.meta.protocol_file.clone();
                }
                Some(entry)
            } else {
                None
            }
        }))
}

fn configured_shutdown_hook_scripts(config: &AppConfig) -> Vec<McpToolScript> {
    let Some(mcp_tools) = mcp_tools_config(config).ok().flatten() else {
        return Vec::new();
    };

    let mut seen_paths = HashSet::new();

    mcp_tools
        .scripts
        .into_iter()
        .filter(|script| script_has_valid_enabled_file_path(script))
        .filter(|script| {
            script
                .lua_path
                .as_ref()
                .is_some_and(|path| seen_paths.insert(path.clone()))
        })
        .collect()
}

pub async fn run_configured_shutdown_hooks(state: &AppState, app_handle: AppHandle) -> Vec<String> {
    let config = match load_config(&app_handle) {
        Ok(config) => config,
        Err(error) => {
            return vec![format!(
                "Failed to load MCP tool config during shutdown: {}",
                error
            )];
        }
    };

    let mut errors = Vec::new();
    for script in configured_shutdown_hook_scripts(&config) {
        let script_label = script
            .lua_path
            .clone()
            .unwrap_or_else(|| script.name.clone());

        if let Err(error) = crate::mcp_tool_script::execute_mcp_script_shutdown_hook(
            state,
            Some(app_handle.clone()),
            &script,
        )
        .await
        {
            errors.push(format!("{}: {}", script_label, error));
        }
    }

    errors
}

fn exposed_script_entries(config: &AppConfig) -> Vec<McpResolvedScriptTool> {
    let builtin_names = builtin_tool_names();
    let mut user_names = HashSet::new();

    let Some(mcp_tools) = mcp_tools_config(config).ok().flatten() else {
        return Vec::new();
    };

    mcp_tools
        .scripts
        .into_iter()
        .filter(|script| script_has_valid_enabled_file_path(script))
        .flat_map(|script| {
            let preview = match load_mcp_tool_meta_for_script(&script) {
                Ok(preview) => preview,
                Err(_) => return Vec::new().into_iter(),
            };

            preview
                .tools
                .into_iter()
                .filter(|meta| meta_is_exposed_tool(meta, &builtin_names))
                .filter(|meta| user_names.insert(meta.name.clone()))
                .map(move |meta| McpResolvedScriptTool {
                    script: script.clone(),
                    meta,
                })
                .collect::<Vec<_>>()
                .into_iter()
        })
        .collect()
}

pub fn load_mcp_tool_meta_for_script(script: &McpToolScript) -> AppResult<McpToolScriptPreview> {
    let path = script
        .lua_path
        .as_deref()
        .ok_or_else(|| AppError::Protocol("MCP tool script has no Lua file path".to_string()))?;
    load_mcp_tool_meta_from_path(path)
}

pub fn load_mcp_tool_meta_from_path(path: &str) -> AppResult<McpToolScriptPreview> {
    let script_content = std::fs::read_to_string(path)?;
    ensure_lua_script_kind(&script_content, LuaScriptKind::McpTool)?;
    let loaded = crate::mcp_tool_script::load_mcp_tool_script(&script_content)?;
    Ok(McpToolScriptPreview {
        tools: loaded.tools,
    })
}

fn builtin_tool_names() -> HashSet<String> {
    builtin_tool_definitions()
        .into_iter()
        .map(|definition| definition.name)
        .collect()
}

pub fn is_builtin_tool_name(name: &str) -> bool {
    builtin_tool_names().contains(name)
}

fn script_has_valid_enabled_file_path(script: &McpToolScript) -> bool {
    script.expose_to_mcp
        && script.source_type == McpToolScriptSourceType::File
        && script
            .lua_path
            .as_deref()
            .is_some_and(|path| !path.trim().is_empty())
}

fn meta_is_exposed_tool(meta: &McpToolScriptMeta, builtin_names: &HashSet<String>) -> bool {
    is_valid_user_tool_name(&meta.name) && !builtin_names.contains(&meta.name)
}

fn is_valid_user_tool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.trim() == name
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

pub(crate) fn mcp_tools_config(config: &AppConfig) -> AppResult<Option<McpToolsConfig>> {
    config
        .mcp_tools
        .clone()
        .map(serde_json::from_value::<McpToolsConfig>)
        .transpose()
        .map_err(AppError::Serde)
}

pub(crate) fn mcp_tools_enabled(config: &AppConfig) -> AppResult<bool> {
    Ok(mcp_tools_config(config)?
        .map(|mcp_tools| mcp_tools.enabled)
        .unwrap_or(true))
}

pub(crate) fn set_mcp_tools_enabled(config: &mut AppConfig, enabled: bool) -> AppResult<()> {
    let mut mcp_tools = mcp_tools_config(config)?.unwrap_or_default();
    mcp_tools.enabled = enabled;
    config.mcp_tools = Some(serde_json::to_value(mcp_tools)?);
    Ok(())
}

fn builtin_tool_definitions() -> Vec<McpToolDefinition> {
    vec![
        tool("greet", "Return a greeting from the Rust backend.", object_schema(json!({ "name": { "type": "string" } }), &["name"])),
        tool("cancel_script_execution", "Request cooperative cancellation of a running Lua MCP script by executionId.", object_schema(json!({ "executionId": { "type": "string", "description": "Execution id supplied when the script run started." } }), &["executionId"])),
        tool("ble_start_scan", "Start BLE scanning.", empty_schema()),
        tool("ble_stop_scan", "Stop BLE scanning.", empty_schema()),
        tool(
            "ble_get_devices",
            "List discovered BLE devices. exactName plus waitTimeoutMs performs a bounded wait for one specific advertised name.",
            object_schema(
                json!({
                    "nameKeyword": {
                        "type": "string",
                        "description": "Optional case-insensitive keyword matched against device name and advertisement name."
                    },
                    "exactName": {
                        "type": "string",
                        "description": "Optional exact device or advertisement name."
                    },
                    "connectableOnly": {
                        "type": "boolean",
                        "default": false
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1
                    },
                    "waitTimeoutMs": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 60000,
                        "description": "Bounded wait for exactName. The caller must start scanning first."
                    },
                    "pollIntervalMs": {
                        "type": "integer",
                        "minimum": 25,
                        "maximum": 2000,
                        "default": 250
                    }
                }),
                &[],
            ),
        ),
        tool("ble_connect_device", "Connect to a BLE device by explicit deviceId.", object_schema(json!({ "deviceId": { "type": "string" } }), &["deviceId"])),
        tool("ble_disconnect_device", "Disconnect a BLE device by explicit deviceId.", object_schema(json!({ "deviceId": { "type": "string" } }), &["deviceId"])),
        tool("ble_get_gatt_services", "Discover GATT services for a connected BLE device.", object_schema(json!({ "deviceId": { "type": "string" } }), &["deviceId"])),
        tool("ble_read_characteristic", "Read a BLE characteristic by explicit deviceId/serviceUuid/charUuid.", object_schema(json!({ "deviceId": { "type": "string" }, "serviceUuid": { "type": "string" }, "charUuid": { "type": "string" } }), &["deviceId", "serviceUuid", "charUuid"])),
        tool("ble_write_characteristic", "Write bytes to a BLE characteristic. Omitted writeType preserves the legacy withResponse behavior; auto selects an advertised mode.", object_schema(json!({ "deviceId": { "type": "string" }, "serviceUuid": { "type": "string" }, "charUuid": { "type": "string" }, "data": bytes_schema(), "writeType": { "type": "string", "enum": ["auto", "withResponse", "withoutResponse"], "default": "withResponse" } }), &["deviceId", "serviceUuid", "charUuid", "data"])),
        tool("ble_subscribe_notifications", "Subscribe to BLE characteristic notifications and return only after the shared notification pump is ready.", object_schema(json!({ "deviceId": { "type": "string" }, "serviceUuid": { "type": "string" }, "charUuid": { "type": "string" } }), &["deviceId", "serviceUuid", "charUuid"])),
        tool("ble_unsubscribe_notifications", "Release a BLE notification subscription by subscriptionId. Legacy endpoint arguments remain supported and release MCP holders for that endpoint.", object_schema(json!({ "subscriptionId": { "type": "string" }, "deviceId": { "type": "string" }, "serviceUuid": { "type": "string" }, "charUuid": { "type": "string" } }), &[])),
        tool("event_checkpoint", "Return the current monotonic Core event cursor.", empty_schema()),
        tool("ble_wait_notification", "Wait for a BLE notification newer than afterCursor at one endpoint. Returns immediately for cursor overflow, a future cursor, or device disconnect.", object_schema(json!({ "afterCursor": { "type": "integer", "minimum": 0 }, "deviceId": { "type": "string" }, "serviceUuid": { "type": "string" }, "charUuid": { "type": "string" }, "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 120000, "default": 5000 } }), &["afterCursor", "deviceId", "serviceUuid", "charUuid"])),
        tool(
            "ble_get_notifications_data",
            "Return buffered BLE notification payloads. Without arguments returns the latest notification; with seconds or count returns the recent BLE notifications.",
            object_schema(
                json!({
                    "seconds": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Optional. Return BLE notifications captured within the last N seconds."
                    },
                    "count": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Optional. Return the latest N BLE notifications."
                    }
                }),
                &[],
            ),
        ),
        tool("serial_list_ports", "List available serial ports.", json!({ "type": "object", "properties": {}, "additionalProperties": false })),
        tool("serial_open_port", "Open a serial port and return its explicit connectionId.", json!({ "type": "object", "properties": { "config": { "type": "object" }, "channelId": { "type": "string" } }, "required": ["config", "channelId"], "additionalProperties": false })),
        tool("serial_close_port", "Close a serial connection by connectionId.", json!({ "type": "object", "properties": { "connectionId": { "type": "string" } }, "required": ["connectionId"], "additionalProperties": false })),
        tool("serial_send_data", "Send bytes through an open serial connectionId.", json!({ "type": "object", "properties": { "connectionId": { "type": "string" }, "data": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 255 } } }, "required": ["connectionId", "data"], "additionalProperties": false })),
        tool("serial_receive_data", "Poll bytes from an open serial connectionId.", object_schema(json!({ "connectionId": { "type": "string" } }), &["connectionId"])),
        tool("serial_get_connections", "List open serial connection IDs.", empty_schema()),
        tool("tcp_connect", "Connect TCP client and return connectionId.", json!({ "type": "object", "properties": { "addr": { "type": "string" }, "channelId": { "type": "string" } }, "required": ["addr", "channelId"], "additionalProperties": false })),
        tool("tcp_disconnect", "Disconnect TCP client by connectionId.", json!({ "type": "object", "properties": { "connectionId": { "type": "string" } }, "required": ["connectionId"], "additionalProperties": false })),
        tool("tcp_send", "Send bytes through a TCP connectionId.", json!({ "type": "object", "properties": { "connectionId": { "type": "string" }, "data": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 255 } } }, "required": ["connectionId", "data"], "additionalProperties": false })),
        tool("tcp_receive", "Compatibility receive for TCP connectionId; event-driven backend returns an empty array.", object_schema(json!({ "connectionId": { "type": "string" } }), &["connectionId"])),
        tool("tcp_list_connections", "List TCP client connections.", empty_schema()),
        tool("tcp_server_start", "Start TCP server listening at addr and return bound address.", object_schema(json!({ "addr": { "type": "string" } }), &["addr"])),
        tool("tcp_server_stop", "Stop TCP server listener.", empty_schema()),
        tool("tcp_server_accept", "Compatibility command; server auto-accepts clients.", empty_schema()),
        tool("tcp_server_send", "Send bytes to a TCP server client by clientId.", object_schema(json!({ "clientId": { "type": "string" }, "data": bytes_schema() }), &["clientId", "data"])),
        tool("tcp_server_receive", "Compatibility receive for TCP server clientId; event-driven backend returns an empty array.", object_schema(json!({ "clientId": { "type": "string" } }), &["clientId"])),
        tool("tcp_server_disconnect_client", "Disconnect a TCP server client by clientId.", object_schema(json!({ "clientId": { "type": "string" } }), &["clientId"])),
        tool("tcp_server_list_clients", "List TCP server clients.", empty_schema()),
        tool("udp_bind", "Bind UDP socket at addr and return bound address.", object_schema(json!({ "addr": { "type": "string" } }), &["addr"])),
        tool("udp_unbind", "Unbind UDP socket.", empty_schema()),
        tool("udp_send", "Send UDP bytes to addr.", object_schema(json!({ "addr": { "type": "string" }, "data": bytes_schema() }), &["addr", "data"])),
        tool("udp_receive", "Compatibility UDP receive; event-driven backend returns empty data and addr.", empty_schema()),
        tool("protocol_parse_data", "Parse bytes with the current protocol parser.", json!({ "type": "object", "properties": { "data": { "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 255 } } }, "required": ["data"], "additionalProperties": false })),
        tool("protocol_set_parser_mode", "Set protocol parser mode.", object_schema(json!({ "mode": { "type": "string", "enum": ["Passthrough", "FieldDefinition", "LuaScript"] } }), &["mode"])),
        tool("protocol_get_parser_mode", "Get current protocol parser mode.", empty_schema()),
        tool("protocol_set_field_definitions", "Set protocol field definitions.", object_schema(json!({ "fields": { "type": "array", "items": { "type": "object" } } }), &["fields"])),
        tool("protocol_get_field_definitions", "Get protocol field definitions.", empty_schema()),
        tool("protocol_load_lua_script", "Load protocol Lua script.", object_schema(json!({ "script": { "type": "string" } }), &["script"])),
        tool("protocol_validate_lua_script", "Validate protocol Lua script.", object_schema(json!({ "script": { "type": "string" } }), &["script"])),
        tool("protocol_get_templates", "List built-in protocol templates.", empty_schema()),
        tool("protocol_apply_template", "Apply a built-in protocol template by templateId.", object_schema(json!({ "templateId": { "type": "string" } }), &["templateId"])),
        tool("protocol_get_lua_file_summary", "Summarize a Lua protocol file by filePath. resourceRoot optionally provides the sandboxed data directory used by read_text_file.", object_schema(json!({ "filePath": { "type": "string" }, "resourceRoot": { "type": "string" } }), &["filePath"])),
        tool("protocol_parse_data_with_lua_file", "Parse bytes using a Lua protocol file. resourceRoot optionally provides its external data directory.", object_schema(json!({ "filePath": { "type": "string" }, "resourceRoot": { "type": "string" }, "data": bytes_schema() }), &["filePath", "data"])),
        tool("protocol_encode_transaction_with_lua_file", "Encode a whole protocol transaction into an outbound frame using a Lua protocol file. Returns frame and route metadata. resourceRoot optionally provides the adapter's external data directory.", object_schema(json!({ "filePath": { "type": "string" }, "resourceRoot": { "type": "string" }, "transactionId": { "type": "string" }, "values": { "type": "object" } }), &["filePath", "transactionId"])),
        tool("protocol_match_transaction_response_with_lua_file", "Match response bytes against a transaction using a Lua protocol file's generic match_transaction_response contract. resourceRoot optionally provides its external data directory.", object_schema(json!({ "filePath": { "type": "string" }, "resourceRoot": { "type": "string" }, "transactionId": { "type": "string" }, "data": bytes_schema() }), &["filePath", "transactionId", "data"])),
        tool(
            "protocol_execute_transaction_with_lua_file",
            "Execute one protocol transaction atomically: encode, subscribe, checkpoint, write, wait for the matching response, parse it, and release the subscription. The protocol file owns all route and frame semantics.",
            object_schema(
                json!({
                    "filePath": { "type": "string" },
                    "resourceRoot": { "type": "string" },
                    "deviceId": { "type": "string" },
                    "transactionId": { "type": "string" },
                    "values": { "type": "object" },
                    "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 120000, "default": 5000 },
                    "strict": { "type": "boolean", "default": true }
                }),
                &["filePath", "deviceId", "transactionId"],
            ),
        ),
        tool("save_app_config", "Save application config.", object_schema(json!({ "config": { "type": "object" } }), &["config"])),
        tool("load_app_config", "Load application config.", empty_schema()),
        tool("export_to_file", "Export content to a file path.", object_schema(json!({ "path": { "type": "string" }, "content": { "type": "string" } }), &["path", "content"])),
        tool("import_from_file", "Import content from a file path. The default 'utf8' encoding fails on binary files; pass encoding 'base64' to read any file, including firmware images.", object_schema(json!({ "path": { "type": "string" }, "encoding": { "type": "string", "enum": ["utf8", "base64"], "default": "utf8" } }), &["path"])),
        tool("get_recent_events", "Return recent Core events/logs buffered by the headless core.", json!({ "type": "object", "properties": {}, "additionalProperties": false })),
    ]
}

pub async fn call_tool(
    state: &AppState,
    app_handle: AppHandle,
    name: &str,
    arguments: Value,
    context: Option<ToolInvocationContext>,
) -> AppResult<Value> {
    match name {
        "greet" => {
            let name = required_string(&arguments, "name")?;
            Ok(json!({ "message": format!("Hello, {}! You've been greeted from Rust!", name) }))
        }
        "cancel_script_execution" => {
            let execution_id = required_string(&arguments, "executionId")?;
            let cancelled = state.script_execution_registry.cancel(&execution_id)?;
            Ok(json!({ "ok": true, "executionId": execution_id, "cancelled": cancelled }))
        }
        "ble_start_scan" => {
            let _exclusive_lease = crate::commands::ble::acquire_ble_exclusive_lease(state).await;
            let mut manager = state.ble_manager.lock().await;
            manager.scanner.start_scan().await?;
            Ok(json!({ "ok": true }))
        }
        "ble_stop_scan" => {
            let _exclusive_lease = crate::commands::ble::acquire_ble_exclusive_lease(state).await;
            let mut manager = state.ble_manager.lock().await;
            manager.scanner.stop_scan().await?;
            Ok(json!({ "ok": true }))
        }
        "ble_get_devices" => {
            let request: GetBleDevicesArgs =
                serde_json::from_value(arguments).map_err(AppError::Serde)?;
            let wait_timeout_ms = request.wait_timeout_ms.unwrap_or(0).min(60_000);
            if request.limit == Some(0) {
                return Err(AppError::Protocol(
                    "ble_get_devices limit must be at least 1".to_string(),
                ));
            }
            if wait_timeout_ms > 0
                && !request
                    .exact_name
                    .as_deref()
                    .is_some_and(|name| !name.trim().is_empty())
            {
                return Err(AppError::Protocol(
                    "ble_get_devices waitTimeoutMs requires a non-empty exactName".to_string(),
                ));
            }

            let deadline = tokio::time::Instant::now() + Duration::from_millis(wait_timeout_ms);
            let poll_interval = request.poll_interval_ms.unwrap_or(250).clamp(25, 2_000);
            loop {
                let (devices, scan_active) = {
                    let mut manager = state.ble_manager.lock().await;
                    let devices = manager.scanner.refresh_devices().await?;
                    let scan_active = manager.scanner.is_scanning().await;
                    (filter_ble_devices(devices, &request), scan_active)
                };
                let timed_out = devices.is_empty()
                    && wait_timeout_ms > 0
                    && tokio::time::Instant::now() >= deadline;
                if !devices.is_empty() || wait_timeout_ms == 0 || timed_out {
                    break Ok(json!({
                        "devices": devices,
                        "scanActive": scan_active,
                        "timedOut": timed_out,
                    }));
                }
                tokio::time::sleep_until(std::cmp::min(
                    deadline,
                    tokio::time::Instant::now() + Duration::from_millis(poll_interval),
                ))
                .await;
            }
        }
        "ble_connect_device" => {
            let device_id = required_string(&arguments, "deviceId")?;
            let connection = crate::commands::ble::connect_ble_device_reliably(
                state,
                app_handle.clone(),
                &device_id,
            )
            .await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "connected", "ble")
                    .connection(device_id.clone())
                    .endpoint(json!({ "deviceId": device_id })),
            );
            Ok(json!({
                "ok": true,
                "deviceId": device_id,
                "isConnected": connection.is_connected,
                "scanStopped": true,
                "connectionParameters": connection.connection_parameters,
            }))
        }
        "ble_disconnect_device" => {
            let device_id = required_string(&arguments, "deviceId")?;
            crate::commands::ble::disconnect_ble_device_reliably(
                state,
                app_handle.clone(),
                &device_id,
            )
            .await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "disconnected", "ble")
                    .connection(device_id.clone())
                    .endpoint(json!({ "deviceId": device_id })),
            );
            Ok(json!({ "ok": true }))
        }
        "ble_get_gatt_services" => {
            let device_id = required_string(&arguments, "deviceId")?;
            let manager = state.ble_manager.lock().await;
            let peripheral = manager.connections.get_peripheral(&device_id).await?;
            drop(manager);
            let services = crate::ble::gatt::discover_services(&peripheral).await?;
            Ok(json!({ "services": services }))
        }
        "ble_read_characteristic" => {
            let device_id = required_string(&arguments, "deviceId")?;
            let service_uuid = required_string(&arguments, "serviceUuid")?;
            let char_uuid = required_string(&arguments, "charUuid")?;
            let manager = state.ble_manager.lock().await;
            let peripheral = manager.connections.get_peripheral(&device_id).await?;
            drop(manager);
            let data = crate::ble::gatt::read_characteristic(
                &peripheral,
                &device_id,
                &service_uuid,
                &char_uuid,
            )
            .await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "rx", "ble")
                    .connection(device_id.clone())
                    .endpoint(json!({
                        "deviceId": device_id,
                        "serviceUuid": service_uuid,
                        "charUuid": char_uuid,
                    }))
                    .data(&data),
            );
            Ok(json!({ "data": data }))
        }
        "ble_write_characteristic" => {
            let device_id = required_string(&arguments, "deviceId")?;
            let service_uuid = required_string(&arguments, "serviceUuid")?;
            let char_uuid = required_string(&arguments, "charUuid")?;
            let data = required_bytes(&arguments, "data")?;
            let requested_write_type = requested_ble_write_type(&arguments)?;
            let manager = state.ble_manager.lock().await;
            let peripheral = manager.connections.get_peripheral(&device_id).await?;
            drop(manager);
            let cursor = state.recent_events.checkpoint().await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "tx", "ble")
                    .connection(device_id.clone())
                    .endpoint(json!({
                        "deviceId": device_id,
                        "serviceUuid": service_uuid,
                        "charUuid": char_uuid,
                    }))
                    .data(&data),
            );
            let actual_write_type = crate::ble::gatt::write_characteristic_resolved(
                &peripheral,
                &service_uuid,
                &char_uuid,
                &data,
                requested_write_type,
            )
            .await?;
            Ok(json!({
                "ok": true,
                "writeType": actual_write_type,
                "bytesWritten": data.len(),
                "endpoint": {
                    "deviceId": device_id,
                    "serviceUuid": service_uuid,
                    "charUuid": char_uuid,
                },
                "cursor": cursor,
            }))
        }
        "ble_subscribe_notifications" => {
            let device_id = required_string(&arguments, "deviceId")?;
            let service_uuid = required_string(&arguments, "serviceUuid")?;
            let char_uuid = required_string(&arguments, "charUuid")?;
            let ready = crate::commands::ble::subscribe_ble_notification_consumer(
                state,
                app_handle.clone(),
                &device_id,
                &service_uuid,
                &char_uuid,
                NotificationConsumer::Mcp(format!("ble:{}", uuid::Uuid::new_v4())),
            )
            .await?;
            Ok(json!({
                "ok": true,
                "ready": ready.ready,
                "cursor": ready.cursor,
                "currentCursor": ready.current_cursor,
                "subscriptionId": ready.subscription_id,
            }))
        }
        "ble_unsubscribe_notifications" => {
            if let Some(subscription_id) = optional_non_empty_string(&arguments, "subscriptionId")?
            {
                crate::commands::ble::unsubscribe_ble_notification_subscription(
                    state,
                    &subscription_id,
                )
                .await?;
            } else {
                let device_id = required_string(&arguments, "deviceId")?;
                let service_uuid = required_string(&arguments, "serviceUuid")?;
                let char_uuid = required_string(&arguments, "charUuid")?;
                crate::commands::ble::unsubscribe_ble_notification_mcp_endpoint(
                    state,
                    &device_id,
                    &service_uuid,
                    &char_uuid,
                )
                .await?;
            }
            Ok(json!({ "ok": true }))
        }
        "event_checkpoint" => Ok(json!({ "cursor": state.recent_events.checkpoint().await })),
        "ble_wait_notification" => {
            let request: BleWaitNotificationArgs =
                serde_json::from_value(arguments).map_err(AppError::Serde)?;
            let result = state
                .recent_events
                .wait_after(
                    request.after_cursor,
                    Duration::from_millis(request.timeout_ms.min(120_000)),
                    |event| {
                        ble_notification_event_matches(
                            event,
                            &request.device_id,
                            &request.service_uuid,
                            &request.char_uuid,
                        ) || ble_disconnect_event_matches(event, &request.device_id)
                    },
                )
                .await;
            Ok(format_ble_notification_wait_result(result))
        }
        "ble_get_notifications_data" => {
            let request: GetBleNotificationsDataArgs =
                serde_json::from_value(arguments).map_err(AppError::Serde)?;
            let notifications = select_ble_notifications_from_events(
                &state.recent_events.list(None).await,
                current_timestamp_ms(),
                request.seconds,
                request.count,
            )?;
            let count = notifications.len();
            Ok(json!({
                "notifications": notifications,
                "count": count,
            }))
        }
        "serial_list_ports" => Ok(json!({ "ports": list_ports() })),
        "serial_open_port" => {
            let config: SerialConfig = required_value(&arguments, "config")?;
            let channel_id = required_string(&arguments, "channelId")?;
            let manager = state.serial_manager.lock().await;
            let connection_id = manager.io.open(&config, app_handle.clone()).await?;
            drop(manager);
            state
                .channel_registry
                .register(
                    channel_id.clone(),
                    crate::channel_registry::ChannelBinding {
                        channel_type: "serial".to_string(),
                        connection_id: connection_id.clone(),
                        target_addr: None,
                    },
                )
                .await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "connected", "serial")
                    .channel(channel_id)
                    .connection(connection_id.clone())
                    .endpoint(json!({ "serialPath": config.path })),
            );
            Ok(json!({ "connectionId": connection_id }))
        }
        "serial_close_port" => {
            let connection_id = required_string(&arguments, "connectionId")?;
            let manager = state.serial_manager.lock().await;
            manager.io.close(&connection_id).await?;
            drop(manager);
            state
                .channel_registry
                .unregister_connection(&connection_id)
                .await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "disconnected", "serial")
                    .connection(connection_id.clone()),
            );
            Ok(json!({ "ok": true }))
        }
        "serial_send_data" => {
            let connection_id = required_string(&arguments, "connectionId")?;
            let data = required_bytes(&arguments, "data")?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "tx", "serial")
                    .connection(connection_id.clone())
                    .data(&data),
            );
            let manager = state.serial_manager.lock().await;
            let bytes_written = manager.io.send(&connection_id, &data).await?;
            Ok(json!({ "bytesWritten": bytes_written }))
        }
        "serial_receive_data" => {
            let connection_id = required_string(&arguments, "connectionId")?;
            let manager = state.serial_manager.lock().await;
            let data = manager.io.receive(&connection_id, 4096).await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "rx", "serial")
                    .connection(connection_id.clone())
                    .data(&data),
            );
            Ok(json!({ "data": data }))
        }
        "serial_get_connections" => {
            let manager = state.serial_manager.lock().await;
            let connections = manager.io.list_open().await;
            Ok(json!({ "connections": connections }))
        }
        "tcp_connect" => {
            let addr = required_string(&arguments, "addr")?;
            let channel_id = required_string(&arguments, "channelId")?;
            let manager = state.network_manager.lock().await;
            let connection_id = manager
                .tcp_client
                .connect(&addr, app_handle.clone())
                .await?;
            drop(manager);
            state
                .channel_registry
                .register(
                    channel_id.clone(),
                    crate::channel_registry::ChannelBinding {
                        channel_type: "tcp-client".to_string(),
                        connection_id: connection_id.clone(),
                        target_addr: None,
                    },
                )
                .await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "connected", "tcp-client")
                    .channel(channel_id)
                    .connection(connection_id.clone())
                    .endpoint(json!({ "address": addr })),
            );
            Ok(json!({ "connectionId": connection_id }))
        }
        "tcp_disconnect" => {
            let connection_id = required_string(&arguments, "connectionId")?;
            let manager = state.network_manager.lock().await;
            manager.tcp_client.disconnect(&connection_id).await?;
            drop(manager);
            state
                .channel_registry
                .unregister_connection(&connection_id)
                .await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "disconnected", "tcp-client")
                    .connection(connection_id.clone()),
            );
            Ok(json!({ "ok": true }))
        }
        "tcp_send" => {
            let connection_id = required_string(&arguments, "connectionId")?;
            let data = required_bytes(&arguments, "data")?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "tx", "tcp-client")
                    .connection(connection_id.clone())
                    .data(&data),
            );
            let manager = state.network_manager.lock().await;
            let bytes_written = manager.tcp_client.send(&connection_id, &data).await?;
            Ok(json!({ "bytesWritten": bytes_written }))
        }
        "tcp_receive" => Ok(json!({ "data": [] })),
        "tcp_list_connections" => {
            let manager = state.network_manager.lock().await;
            let connections = manager
                .tcp_client
                .list_connections()
                .await
                .into_iter()
                .map(|(id, addr)| json!({ "id": id, "addr": addr }))
                .collect::<Vec<Value>>();
            Ok(json!({ "connections": connections }))
        }
        "tcp_server_start" => {
            let addr = required_string(&arguments, "addr")?;
            let manager = state.network_manager.lock().await;
            let bound_addr = manager
                .tcp_server
                .start_listening(&addr, app_handle.clone())
                .await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "connected", "tcp-server")
                    .connection(format!("server:{bound_addr}"))
                    .endpoint(json!({ "address": addr, "localAddress": bound_addr })),
            );
            Ok(json!({ "addr": bound_addr }))
        }
        "tcp_server_stop" => {
            let manager = state.network_manager.lock().await;
            manager.tcp_server.stop_listening(&app_handle).await?;
            drop(manager);
            state.channel_registry.unregister_type("tcp-server").await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "disconnected", "tcp-server"),
            );
            Ok(json!({ "ok": true }))
        }
        "tcp_server_accept" => Err(AppError::Tcp(
            "Auto-accept is enabled. Clients are accepted automatically when server starts."
                .to_string(),
        )),
        "tcp_server_send" => {
            let client_id = required_string(&arguments, "clientId")?;
            let data = required_bytes(&arguments, "data")?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "tx", "tcp-server")
                    .connection(client_id.clone())
                    .data(&data),
            );
            let manager = state.network_manager.lock().await;
            let bytes_written = manager.tcp_server.send_to_client(&client_id, &data).await?;
            Ok(json!({ "bytesWritten": bytes_written }))
        }
        "tcp_server_receive" => Ok(json!({ "data": [] })),
        "tcp_server_disconnect_client" => {
            let client_id = required_string(&arguments, "clientId")?;
            let manager = state.network_manager.lock().await;
            manager.tcp_server.disconnect_client(&client_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tcp_server_list_clients" => {
            let manager = state.network_manager.lock().await;
            let clients = manager
                .tcp_server
                .list_clients()
                .await
                .into_iter()
                .map(|(id, addr)| json!({ "id": id, "addr": addr }))
                .collect::<Vec<Value>>();
            Ok(json!({ "clients": clients }))
        }
        "udp_bind" => {
            let addr = required_string(&arguments, "addr")?;
            let manager = state.network_manager.lock().await;
            let bound_addr = manager.udp.bind(&addr, app_handle.clone()).await?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "connected", "udp")
                    .connection(format!("udp:{bound_addr}"))
                    .endpoint(json!({ "address": addr, "localAddress": bound_addr })),
            );
            Ok(json!({ "addr": bound_addr }))
        }
        "udp_unbind" => {
            let manager = state.network_manager.lock().await;
            manager.udp.unbind().await?;
            drop(manager);
            state.channel_registry.unregister_type("udp").await;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "disconnected", "udp"),
            );
            Ok(json!({ "ok": true }))
        }
        "udp_send" => {
            let addr = required_string(&arguments, "addr")?;
            let data = required_bytes(&arguments, "data")?;
            emit_channel_activity(
                &app_handle,
                ChannelActivityEvent::new(context.as_ref(), "tx", "udp")
                    .endpoint(json!({ "remoteAddress": addr }))
                    .data(&data),
            );
            let manager = state.network_manager.lock().await;
            let bytes_written = manager.udp.send_to(&addr, &data).await?;
            Ok(json!({ "bytesWritten": bytes_written }))
        }
        "udp_receive" => Ok(json!({ "data": [], "addr": "" })),
        "protocol_parse_data" => {
            let data = required_bytes(&arguments, "data")?;
            let manager = state.protocol_manager.lock().await;
            let result = manager.parse(&data)?;
            Ok(json!({ "result": result }))
        }
        "protocol_set_parser_mode" => {
            let mode: ParserMode = required_value(&arguments, "mode")?;
            let mut manager = state.protocol_manager.lock().await;
            manager.set_mode(mode);
            Ok(json!({ "ok": true }))
        }
        "protocol_get_parser_mode" => {
            let manager = state.protocol_manager.lock().await;
            Ok(json!({ "mode": manager.current_mode }))
        }
        "protocol_set_field_definitions" => {
            let fields: Vec<FieldDefinition> = required_value(&arguments, "fields")?;
            let mut manager = state.protocol_manager.lock().await;
            manager.set_field_definitions(fields);
            Ok(json!({ "ok": true }))
        }
        "protocol_get_field_definitions" => {
            let manager = state.protocol_manager.lock().await;
            Ok(json!({ "fields": manager.get_field_definitions() }))
        }
        "protocol_load_lua_script" => {
            let script = required_string(&arguments, "script")?;
            let mut manager = state.protocol_manager.lock().await;
            manager.load_lua_script(&script)?;
            Ok(json!({ "ok": true }))
        }
        "protocol_validate_lua_script" => {
            let script = required_string(&arguments, "script")?;
            LuaEngine::validate_script(&script)?;
            Ok(json!({ "ok": true }))
        }
        "protocol_get_templates" => {
            Ok(json!({ "templates": crate::protocol::ProtocolManager::get_templates() }))
        }
        "protocol_apply_template" => {
            let template_id = required_string(&arguments, "templateId")?;
            let mut manager = state.protocol_manager.lock().await;
            manager.apply_template(&template_id)?;
            Ok(json!({ "ok": true }))
        }
        "protocol_get_lua_file_summary" => {
            let file_path = crate::snapshot::resolve_path(&required_string(&arguments, "filePath")?);
            let resource_root = arguments
                .get("resourceRoot")
                .and_then(Value::as_str)
                .map(crate::snapshot::resolve_path)
                .map(PathBuf::from);
            let summary = crate::protocol::ProtocolManager::get_lua_protocol_file_summary(
                PathBuf::from(file_path),
                resource_root,
            )?;
            Ok(json!({ "summary": summary }))
        }
        "protocol_parse_data_with_lua_file" => {
            let file_path = crate::snapshot::resolve_path(&required_string(&arguments, "filePath")?);
            let resource_root = arguments
                .get("resourceRoot")
                .and_then(Value::as_str)
                .map(crate::snapshot::resolve_path)
                .map(PathBuf::from);
            let data = required_bytes(&arguments, "data")?;
            let result = crate::protocol::ProtocolManager::parse_data_with_lua_file(
                PathBuf::from(file_path),
                resource_root,
                &data,
            )?;
            Ok(json!({ "result": result }))
        }
        "protocol_encode_transaction_with_lua_file" => {
            let file_path = crate::snapshot::resolve_path(&required_string(&arguments, "filePath")?);
            let resource_root = arguments
                .get("resourceRoot")
                .and_then(Value::as_str)
                .map(crate::snapshot::resolve_path)
                .map(PathBuf::from);
            let transaction_id = required_string(&arguments, "transactionId")?;
            let values_json = match arguments.get("values") {
                Some(Value::Null) | None => "{}".to_string(),
                Some(value) => serde_json::to_string(value).map_err(AppError::Serde)?,
            };
            let result = crate::protocol::ProtocolManager::encode_transaction_with_lua_file(
                PathBuf::from(file_path),
                resource_root,
                &transaction_id,
                &values_json,
            )?;
            Ok(json!({ "result": result }))
        }
        "protocol_match_transaction_response_with_lua_file" => {
            let file_path = crate::snapshot::resolve_path(&required_string(&arguments, "filePath")?);
            let resource_root = arguments
                .get("resourceRoot")
                .and_then(Value::as_str)
                .map(crate::snapshot::resolve_path)
                .map(PathBuf::from);
            let transaction_id = required_string(&arguments, "transactionId")?;
            let data = required_bytes(&arguments, "data")?;
            let result =
                crate::protocol::ProtocolManager::match_transaction_response_with_lua_file(
                    PathBuf::from(file_path),
                    resource_root,
                    &transaction_id,
                    &data,
                )?;
            Ok(json!({ "result": result }))
        }
        "protocol_execute_transaction_with_lua_file" => {
            let request: ProtocolTransactionRequestArgs =
                serde_json::from_value(arguments).map_err(AppError::Serde)?;
            execute_protocol_transaction_with_lua_file(state, app_handle, request, context.as_ref())
                .await
        }
        "save_app_config" => {
            let config: AppConfig = required_value(&arguments, "config")?;
            save_config(&app_handle, &config).map_err(AppError::Protocol)?;
            Ok(json!({ "ok": true }))
        }
        "load_app_config" => {
            let config = load_config(&app_handle).map_err(AppError::Protocol)?;
            Ok(json!({ "config": config }))
        }
        "export_to_file" => {
            let path = required_string(&arguments, "path")?;
            let content = required_string(&arguments, "content")?;
            tokio::fs::write(&path, content.as_bytes()).await?;
            Ok(json!({ "ok": true }))
        }
        "import_from_file" => {
            let path = crate::snapshot::resolve_path(&required_string(&arguments, "path")?);
            // Reading as UTF-8 is the historical behaviour and stays the default. Binary payloads
            // (firmware images, captures) are not text and would fail that decode, so callers can
            // ask for base64 instead of resorting to a hex sidecar file.
            match optional_non_empty_string(&arguments, "encoding")?.as_deref() {
                None | Some("utf8") => {
                    let content = tokio::fs::read_to_string(&path).await?;
                    Ok(json!({ "content": content, "encoding": "utf8" }))
                }
                Some("base64") => {
                    use base64::Engine as _;
                    let bytes = tokio::fs::read(&path).await?;
                    let byte_length = bytes.len();
                    let content = base64::engine::general_purpose::STANDARD.encode(bytes);
                    Ok(
                        json!({ "content": content, "encoding": "base64", "byteLength": byte_length }),
                    )
                }
                Some(other) => Err(AppError::Protocol(format!(
                    "import_from_file encoding must be 'utf8' or 'base64', got '{}'",
                    other
                ))),
            }
        }
        "get_recent_events" => {
            let events = state.recent_events.list(None).await;
            Ok(json!({ "events": events }))
        }
        _ => {
            let config = load_config(&app_handle).map_err(AppError::Protocol)?;
            let active_channel_id = config.ui.active_channel_id.clone();
            if let Some(script) = find_exposed_script(&config, name)? {
                crate::mcp_tool_script::execute_mcp_tool_script_with_context(
                    state,
                    Some(app_handle),
                    &script,
                    arguments,
                    active_channel_id,
                    context,
                )
                .await
            } else {
                Err(AppError::Protocol(format!("Unknown MCP tool: {}", name)))
            }
        }
    }
}

async fn execute_protocol_transaction_with_lua_file(
    state: &AppState,
    app_handle: AppHandle,
    request: ProtocolTransactionRequestArgs,
    context: Option<&ToolInvocationContext>,
) -> AppResult<Value> {
    if !(100..=120_000).contains(&request.timeout_ms) {
        return Err(AppError::Protocol(
            "protocol transaction timeoutMs must be between 100 and 120000".to_string(),
        ));
    }
    if !request.values.is_object() {
        return Err(AppError::Protocol(
            "protocol transaction values must be an object".to_string(),
        ));
    }

    let file_path = PathBuf::from(crate::snapshot::resolve_path(&request.file_path));
    let resource_root = request
        .resource_root
        .as_deref()
        .map(crate::snapshot::resolve_path)
        .map(PathBuf::from);
    let values_json = serde_json::to_string(&request.values).map_err(AppError::Serde)?;
    let encoded = crate::protocol::ProtocolManager::encode_transaction_with_lua_file(
        file_path.clone(),
        resource_root.clone(),
        &request.transaction_id,
        &values_json,
    )?;
    let service_uuid = encoded
        .service_uuid
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Protocol(format!(
                "transaction '{}' did not resolve a service UUID",
                request.transaction_id
            ))
        })?;
    let char_uuid = encoded
        .characteristic_uuid
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Protocol(format!(
                "transaction '{}' did not resolve a characteristic UUID",
                request.transaction_id
            ))
        })?;
    let requested_write_type = serde_json::from_value::<BleWriteType>(Value::String(
        encoded
            .write_type
            .clone()
            .unwrap_or_else(|| "withResponse".to_string()),
    ))
    .map_err(AppError::Serde)?;
    let subscription_id = format!("protocol-transaction:{}", uuid::Uuid::new_v4());
    let ready = crate::commands::ble::subscribe_ble_notification_consumer(
        state,
        app_handle.clone(),
        &request.device_id,
        &service_uuid,
        &char_uuid,
        NotificationConsumer::Mcp(subscription_id.clone()),
    )
    .await?;
    if !ready.ready {
        let _ = crate::commands::ble::unsubscribe_ble_notification_subscription(
            state,
            &subscription_id,
        )
        .await;
        return Err(AppError::Protocol(
            "protocol transaction notification subscription did not become ready".to_string(),
        ));
    }

    let execution = async {
        let cursor = state.recent_events.checkpoint().await;
        let manager = state.ble_manager.lock().await;
        let peripheral = manager
            .connections
            .get_peripheral(&request.device_id)
            .await?;
        drop(manager);
        emit_channel_activity(
            &app_handle,
            ChannelActivityEvent::new(context, "tx", "ble")
                .connection(request.device_id.clone())
                .endpoint(json!({
                    "deviceId": request.device_id,
                    "serviceUuid": service_uuid,
                    "charUuid": char_uuid,
                }))
                .data(&encoded.bytes)
                .protocol(json!({
                    "transactionId": request.transaction_id,
                    "status": "running",
                })),
        );
        let actual_write_type = crate::ble::gatt::write_characteristic_resolved(
            &peripheral,
            &service_uuid,
            &char_uuid,
            &encoded.bytes,
            requested_write_type,
        )
        .await?;

        let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
        let mut after_cursor = cursor;
        let mut skipped = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(AppError::Protocol(format!(
                    "transaction '{}' timed out after {} ms ({} unmatched notifications)",
                    request.transaction_id,
                    request.timeout_ms,
                    skipped.len()
                )));
            }
            let waited = state
                .recent_events
                .wait_after(after_cursor, remaining, |event| {
                    ble_notification_event_matches(
                        event,
                        &request.device_id,
                        &service_uuid,
                        &char_uuid,
                    ) || ble_disconnect_event_matches(event, &request.device_id)
                })
                .await;
            if waited.future_cursor {
                return Err(AppError::Protocol(
                    "protocol transaction event cursor is ahead of Core state".to_string(),
                ));
            }
            if waited.overflowed {
                return Err(AppError::Protocol(
                    "protocol transaction event cursor overflowed before a response matched"
                        .to_string(),
                ));
            }
            if waited.events.is_empty() {
                return Err(AppError::Protocol(format!(
                    "transaction '{}' timed out after {} ms ({} unmatched notifications)",
                    request.transaction_id,
                    request.timeout_ms,
                    skipped.len()
                )));
            }

            for event in waited.events {
                after_cursor = event.cursor;
                if event.name == "ble-connection-closed" {
                    return Err(AppError::Protocol(format!(
                        "device '{}' disconnected while waiting for transaction '{}'",
                        request.device_id, request.transaction_id
                    )));
                }
                let notification: BleNotificationEvent =
                    serde_json::from_value(event.payload).map_err(AppError::Serde)?;
                let matched =
                    crate::protocol::ProtocolManager::match_transaction_response_with_lua_file(
                        file_path.clone(),
                        resource_root.clone(),
                        &request.transaction_id,
                        &notification.data,
                    )?;
                if !matched.matched {
                    skipped.push(json!({
                        "cursor": event.cursor,
                        "reason": matched.reason,
                        "data": notification.data,
                    }));
                    continue;
                }
                let parsed = crate::protocol::ProtocolManager::parse_data_with_lua_file(
                    file_path.clone(),
                    resource_root.clone(),
                    &notification.data,
                )?;
                if request.strict && !parsed.remaining_bytes.is_empty() {
                    return Err(AppError::Protocol(format!(
                        "transaction '{}' parsed with {} remaining bytes",
                        request.transaction_id,
                        parsed.remaining_bytes.len()
                    )));
                }
                let diagnostic_count = parsed
                    .data_groups
                    .iter()
                    .filter(|group| group.name == "Diagnostics")
                    .map(|group| group.fields.len())
                    .sum::<usize>();
                if request.strict && diagnostic_count > 0 {
                    return Err(AppError::Protocol(format!(
                        "transaction '{}' parsed with {} diagnostic field(s)",
                        request.transaction_id, diagnostic_count
                    )));
                }
                emit_channel_activity(
                    &app_handle,
                    ChannelActivityEvent::new(context, "protocol", "ble")
                        .connection(request.device_id.clone())
                        .endpoint(json!({
                            "deviceId": request.device_id,
                            "serviceUuid": service_uuid,
                            "charUuid": char_uuid,
                        }))
                        .text(format!("Transaction {} passed", request.transaction_id))
                        .protocol(json!({
                            "transactionId": request.transaction_id,
                            "status": "passed",
                            "parsed": &parsed,
                            "matched": &matched,
                        })),
                );
                return Ok(json!({
                    "result": {
                        "transactionId": request.transaction_id,
                        "encoded": encoded,
                        "writeType": actual_write_type,
                        "requestCursor": cursor,
                        "responseCursor": event.cursor,
                        "responseData": notification.data,
                        "match": matched,
                        "parsed": parsed,
                        "skipped": skipped,
                    }
                }));
            }
        }
    }
    .await;

    let cleanup =
        crate::commands::ble::unsubscribe_ble_notification_subscription(state, &subscription_id)
            .await;
    match (execution, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup_error)) => Err(AppError::Protocol(format!(
            "protocol transaction succeeded but subscription cleanup failed: {}",
            cleanup_error
        ))),
        (Err(error), Err(cleanup_error)) => Err(AppError::Protocol(format!(
            "{}; subscription cleanup also failed: {}",
            error, cleanup_error
        ))),
    }
}

fn tool(name: &str, description: &str, input_schema: Value) -> McpToolDefinition {
    McpToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
    }
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn default_use_current_channel() -> bool {
    true
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

fn bytes_schema() -> Value {
    json!({ "type": "array", "items": { "type": "integer", "minimum": 0, "maximum": 255 } })
}

fn required_value<T>(arguments: &Value, key: &str) -> AppResult<T>
where
    T: for<'de> Deserialize<'de>,
{
    let value = arguments
        .get(key)
        .ok_or_else(|| AppError::Protocol(format!("Missing required argument: {}", key)))?;
    serde_json::from_value(value.clone()).map_err(AppError::Serde)
}

fn required_string(arguments: &Value, key: &str) -> AppResult<String> {
    required_value(arguments, key)
}

fn optional_non_empty_string(arguments: &Value, key: &str) -> AppResult<Option<String>> {
    match arguments.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(value) => serde_json::from_value::<String>(value.clone())
            .map(|value| {
                let value = value.trim().to_string();
                (!value.is_empty()).then_some(value)
            })
            .map_err(AppError::Serde),
    }
}

fn ble_device_matches_name_keyword(device: &BleDevice, keyword: &str) -> bool {
    let keyword = keyword.to_lowercase();

    device
        .name
        .as_deref()
        .is_some_and(|name| name.to_lowercase().contains(&keyword))
        || device
            .advertisement_name
            .as_deref()
            .is_some_and(|name| name.to_lowercase().contains(&keyword))
}

fn ble_device_matches_exact_name(device: &BleDevice, exact_name: &str) -> bool {
    device.name.as_deref() == Some(exact_name)
        || device.advertisement_name.as_deref() == Some(exact_name)
}

fn filter_ble_devices(devices: Vec<BleDevice>, request: &GetBleDevicesArgs) -> Vec<BleDevice> {
    let name_keyword = request
        .name_keyword
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let exact_name = request
        .exact_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = request.limit.unwrap_or(usize::MAX);

    devices
        .into_iter()
        .filter(|device| {
            name_keyword
                .map(|keyword| ble_device_matches_name_keyword(device, keyword))
                .unwrap_or(true)
        })
        .filter(|device| {
            exact_name
                .map(|name| ble_device_matches_exact_name(device, name))
                .unwrap_or(true)
        })
        .filter(|device| !request.connectable_only || device.is_connectable)
        .take(limit)
        .collect()
}

fn ble_notification_event_matches(
    event: &CoreEvent,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
) -> bool {
    if event.name != "ble-notification-received" {
        return false;
    }
    serde_json::from_value::<BleNotificationEvent>(event.payload.clone())
        .map(|notification| {
            notification.device_id == device_id
                && notification.service_uuid.eq_ignore_ascii_case(service_uuid)
                && notification.char_uuid.eq_ignore_ascii_case(char_uuid)
        })
        .unwrap_or(false)
}

fn ble_disconnect_event_matches(event: &CoreEvent, device_id: &str) -> bool {
    event.name == "ble-connection-closed"
        && event
            .payload
            .get("deviceId")
            .and_then(Value::as_str)
            .is_some_and(|event_device_id| event_device_id == device_id)
}

fn format_ble_notification_wait_result(result: EventWaitResult) -> Value {
    let common = json!({
        "currentCursor": result.current_cursor,
        "oldestCursor": result.oldest_cursor,
        "overflow": result.overflowed,
        "futureCursor": result.future_cursor,
        "timedOut": result.timed_out,
    });

    let status = if result.future_cursor {
        "futureCursor"
    } else if result.overflowed {
        "overflow"
    } else if result
        .events
        .first()
        .is_some_and(|event| event.name == "ble-connection-closed")
    {
        "disconnected"
    } else if result.events.is_empty() {
        "timeout"
    } else {
        "notification"
    };

    let mut response = common;
    if let Some(object) = response.as_object_mut() {
        object.insert("status".to_string(), json!(status));
        object.insert("disconnected".to_string(), json!(status == "disconnected"));
        if let Some(event) = result.events.first() {
            object.insert("cursor".to_string(), json!(event.cursor));
            if event.name == "ble-notification-received" {
                object.insert("notification".to_string(), event.payload.clone());
                if let Some(data) = event.payload.get("data") {
                    object.insert("data".to_string(), data.clone());
                }
            }
        }
    }
    response
}

fn select_ble_notifications_from_events(
    events: &[CoreEvent],
    now_ms: u64,
    seconds: Option<u64>,
    count: Option<usize>,
) -> AppResult<Vec<BleNotificationEvent>> {
    if seconds.is_some() && count.is_some() {
        return Err(AppError::Protocol(
            "Provide either 'seconds' or 'count' for ble_get_notifications_data, not both."
                .to_string(),
        ));
    }

    let mut notifications = events
        .iter()
        .filter(|event| event.name == "ble-notification-received")
        .map(|event| serde_json::from_value::<BleNotificationEvent>(event.payload.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::Serde)?;

    if let Some(seconds) = seconds {
        let threshold = now_ms.saturating_sub(seconds.saturating_mul(1000));
        notifications.retain(|event| event.timestamp >= threshold);
        return Ok(notifications);
    }

    if let Some(count) = count {
        let skip = notifications.len().saturating_sub(count);
        return Ok(notifications.into_iter().skip(skip).collect());
    }

    Ok(notifications
        .into_iter()
        .rev()
        .take(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect())
}

fn required_bytes(arguments: &Value, key: &str) -> AppResult<Vec<u8>> {
    let values: Vec<u64> = required_value(arguments, key)?;
    values
        .into_iter()
        .map(|value| {
            u8::try_from(value).map_err(|_| {
                AppError::Protocol(format!("Argument '{}' contains byte outside 0..=255", key))
            })
        })
        .collect()
}

fn requested_ble_write_type(arguments: &Value) -> AppResult<BleWriteType> {
    match arguments.get("writeType") {
        Some(Value::Null) | None => Ok(BleWriteType::WithResponse),
        Some(value) => serde_json::from_value(value.clone()).map_err(AppError::Serde),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{AppConfig, UiConfig};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn config_with_scripts(scripts: Vec<McpToolScript>) -> AppConfig {
        AppConfig {
            ui: UiConfig::default(),
            mcp_tools: Some(
                serde_json::to_value(McpToolsConfig {
                    enabled: true,
                    scripts,
                })
                .expect("test MCP tools config should serialize"),
            ),
            ..AppConfig::default()
        }
    }

    #[test]
    fn global_mcp_state_defaults_on_and_preserves_scripts_when_changed() {
        let mut config = AppConfig {
            mcp_tools: Some(json!({ "scripts": [{
                "id": "configured",
                "exposeToMcp": false,
                "luaPath": "D:/tools/configured.lua"
            }] })),
            ..AppConfig::default()
        };

        assert!(mcp_tools_enabled(&config).unwrap());
        set_mcp_tools_enabled(&mut config, false).unwrap();

        let saved = mcp_tools_config(&config).unwrap().unwrap();
        assert!(!saved.enabled);
        assert_eq!(saved.scripts.len(), 1);
        assert_eq!(saved.scripts[0].id, "configured");
    }

    fn unique_tool_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("linkassist_{}_{}.lua", name, stamp))
    }

    fn write_tool_file(name: &str, script_name: &str, description: &str) -> String {
        let path = unique_tool_path(name);
        let content = format!(
            "-- linkassist:type = mcp\nfunction mcp_meta()\n  return {{\n    name = \"{script_name}\",\n    description = \"{description}\",\n    input_schema = {{ type = \"object\", properties = {{}} }}\n  }}\nend\n\nfunction call(args)\n  return {{ ok = true }}\nend\n"
        );
        fs::write(&path, content).expect("test Lua tool file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_multi_tool_file(name: &str, tools: &[(&str, &str)]) -> String {
        let path = unique_tool_path(name);
        let entries = tools
            .iter()
            .map(|(tool_name, description)| {
                format!(
                    "    {{ name = \"{tool_name}\", description = \"{description}\", input_schema = {{ type = \"object\", properties = {{}} }} }}"
                )
            })
            .collect::<Vec<_>>()
            .join(",\n");
        let content = format!(
            "-- linkassist:type = mcp\nfunction mcp_tools()\n  return {{\n{entries}\n  }}\nend\n\nfunction call(tool_name, args)\n  return {{ ok = true, tool = tool_name }}\nend\n"
        );
        fs::write(&path, content).expect("test multi-tool Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_non_mcp_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = protocol\nfunction schema() return {} end\nfunction parse() return {} end\n";
        fs::write(&path, content).expect("test Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn script(id: &str, name: &str, expose_to_mcp: bool) -> McpToolScript {
        McpToolScript {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("Tool {name}"),
            expose_to_mcp,
            source_type: McpToolScriptSourceType::File,
            inline_lua: String::new(),
            lua_path: Some(write_tool_file(id, name, &format!("Tool {name}"))),
            input_schema: empty_schema(),
            use_current_channel: true,
            target_channel_id: None,
            protocol_file: None,
            protocol_resource_root: None,
        }
    }

    #[test]
    fn valid_user_tool_names_accept_safe_ascii_patterns() {
        assert!(is_valid_user_tool_name("tool_1"));
        assert!(is_valid_user_tool_name("tool-name.v2"));
        assert!(is_valid_user_tool_name(&"a".repeat(128)));
    }

    #[test]
    fn valid_user_tool_names_reject_invalid_patterns() {
        assert!(!is_valid_user_tool_name(""));
        assert!(!is_valid_user_tool_name(" tool"));
        assert!(!is_valid_user_tool_name("tool "));
        assert!(!is_valid_user_tool_name("tool name"));
        assert!(!is_valid_user_tool_name("tool/name"));
        assert!(!is_valid_user_tool_name("工具"));
        assert!(!is_valid_user_tool_name(&"a".repeat(129)));
    }

    #[test]
    fn exposed_script_tools_skip_invalid_hidden_and_builtin_collisions() {
        let mut invalid_path = script("invalid-path", "invalid_path_tool", true);
        invalid_path.lua_path = Some("C:/scripts/example.lua".to_string());

        let mut inline = script("inline", "inline_tool", true);
        inline.source_type = McpToolScriptSourceType::Inline;

        let mut missing_meta_name = script("missing-meta-name", "unused_name", true);
        missing_meta_name.lua_path = Some(write_tool_file(
            "missing_meta_name",
            "bad name",
            "Bad metadata",
        ));

        let config = config_with_scripts(vec![
            script("custom", "custom_tool", true),
            script("builtin-collision", "greet", true),
            script("hidden", "hidden_tool", false),
            script("invalid-name", "bad name", true),
            invalid_path,
            inline,
            missing_meta_name,
        ]);

        let names = exposed_script_tools(&config)
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["custom_tool"]);
    }

    #[test]
    fn exposed_script_tools_keep_first_valid_duplicate_name() {
        let first = script("first", "shared_name", true);
        let mut second = script("second", "shared_name", true);
        second.description = "Second description".to_string();

        let config = config_with_scripts(vec![first, second]);
        let definitions = exposed_script_tools(&config);

        assert_eq!(definitions.len(), 1);
        assert_eq!(definitions[0].name, "shared_name");
        assert_eq!(definitions[0].description, "Tool shared_name");
    }

    #[test]
    fn exposed_script_tools_expand_multiple_tools_from_one_script() {
        let mut multi = script("multi", "unused_name", true);
        multi.lua_path = Some(write_multi_tool_file(
            "multi_tools",
            &[("tool_alpha", "Alpha tool"), ("tool_beta", "Beta tool")],
        ));

        let names = exposed_script_tools(&config_with_scripts(vec![multi]))
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["tool_alpha", "tool_beta"]);
    }

    #[test]
    fn exposed_script_tools_filter_duplicate_multi_tool_names() {
        let mut first = script("first_multi", "unused_name", true);
        first.lua_path = Some(write_multi_tool_file(
            "first_multi",
            &[("shared_multi", "First"), ("unique_first", "Unique first")],
        ));
        let mut second = script("second_multi", "unused_name", true);
        second.lua_path = Some(write_multi_tool_file(
            "second_multi",
            &[
                ("shared_multi", "Second"),
                ("unique_second", "Unique second"),
            ],
        ));

        let names = exposed_script_tools(&config_with_scripts(vec![first, second]))
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["shared_multi", "unique_first", "unique_second"]);
    }

    #[test]
    fn find_exposed_script_uses_same_eligibility_rules_as_listing() {
        let mut first = script("first", "shared_name", true);
        first.protocol_file = Some("D:/support/protocol.lua".to_string());
        first.protocol_resource_root = Some("D:/project/schema".to_string());
        let mut second = script("second", "shared_name", true);
        second.description = "Second description".to_string();
        let mut invalid_path = script("invalid-path", "bad_path_tool", true);
        invalid_path.lua_path = Some("C:/scripts/bad.lua".to_string());
        let mut inline = script("inline", "inline_tool", true);
        inline.source_type = McpToolScriptSourceType::Inline;

        let config = config_with_scripts(vec![
            script("builtin-collision", "greet", true),
            script("invalid-name", "bad name", true),
            invalid_path,
            inline,
            first,
            second,
        ]);

        let found = find_exposed_script(&config, "shared_name")
            .expect("lookup should succeed")
            .expect("shared_name should resolve to first valid script");

        assert_eq!(found.script.id, "first");
        assert_eq!(
            found.script.protocol_file.as_deref(),
            Some("D:/support/protocol.lua")
        );
        assert_eq!(
            found.script.protocol_resource_root.as_deref(),
            Some("D:/project/schema")
        );
        assert!(find_exposed_script(&config, "greet")
            .expect("lookup should succeed")
            .is_none());
        assert!(find_exposed_script(&config, "bad name")
            .expect("lookup should succeed")
            .is_none());
        assert!(find_exposed_script(&config, "bad_path_tool")
            .expect("lookup should succeed")
            .is_none());
        assert!(find_exposed_script(&config, "inline_tool")
            .expect("lookup should succeed")
            .is_none());
    }

    #[test]
    fn tool_definitions_with_config_includes_builtin_and_valid_user_tools() {
        let config = config_with_scripts(vec![
            script("custom", "custom_tool", true),
            script("builtin-collision", "greet", true),
        ]);

        let names = tool_definitions_with_config(&config)
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();

        assert!(names.iter().any(|name| name == "greet"));
        assert!(names.iter().any(|name| name == "custom_tool"));
        assert_eq!(
            names.iter().filter(|name| name.as_str() == "greet").count(),
            1
        );
    }

    #[test]
    fn load_mcp_tool_meta_from_path_rejects_wrong_script_type_marker() {
        let path = write_non_mcp_file("wrong_kind");
        let error = load_mcp_tool_meta_from_path(&path)
            .expect_err("wrong script kind should fail")
            .to_string();

        assert!(error.contains("Expected Lua MCP tool file marker '-- linkassist:type = mcp'"));
        assert!(error.contains("-- linkassist:type = protocol"));
    }

    #[test]
    fn load_mcp_tool_meta_from_path_returns_multiple_tools_preview() {
        let path = write_multi_tool_file(
            "preview_multi",
            &[
                ("preview_alpha", "Preview alpha"),
                ("preview_beta", "Preview beta"),
            ],
        );
        let preview =
            load_mcp_tool_meta_from_path(&path).expect("multi-tool metadata preview should load");

        assert_eq!(preview.tools.len(), 2);
        assert_eq!(preview.tools[0].name, "preview_alpha");
        assert_eq!(preview.tools[1].name, "preview_beta");
    }

    #[test]
    fn builtin_tools_expose_cursor_wait_and_transaction_match_contracts() {
        let names = builtin_tool_definitions()
            .into_iter()
            .map(|definition| definition.name)
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "event_checkpoint"));
        assert!(names.iter().any(|name| name == "ble_wait_notification"));
        assert!(names
            .iter()
            .any(|name| name == "protocol_match_transaction_response_with_lua_file"));
        assert!(names
            .iter()
            .any(|name| name == "protocol_execute_transaction_with_lua_file"));
    }

    #[test]
    fn protocol_transaction_request_defaults_are_strict_and_bounded() {
        let request: ProtocolTransactionRequestArgs = serde_json::from_value(json!({
            "filePath": "D:/protocol.lua",
            "deviceId": "device-1",
            "transactionId": "protocol.read"
        }))
        .expect("request should deserialize");

        assert_eq!(request.values, json!({}));
        assert_eq!(request.timeout_ms, 5_000);
        assert!(request.strict);
    }

    #[test]
    fn omitted_write_type_preserves_with_response_compatibility() {
        assert_eq!(
            requested_ble_write_type(&json!({})).expect("default should parse"),
            BleWriteType::WithResponse,
        );
        assert_eq!(
            requested_ble_write_type(&json!({ "writeType": "auto" })).expect("auto should parse"),
            BleWriteType::Auto,
        );
    }

    fn ble_device(id: &str, name: &str, is_connectable: bool) -> BleDevice {
        BleDevice {
            id: id.to_string(),
            name: Some(name.to_string()),
            rssi: None,
            service_uuids: Vec::new(),
            is_connected: false,
            manufacturer_data: std::collections::HashMap::new(),
            is_connectable,
            service_data: std::collections::HashMap::new(),
            tx_power_level: None,
            address_type: None,
            class: None,
            appearance: None,
            advertisement_name: None,
        }
    }

    #[test]
    fn device_filter_supports_exact_connectable_bounded_results() {
        let request = GetBleDevicesArgs {
            exact_name: Some("target".to_string()),
            connectable_only: true,
            limit: Some(1),
            ..GetBleDevicesArgs::default()
        };
        let devices = filter_ble_devices(
            vec![
                ble_device("not-connectable", "target", false),
                ble_device("match", "target", true),
                ble_device("other", "other", true),
            ],
            &request,
        );
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].id, "match");
    }

    #[test]
    fn notification_wait_result_distinguishes_terminal_states() {
        let notification = format_ble_notification_wait_result(EventWaitResult {
            events: vec![notification_event(3, &[0xAA, 0x55])],
            current_cursor: 3,
            oldest_cursor: Some(1),
            overflowed: false,
            future_cursor: false,
            timed_out: false,
        });
        assert_eq!(notification["status"], "notification");
        assert_eq!(notification["cursor"], 3);
        assert_eq!(notification["data"], json!([0xAA, 0x55]));

        let disconnected = format_ble_notification_wait_result(EventWaitResult {
            events: vec![CoreEvent {
                cursor: 4,
                name: "ble-connection-closed".to_string(),
                timestamp: 1,
                payload: json!({ "deviceId": "device-1" }),
            }],
            current_cursor: 4,
            oldest_cursor: Some(1),
            overflowed: false,
            future_cursor: false,
            timed_out: false,
        });
        assert_eq!(disconnected["status"], "disconnected");

        let future = format_ble_notification_wait_result(EventWaitResult {
            events: Vec::new(),
            current_cursor: 4,
            oldest_cursor: Some(1),
            overflowed: false,
            future_cursor: true,
            timed_out: false,
        });
        assert_eq!(future["status"], "futureCursor");

        let overflow = format_ble_notification_wait_result(EventWaitResult {
            events: Vec::new(),
            current_cursor: 400,
            oldest_cursor: Some(145),
            overflowed: true,
            future_cursor: false,
            timed_out: false,
        });
        assert_eq!(overflow["status"], "overflow");

        let timeout = format_ble_notification_wait_result(EventWaitResult {
            events: Vec::new(),
            current_cursor: 4,
            oldest_cursor: Some(1),
            overflowed: false,
            future_cursor: false,
            timed_out: true,
        });
        assert_eq!(timeout["status"], "timeout");
    }

    fn notification_event(timestamp: u64, data: &[u8]) -> CoreEvent {
        CoreEvent {
            cursor: timestamp,
            name: "ble-notification-received".to_string(),
            timestamp,
            payload: serde_json::to_value(BleNotificationEvent {
                device_id: "device-1".to_string(),
                service_uuid: "service-1".to_string(),
                char_uuid: "char-1".to_string(),
                data: data.to_vec(),
                timestamp,
            })
            .expect("notification event should serialize"),
        }
    }

    #[test]
    fn get_ble_notifications_data_defaults_to_latest_notification() {
        let notifications = select_ble_notifications_from_events(
            &[
                notification_event(1_000, &[1]),
                notification_event(2_000, &[2]),
            ],
            2_500,
            None,
            None,
        )
        .expect("latest notification lookup should succeed");

        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].timestamp, 2_000);
        assert_eq!(notifications[0].data, vec![2]);
    }

    #[test]
    fn get_ble_notifications_data_filters_by_recent_seconds() {
        let notifications = select_ble_notifications_from_events(
            &[
                notification_event(1_000, &[1]),
                notification_event(7_000, &[7]),
                notification_event(9_000, &[9]),
            ],
            10_000,
            Some(3),
            None,
        )
        .expect("seconds filter should succeed");

        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].timestamp, 7_000);
        assert_eq!(notifications[1].timestamp, 9_000);
    }

    #[test]
    fn get_ble_notifications_data_filters_by_recent_count() {
        let notifications = select_ble_notifications_from_events(
            &[
                notification_event(1_000, &[1]),
                notification_event(2_000, &[2]),
                notification_event(3_000, &[3]),
            ],
            3_500,
            None,
            Some(2),
        )
        .expect("count filter should succeed");

        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].data, vec![2]);
        assert_eq!(notifications[1].data, vec![3]);
    }

    #[test]
    fn get_ble_notifications_data_rejects_seconds_and_count_together() {
        let error = select_ble_notifications_from_events(
            &[notification_event(1_000, &[1])],
            2_000,
            Some(1),
            Some(1),
        )
        .expect_err("simultaneous seconds and count should be rejected")
        .to_string();

        assert!(error.contains("either 'seconds' or 'count'"));
    }
}
