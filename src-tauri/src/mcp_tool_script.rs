use crate::channel_activity::{emit_channel_activity, ChannelActivityEvent, ToolInvocationContext};
use crate::mcp_tools::{
    McpResolvedScriptTool, McpToolScript, McpToolScriptMeta, McpToolScriptSourceType,
};
use crate::protocol::lua_engine::{
    apply_memory_limit, arm_execution_limit, arm_execution_limit_with_cancellation,
};
use crate::script_markers::{ensure_lua_script_kind, LuaScriptKind};
use crate::{AppError, AppResult, AppState};
use mlua::{Function as LuaFunction, Lua, LuaSerdeExt, Table, Value as LuaValue};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tauri::AppHandle;
use tokio::runtime::Handle;

static SCRIPT_SESSION_STATE: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
static SCRIPT_EXCLUSIVE_GROUPS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct ScriptExclusivePermit {
    group: String,
}

impl Drop for ScriptExclusivePermit {
    fn drop(&mut self) {
        if let Ok(mut groups) = SCRIPT_EXCLUSIVE_GROUPS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
        {
            groups.remove(&self.group);
        }
    }
}

fn acquire_exclusive_group(group: Option<&str>) -> AppResult<Option<ScriptExclusivePermit>> {
    let Some(group) = group else {
        return Ok(None);
    };
    validate_safe_identifier(group, "exclusiveGroup")?;
    let mut groups = SCRIPT_EXCLUSIVE_GROUPS
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|error| {
            AppError::Protocol(format!("Script exclusive group lock error: {error}"))
        })?;
    if !groups.insert(group.to_string()) {
        return Err(AppError::Protocol(format!(
            "Another script tool in exclusive group '{group}' is already running"
        )));
    }
    Ok(Some(ScriptExclusivePermit {
        group: group.to_string(),
    }))
}

#[derive(Clone, Default)]
pub(crate) struct ScriptExecutionRegistry {
    executions: Arc<Mutex<HashMap<String, Weak<ScriptExecutionState>>>>,
}

#[derive(Default)]
struct ScriptExecutionState {
    cancellation: Mutex<ScriptExecutionCancellation>,
}

#[derive(Default)]
struct ScriptExecutionCancellation {
    asserted: bool,
    invocations: Vec<Weak<AtomicBool>>,
}

pub(crate) struct ScriptExecutionReservation {
    state: Arc<ScriptExecutionState>,
}

impl ScriptExecutionReservation {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.state
            .cancellation
            .lock()
            .map(|cancellation| cancellation.asserted)
            .unwrap_or(true)
    }
}

struct ScriptInvocationCancellation {
    _state: Arc<ScriptExecutionState>,
    signal: Arc<AtomicBool>,
}

impl ScriptInvocationCancellation {
    fn signal(&self) -> Arc<AtomicBool> {
        self.signal.clone()
    }
}

impl ScriptExecutionRegistry {
    pub(crate) fn reserve(&self, execution_id: &str) -> AppResult<ScriptExecutionReservation> {
        validate_execution_id(execution_id)?;
        let mut executions = self.executions.lock().map_err(|error| {
            AppError::Protocol(format!("Script execution registry lock error: {error}"))
        })?;
        executions.retain(|_, token| token.strong_count() > 0);
        if executions
            .get(execution_id)
            .and_then(Weak::upgrade)
            .is_some()
        {
            return Err(AppError::Protocol(format!(
                "Script execution id '{execution_id}' is already active"
            )));
        }
        let state = Arc::new(ScriptExecutionState::default());
        executions.insert(execution_id.to_string(), Arc::downgrade(&state));
        Ok(ScriptExecutionReservation { state })
    }

    fn token_for_execution(&self, execution_id: &str) -> AppResult<ScriptInvocationCancellation> {
        validate_execution_id(execution_id)?;
        let mut executions = self.executions.lock().map_err(|error| {
            AppError::Protocol(format!("Script execution registry lock error: {error}"))
        })?;
        executions.retain(|_, token| token.strong_count() > 0);
        let state = executions
            .get(execution_id)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let state = Arc::new(ScriptExecutionState::default());
                executions.insert(execution_id.to_string(), Arc::downgrade(&state));
                state
            });
        let signal = {
            let mut cancellation = state.cancellation.lock().map_err(|error| {
                AppError::Protocol(format!("Script execution cancellation lock error: {error}"))
            })?;
            cancellation
                .invocations
                .retain(|token| token.strong_count() > 0);
            // The run-level assertion is persistent, while each Lua invocation receives a
            // one-shot signal. Lua may consume that signal after raising E_CANCELLED so its
            // cleanup calls can run, without clearing cancellation for a later invocation.
            let signal = Arc::new(AtomicBool::new(cancellation.asserted));
            cancellation.invocations.push(Arc::downgrade(&signal));
            signal
        };
        Ok(ScriptInvocationCancellation {
            _state: state,
            signal,
        })
    }

    pub(crate) fn cancel(&self, execution_id: &str) -> AppResult<bool> {
        validate_execution_id(execution_id)?;
        let mut executions = self.executions.lock().map_err(|error| {
            AppError::Protocol(format!("Script execution registry lock error: {error}"))
        })?;
        executions.retain(|_, token| token.strong_count() > 0);
        let Some(state) = executions.get(execution_id).and_then(Weak::upgrade) else {
            return Ok(false);
        };
        let mut cancellation = state.cancellation.lock().map_err(|error| {
            AppError::Protocol(format!("Script execution cancellation lock error: {error}"))
        })?;
        cancellation.asserted = true;
        cancellation
            .invocations
            .retain(|token| token.strong_count() > 0);
        for token in &cancellation.invocations {
            if let Some(token) = token.upgrade() {
                token.store(true, Ordering::SeqCst);
            }
        }
        Ok(true)
    }
}

fn validate_execution_id(execution_id: &str) -> AppResult<()> {
    validate_safe_identifier(execution_id, "executionId")
}

fn validate_safe_identifier(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(AppError::Protocol(format!(
            "{label} must be 1-128 ASCII letters, digits, '.', '_' or '-'"
        )));
    }
    Ok(())
}

fn script_session_store() -> &'static Mutex<HashMap<String, Value>> {
    SCRIPT_SESSION_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpToolScriptApi {
    LegacySingle,
    MultiTool,
}

#[derive(Debug, Clone)]
pub struct LoadedMcpToolScript {
    pub api: McpToolScriptApi,
    pub tools: Vec<McpToolScriptMeta>,
}

pub fn load_mcp_tool_script(script_content: &str) -> AppResult<LoadedMcpToolScript> {
    ensure_lua_script_kind(script_content, LuaScriptKind::McpTool)?;

    let lua = Lua::new();
    apply_memory_limit(&lua);
    setup_sandbox(&lua)?;
    arm_execution_limit(&lua);

    lua.load(script_content).exec().map_err(|error| {
        AppError::Protocol(format!("Lua MCP tool metadata load error: {}", error))
    })?;

    let globals = lua.globals();

    if let Some(tools_fn) = globals.get::<Option<LuaFunction>>("mcp_tools")? {
        let result: LuaValue = tools_fn.call(()).map_err(|error| {
            AppError::Protocol(format!("Lua MCP tools metadata error: {}", error))
        })?;
        let tools: Vec<McpToolScriptMeta> = lua.from_value(result).map_err(|error| {
            AppError::Protocol(format!(
                "Lua MCP tools metadata conversion error: {}",
                error
            ))
        })?;

        if tools.is_empty() {
            return Err(AppError::Protocol(
                "Lua MCP tool script must expose at least one tool in global 'mcp_tools'"
                    .to_string(),
            ));
        }

        return Ok(LoadedMcpToolScript {
            api: McpToolScriptApi::MultiTool,
            tools,
        });
    }

    let meta_fn: LuaFunction = globals.get("mcp_meta").map_err(|_| {
        AppError::Protocol(
            "Lua MCP tool script must define a global 'mcp_meta' or 'mcp_tools' function"
                .to_string(),
        )
    })?;
    let result: LuaValue = meta_fn
        .call(())
        .map_err(|error| AppError::Protocol(format!("Lua MCP tool metadata error: {}", error)))?;
    let meta: McpToolScriptMeta = lua.from_value(result).map_err(|error| {
        AppError::Protocol(format!("Lua MCP metadata conversion error: {}", error))
    })?;

    Ok(LoadedMcpToolScript {
        api: McpToolScriptApi::LegacySingle,
        tools: vec![meta],
    })
}

pub async fn execute_mcp_tool_script(
    state: &AppState,
    app_handle: Option<AppHandle>,
    resolved_tool: &McpResolvedScriptTool,
    arguments: Value,
    active_channel_id: Option<String>,
) -> AppResult<Value> {
    execute_mcp_tool_script_with_context(
        state,
        app_handle,
        resolved_tool,
        arguments,
        active_channel_id,
        None,
    )
    .await
}

pub async fn execute_mcp_tool_script_with_context(
    state: &AppState,
    app_handle: Option<AppHandle>,
    resolved_tool: &McpResolvedScriptTool,
    arguments: Value,
    active_channel_id: Option<String>,
    invocation_context: Option<ToolInvocationContext>,
) -> AppResult<Value> {
    let script: &McpToolScript = &resolved_tool.script;
    if script.source_type != McpToolScriptSourceType::File {
        return Err(AppError::Protocol(format!(
            "MCP tool '{}' must load from a Lua file",
            script.name
        )));
    }

    let path = script.lua_path.as_deref().ok_or_else(|| {
        AppError::Protocol(format!("MCP tool '{}' has no Lua file path", script.name))
    })?;
    let script_content = tokio::fs::read_to_string(path).await?;

    let loaded_script = load_mcp_tool_script(&script_content)?;
    let protocol_manager = state.protocol_manager.clone();
    let current_channel_id = resolve_channel_id(script, &arguments, active_channel_id);
    let tool_name = resolved_tool.meta.name.clone();
    let loaded_meta = loaded_script
        .tools
        .iter()
        .find(|meta| meta.name == tool_name)
        .ok_or_else(|| {
            AppError::Protocol(format!(
                "Lua MCP tool '{}' is no longer defined by its script",
                tool_name
            ))
        })?;
    let exclusive_permit = acquire_exclusive_group(loaded_meta.exclusive_group.as_deref())?;
    let protocol_file = resolved_tool.meta.protocol_file.clone();
    let protocol_resource_root = resolved_tool.script.protocol_resource_root.clone();
    let app_state = state.clone();
    let runtime_handle = Handle::current();
    let script_state_key = path.to_string();
    let cancellation_scope = match arguments.get("executionId") {
        Some(Value::String(execution_id)) => Some(
            state
                .script_execution_registry
                .token_for_execution(execution_id)?,
        ),
        Some(Value::Null) | None => None,
        Some(_) => {
            return Err(AppError::Protocol(
                "executionId must be a string when provided".to_string(),
            ))
        }
    };
    let cancellation = cancellation_scope
        .as_ref()
        .map(ScriptInvocationCancellation::signal);

    tokio::task::spawn_blocking(move || {
        let _exclusive_permit = exclusive_permit;
        // Keep the run-level state alive for the whole invocation. The Lua-facing signal is
        // intentionally one-shot so a caught cancellation does not prevent cleanup helpers.
        let _cancellation_scope = cancellation_scope;
        let lua = Lua::new();
        apply_memory_limit(&lua);
        setup_sandbox(&lua)?;
        register_helpers(
            &lua,
            app_state,
            app_handle,
            runtime_handle,
            protocol_manager,
            protocol_file,
            protocol_resource_root,
            current_channel_id,
            tool_name.clone(),
            script_state_key,
            cancellation.clone(),
            invocation_context,
        )?;
        arm_execution_limit_with_cancellation(&lua, cancellation);

        lua.load(&script_content)
            .exec()
            .map_err(|error| AppError::Protocol(format!("Lua MCP tool load error: {}", error)))?;

        let call_fn: LuaFunction = lua.globals().get("call").map_err(|_| {
            AppError::Protocol(
                "Lua MCP tool script must define a global 'call' function".to_string(),
            )
        })?;
        let args = lua.to_value(&arguments)?;
        let result: LuaValue = match loaded_script.api {
            McpToolScriptApi::LegacySingle => call_fn.call(args),
            McpToolScriptApi::MultiTool => call_fn.call((tool_name, args)),
        }
        .map_err(|error| AppError::Protocol(format!("Lua MCP tool call error: {}", error)))?;
        lua.from_value(result).map_err(|error| {
            AppError::Protocol(format!("Lua MCP result conversion error: {}", error))
        })
    })
    .await
    .map_err(|error| AppError::Protocol(format!("Lua MCP tool task failed: {}", error)))?
}

pub async fn execute_mcp_script_shutdown_hook(
    state: &AppState,
    app_handle: Option<AppHandle>,
    script: &McpToolScript,
) -> AppResult<Option<Value>> {
    if script.source_type != McpToolScriptSourceType::File {
        return Ok(None);
    }

    let path = script
        .lua_path
        .as_deref()
        .ok_or_else(|| AppError::Protocol("MCP tool script has no Lua file path".to_string()))?;
    let script_content = tokio::fs::read_to_string(path).await?;

    load_mcp_tool_script(&script_content)?;

    let protocol_manager = state.protocol_manager.clone();
    let protocol_file = script.protocol_file.clone();
    let protocol_resource_root = script.protocol_resource_root.clone();
    let current_channel_id = script.target_channel_id.clone();
    let app_state = state.clone();
    let runtime_handle = Handle::current();
    let script_state_key = path.to_string();

    tokio::task::spawn_blocking(move || {
        let lua = Lua::new();
        apply_memory_limit(&lua);
        setup_sandbox(&lua)?;
        register_helpers(
            &lua,
            app_state,
            app_handle,
            runtime_handle,
            protocol_manager,
            protocol_file,
            protocol_resource_root,
            current_channel_id,
            "__mcp_shutdown_hook__".to_string(),
            script_state_key,
            None,
            None,
        )?;
        arm_execution_limit(&lua);

        lua.load(&script_content)
            .exec()
            .map_err(|error| AppError::Protocol(format!("Lua MCP tool load error: {}", error)))?;

        let Some(shutdown_fn) = lua.globals().get::<Option<LuaFunction>>("on_shutdown")? else {
            return Ok(None);
        };

        let context = lua.to_value(&json!({ "reason": "core_shutdown" }))?;
        let result: LuaValue = shutdown_fn.call(context).map_err(|error| {
            AppError::Protocol(format!("Lua MCP shutdown hook error: {}", error))
        })?;

        match result {
            LuaValue::Nil => Ok(None),
            value => lua.from_value(value).map(Some).map_err(|error| {
                AppError::Protocol(format!(
                    "Lua MCP shutdown hook result conversion error: {}",
                    error
                ))
            }),
        }
    })
    .await
    .map_err(|error| AppError::Protocol(format!("Lua MCP shutdown hook task failed: {}", error)))?
}

fn resolve_channel_id(
    script: &McpToolScript,
    arguments: &Value,
    active_channel_id: Option<String>,
) -> Option<String> {
    if script.use_current_channel {
        active_channel_id.or_else(|| {
            arguments
                .get("channelId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
    } else {
        script.target_channel_id.clone()
    }
}

fn ensure_not_cancelled(cancellation: &Option<Arc<AtomicBool>>) -> Result<(), mlua::Error> {
    if cancellation
        .as_ref()
        .is_some_and(|flag| flag.swap(false, Ordering::SeqCst))
    {
        Err(mlua::Error::RuntimeError(
            "LinkAssist script execution cancelled".to_string(),
        ))
    } else {
        Ok(())
    }
}

fn setup_sandbox(lua: &Lua) -> AppResult<()> {
    let globals = lua.globals();

    globals.set("os", LuaValue::Nil)?;
    globals.set("io", LuaValue::Nil)?;
    globals.set("loadfile", LuaValue::Nil)?;
    globals.set("dofile", LuaValue::Nil)?;
    globals.set("require", LuaValue::Nil)?;
    globals.set("load", LuaValue::Nil)?;
    globals.set("debug", LuaValue::Nil)?;
    globals.set("package", LuaValue::Nil)?;

    Ok(())
}

fn register_helpers(
    lua: &Lua,
    app_state: AppState,
    app_handle: Option<AppHandle>,
    runtime_handle: Handle,
    protocol_manager: std::sync::Arc<tokio::sync::Mutex<crate::protocol::ProtocolManager>>,
    protocol_file: Option<String>,
    protocol_resource_root: Option<String>,
    current_channel_id: Option<String>,
    current_tool_name: String,
    script_state_key: String,
    cancellation: Option<Arc<AtomicBool>>,
    invocation_context: Option<ToolInvocationContext>,
) -> AppResult<()> {
    let globals = lua.globals();

    let bytes_to_hex = lua.create_function(|_, tbl: Table| {
        let mut hex = String::new();
        let mut i = 1i64;
        while let Some(byte) = tbl.get::<Option<u8>>(i)? {
            if !hex.is_empty() {
                hex.push(' ');
            }
            hex.push_str(&format!("{:02X}", byte));
            i += 1;
        }
        Ok(hex)
    })?;
    globals.set("bytes_to_hex", bytes_to_hex)?;

    let hex_to_bytes = lua.create_function(|lua_ctx, hex: String| {
        let stripped: String = hex.chars().filter(|char| !char.is_whitespace()).collect();
        if stripped.len() % 2 != 0 {
            return Err(mlua::Error::RuntimeError(
                "hex string has odd length".to_string(),
            ));
        }
        let table = lua_ctx.create_table()?;
        for (index, chunk) in stripped.as_bytes().chunks(2).enumerate() {
            let value = std::str::from_utf8(chunk)
                .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
            let byte = u8::from_str_radix(value, 16)
                .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
            table.set(index + 1, byte)?;
        }
        Ok(table)
    })?;
    globals.set("hex_to_bytes", hex_to_bytes)?;

    let parse_manager = protocol_manager.clone();
    let parse_current_protocol = lua.create_function(move |lua_ctx, data: Table| {
        let bytes = table_to_bytes(data)?;
        let manager = parse_manager.blocking_lock();
        let parsed = manager
            .parse(&bytes)
            .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
        let json = serde_json::to_value(parsed)
            .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
        lua_ctx.to_value(&json)
    })?;
    globals.set("parse_current_protocol", parse_current_protocol)?;

    let parse_protocol_file =
        lua.create_function(|lua_ctx, (file_path, data): (String, Table)| {
            let bytes = table_to_bytes(data)?;
            let parsed = crate::protocol::ProtocolManager::parse_data_with_lua_file(
                PathBuf::from(file_path),
                None,
                &bytes,
            )
            .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
            let json = serde_json::to_value(parsed)
                .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
            lua_ctx.to_value(&json)
        })?;
    globals.set("parse_protocol_file", parse_protocol_file)?;

    let default_protocol_file = protocol_file.clone();
    let default_protocol_resource_root = protocol_resource_root.clone();
    let parse_configured_protocol_file = lua.create_function(move |lua_ctx, data: Table| {
        let Some(file_path) = default_protocol_file.as_ref() else {
            return Err(mlua::Error::RuntimeError(
                "No protocolFile is configured for this MCP tool".to_string(),
            ));
        };
        let bytes = table_to_bytes(data)?;
        let parsed = crate::protocol::ProtocolManager::parse_data_with_lua_file(
            PathBuf::from(file_path),
            default_protocol_resource_root.as_ref().map(PathBuf::from),
            &bytes,
        )
        .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
        let json = serde_json::to_value(parsed)
            .map_err(|error| mlua::Error::RuntimeError(error.to_string()))?;
        lua_ctx.to_value(&json)
    })?;
    globals.set(
        "parse_configured_protocol_file",
        parse_configured_protocol_file,
    )?;

    let info_channel_id = current_channel_id.clone();
    let get_current_channel = lua.create_function(move |lua_ctx, ()| {
        lua_ctx.to_value(&json!({ "channelId": info_channel_id }))
    })?;
    globals.set("get_current_channel", get_current_channel)?;

    let get_state_key = script_state_key.clone();
    let get_session_state = lua.create_function(move |lua_ctx, ()| {
        let value = {
            let store = script_session_store().lock().map_err(|error| {
                mlua::Error::RuntimeError(format!("Session state lock error: {}", error))
            })?;
            store.get(&get_state_key).cloned()
        };

        match value {
            Some(value) => lua_ctx.to_value(&value).map_err(|error| {
                mlua::Error::RuntimeError(format!("Session state conversion error: {}", error))
            }),
            None => Ok(LuaValue::Nil),
        }
    })?;
    globals.set("get_session_state", get_session_state)?;

    let set_state_key = script_state_key.clone();
    let set_session_state = lua.create_function(move |lua_ctx, value: LuaValue| {
        let value: Value = lua_ctx.from_value(value).map_err(|error| {
            mlua::Error::RuntimeError(format!("Session state serialization error: {}", error))
        })?;

        {
            let mut store = script_session_store().lock().map_err(|error| {
                mlua::Error::RuntimeError(format!("Session state lock error: {}", error))
            })?;
            store.insert(set_state_key.clone(), value.clone());
        }

        lua_ctx.to_value(&value).map_err(|error| {
            mlua::Error::RuntimeError(format!("Session state result conversion error: {}", error))
        })
    })?;
    globals.set("set_session_state", set_session_state)?;

    let clear_state_key = script_state_key.clone();
    let clear_session_state = lua.create_function(move |_, ()| {
        let mut store = script_session_store().lock().map_err(|error| {
            mlua::Error::RuntimeError(format!("Session state lock error: {}", error))
        })?;
        store.remove(&clear_state_key);
        Ok(())
    })?;
    globals.set("clear_session_state", clear_session_state)?;

    let invoke_state = app_state.clone();
    let invoke_app_handle = app_handle.clone();
    let invoke_runtime = runtime_handle.clone();
    let invoke_current_tool = current_tool_name.clone();
    let invoke_cancellation = cancellation.clone();
    let invoke_context = invocation_context.clone();
    let invoke_tool = lua.create_function(
        move |lua_ctx, (tool_name, args): (String, Option<LuaValue>)| {
            ensure_not_cancelled(&invoke_cancellation)?;
            if tool_name == invoke_current_tool {
                return Err(mlua::Error::RuntimeError(
                    "invoke_tool cannot recursively call the current MCP Lua tool".to_string(),
                ));
            }

            if !crate::mcp_tools::is_builtin_tool_name(&tool_name) {
                return Err(mlua::Error::RuntimeError(format!(
                    "invoke_tool only supports built-in LinkAssist MCP tools; '{}' is not built-in",
                    tool_name
                )));
            }

            let Some(app_handle) = invoke_app_handle.clone() else {
                return Err(mlua::Error::RuntimeError(
                    "invoke_tool is unavailable without an AppHandle".to_string(),
                ));
            };

            let arguments = match args {
                Some(LuaValue::Nil) | None => json!({}),
                Some(value) => lua_ctx.from_value(value).map_err(|error| {
                    mlua::Error::RuntimeError(format!(
                        "invoke_tool arguments conversion error: {}",
                        error
                    ))
                })?,
            };

            let state = invoke_state.clone();
            let context = invoke_context.clone();
            let result = invoke_runtime.block_on(crate::mcp_tools::call_tool(
                &state, app_handle, &tool_name, arguments, context,
            ));
            ensure_not_cancelled(&invoke_cancellation)?;
            let result = result.map_err(|error| {
                mlua::Error::RuntimeError(format!("invoke_tool '{}' failed: {}", tool_name, error))
            })?;

            lua_ctx.to_value(&result).map_err(|error| {
                mlua::Error::RuntimeError(format!(
                    "invoke_tool '{}' result conversion error: {}",
                    tool_name, error
                ))
            })
        },
    )?;
    globals.set("invoke_tool", invoke_tool)?;

    let sleep_cancellation = cancellation.clone();
    let sleep_ms = lua.create_function(move |_, milliseconds: u64| {
        let mut remaining = milliseconds;
        while remaining > 0 {
            ensure_not_cancelled(&sleep_cancellation)?;
            let slice = remaining.min(50);
            std::thread::sleep(std::time::Duration::from_millis(slice));
            remaining -= slice;
        }
        ensure_not_cancelled(&sleep_cancellation)?;
        Ok(())
    })?;
    globals.set("sleep_ms", sleep_ms)?;

    let now_s = lua.create_function(|_, ()| {
        Ok(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64())
    })?;
    globals.set("now_s", now_s)?;

    let now_ms = lua.create_function(|_, ()| {
        Ok(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64)
    })?;
    globals.set("now_ms", now_ms)?;

    let open_state = app_state.clone();
    let open_app_handle = app_handle.clone();
    let open_runtime = runtime_handle.clone();
    let open_channel_id = current_channel_id.clone();
    let open_cancellation = cancellation.clone();
    let open_context = invocation_context.clone();
    let open_current_channel = lua.create_function(move |lua_ctx, ()| {
        ensure_not_cancelled(&open_cancellation)?;
        let Some(app_handle) = open_app_handle.clone() else {
            return Err(mlua::Error::RuntimeError(
                "open_current_channel is unavailable without an AppHandle".to_string(),
            ));
        };
        let Some(channel_id) = open_channel_id.clone() else {
            return Err(mlua::Error::RuntimeError(
                "open_current_channel: no current channel (configure the tool's target channel or pass channelId in tool args)"
                    .to_string(),
            ));
        };
        let state = open_state.clone();
        let event_app_handle = app_handle.clone();
        let event_channel_id = channel_id.clone();
        let context = open_context.clone();
        let result = open_runtime.block_on(async move {
            let result = crate::channel_registry::open_channel_from_config(
                &state,
                &app_handle,
                &channel_id,
            )
            .await;
            if let Ok(value) = &result {
                let transport = match value.get("channelType").and_then(Value::as_str) {
                    Some("ble") => Some("ble"),
                    Some("serial") => Some("serial"),
                    Some("tcp-client") => Some("tcp-client"),
                    Some("tcp-server") => Some("tcp-server"),
                    Some("udp") => Some("udp"),
                    _ => None,
                };
                if let Some(transport) = transport {
                    let mut event = ChannelActivityEvent::new(
                        context.as_ref(),
                        "connected",
                        transport,
                    )
                    .channel(event_channel_id);
                    if let Some(connection_id) = value.get("connectionId").and_then(Value::as_str) {
                        event = event.connection(connection_id);
                    }
                    emit_channel_activity(&event_app_handle, event);
                }
            }
            result
        });
        ensure_not_cancelled(&open_cancellation)?;
        let result = result.map_err(|error| {
                mlua::Error::RuntimeError(format!("open_current_channel failed: {}", error))
            })?;
        lua_ctx.to_value(&result)
    })?;
    globals.set("open_current_channel", open_current_channel)?;

    let send_state = app_state;
    let send_runtime = runtime_handle;
    let send_channel_id = current_channel_id;
    let send_cancellation = cancellation;
    let send_app_handle = app_handle;
    let send_context = invocation_context;
    let send = lua.create_function(move |lua_ctx, (data, options): (Table, Option<LuaValue>)| {
        ensure_not_cancelled(&send_cancellation)?;
        let Some(channel_id) = send_channel_id.clone() else {
            return Err(mlua::Error::RuntimeError(
                "send: no current channel (configure the tool's target channel or pass channelId in tool args)"
                    .to_string(),
            ));
        };
        let bytes = table_to_bytes(data)?;
        let options: crate::channel_registry::SendOptions = match options {
            Some(LuaValue::Nil) | None => Default::default(),
            Some(value) => lua_ctx.from_value(value).map_err(|error| {
                mlua::Error::RuntimeError(format!("send options conversion error: {}", error))
            })?,
        };
        let state = send_state.clone();
        let app_handle = send_app_handle.clone();
        let context = send_context.clone();
        let result = send_runtime.block_on(async move {
            let binding = state
                .channel_registry
                .get(&channel_id)
                .await
                .ok_or_else(|| {
                    crate::AppError::Protocol(format!(
                        "Channel '{}' has no open connection; call open_current_channel() first",
                        channel_id
                    ))
                })?;
            let transport = match binding.channel_type.as_str() {
                "ble" => Some("ble"),
                "serial" => Some("serial"),
                "tcp-client" => Some("tcp-client"),
                "tcp-server" => Some("tcp-server"),
                "udp" => Some("udp"),
                _ => None,
            };
            if let (Some(app_handle), Some(transport)) = (&app_handle, transport) {
                let mut endpoint = serde_json::Map::new();
                if transport == "ble" {
                    endpoint.insert(
                        "deviceId".to_string(),
                        Value::String(binding.connection_id.clone()),
                    );
                    if let Some(service_uuid) = &options.service_uuid {
                        endpoint.insert(
                            "serviceUuid".to_string(),
                            Value::String(service_uuid.clone()),
                        );
                    }
                    if let Some(char_uuid) = &options.char_uuid {
                        endpoint.insert("charUuid".to_string(), Value::String(char_uuid.clone()));
                    }
                }
                if transport == "udp" {
                    if let Some(address) = options.addr.as_ref().or(binding.target_addr.as_ref()) {
                        endpoint.insert(
                            "remoteAddress".to_string(),
                            Value::String(address.clone()),
                        );
                    }
                }
                let mut event = ChannelActivityEvent::new(context.as_ref(), "tx", transport)
                    .channel(channel_id.clone())
                    .connection(binding.connection_id.clone())
                    .data(&bytes);
                if !endpoint.is_empty() {
                    event = event.endpoint(Value::Object(endpoint));
                }
                emit_channel_activity(app_handle, event);
            }
            crate::channel_registry::send_to_channel_binding(
                &state,
                &channel_id,
                &binding,
                &bytes,
                &options,
            )
            .await
        });
        ensure_not_cancelled(&send_cancellation)?;
        let result = result
            .map_err(|error| mlua::Error::RuntimeError(format!("send failed: {}", error)))?;
        lua_ctx.to_value(&result)
    })?;
    globals.set("send", send)?;

    Ok(())
}

fn table_to_bytes(table: Table) -> Result<Vec<u8>, mlua::Error> {
    let mut bytes = Vec::new();
    for value in table.sequence_values::<u8>() {
        bytes.push(value?);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_tools::{McpResolvedScriptTool, McpToolScriptMeta};
    use crate::mcp_tools::{McpToolScript, McpToolScriptSourceType};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tool_path(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("linkassist_exec_{}_{}.lua", name, stamp))
    }

    fn write_multi_tool_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = mcp
function mcp_tools()
  return {
    {
      name = \"tool_alpha\",
      description = \"Alpha tool\",
      input_schema = {
        type = \"object\",
        properties = {
          value = { type = \"integer\" },
        },
        required = { \"value\" },
        additionalProperties = false,
      },
    },
    {
      name = \"tool_beta\",
      description = \"Beta tool\",
      input_schema = {
        type = \"object\",
        properties = {
          value = { type = \"integer\" },
        },
        required = { \"value\" },
        additionalProperties = false,
      },
    },
  }
end

function call(tool_name, args)
  return {
    ok = true,
    tool = tool_name,
    value = args.value,
  }
end
";
        fs::write(&path, content).expect("test multi-tool Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_invoke_tool_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = mcp
function mcp_meta()
    return {
        name = \"tool_invoke_greet\",
        description = \"Invoke greet tool\",
        input_schema = {
            type = \"object\",
            properties = {
                name = { type = \"string\" },
            },
            required = { \"name\" },
            additionalProperties = false,
        },
    }
end

function call(args)
    local result = invoke_tool(\"greet\", { name = args.name })
    return {
        ok = true,
        message = result.message,
    }
end
";
        fs::write(&path, content).expect("test invoke-tool Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_session_state_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = mcp
function mcp_meta()
    return {
        name = \"tool_session_counter\",
        description = \"Persist counter in session state\",
        input_schema = {
            type = \"object\",
            properties = {},
            additionalProperties = false,
        },
    }
end

function call(args)
    local state = get_session_state() or {}
    local count = (state.count or 0) + 1
    state.count = count
    set_session_state(state)
    return {
        count = count,
    }
end
";
        fs::write(&path, content).expect("test session-state Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_shutdown_hook_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = mcp
function mcp_meta()
    return {
        name = \"tool_shutdown_state\",
        description = \"Exercise shutdown hook\",
        input_schema = {
            type = \"object\",
            properties = {},
            additionalProperties = false,
        },
    }
end

function call(args)
    local state = get_session_state() or {}
    local count = (state.count or 0) + 1
    state.count = count
    set_session_state(state)
    return {
        count = count,
    }
end

function on_shutdown(context)
    local state = get_session_state() or {}
    local prior_count = state.count or 0
    clear_session_state()
    return {
        reason = context.reason,
        priorCount = prior_count,
    }
end
";
        fs::write(&path, content).expect("test shutdown-hook Lua file should be written");
        path.to_string_lossy().to_string()
    }

    fn write_cancellable_file(name: &str) -> String {
        let path = unique_tool_path(name);
        let content = "-- linkassist:type = mcp
function mcp_meta()
  return {
    name = \"tool_cancellable\",
    description = \"Cancellable tool\",
    input_schema = { type = \"object\", properties = {} },
  }
end

function call(args)
  sleep_ms(60000)
  return { ok = true }
end
";
        fs::write(&path, content).expect("test cancellable Lua file should be written");
        path.to_string_lossy().to_string()
    }

    #[test]
    fn execution_registry_keeps_run_cancellation_asserted_across_invocations() {
        let registry = ScriptExecutionRegistry::default();
        let reservation = registry
            .reserve("run-1")
            .expect("execution id should reserve");
        let first_invocation = registry
            .token_for_execution("run-1")
            .expect("execution should attach to reserved token");
        assert!(!first_invocation.signal.load(Ordering::SeqCst));
        assert!(registry.cancel("run-1").expect("cancel should succeed"));
        assert!(reservation.is_cancelled());
        let first_signal = Some(first_invocation.signal());
        assert!(ensure_not_cancelled(&first_signal).is_err());
        assert!(
            ensure_not_cancelled(&first_signal).is_ok(),
            "the same invocation must be able to run cleanup after catching cancellation"
        );

        let later_invocation = registry
            .token_for_execution("run-1")
            .expect("a later invocation should attach to the same run state");
        assert!(ensure_not_cancelled(&Some(later_invocation.signal())).is_err());
        assert!(registry.reserve("run-1").is_err());
        drop(first_invocation);
        drop(later_invocation);
        drop(reservation);
        assert!(registry.reserve("run-1").is_ok());
    }

    #[test]
    fn exclusive_script_groups_reject_overlapping_device_flows() {
        let permit = acquire_exclusive_group(Some("device-flow"))
            .expect("first exclusive tool should acquire its group")
            .expect("group should return a permit");
        assert!(acquire_exclusive_group(Some("device-flow")).is_err());
        assert!(acquire_exclusive_group(Some("build-flow")).is_ok());
        drop(permit);
        assert!(acquire_exclusive_group(Some("device-flow")).is_ok());
    }

    #[test]
    fn lua_tool_metadata_can_declare_a_generic_exclusive_group() {
        let loaded = load_mcp_tool_script(
            "-- linkassist:type = mcp\n\
             function mcp_meta() return { name = 'exclusive_tool', \
             input_schema = { type = 'object' }, exclusive_group = 'device-flow' } end",
        )
        .expect("exclusive group metadata should load");
        assert_eq!(
            loaded.tools[0].exclusive_group.as_deref(),
            Some("device-flow")
        );
    }

    #[tokio::test]
    async fn execute_multi_tool_script_passes_tool_name_and_args_separately() {
        let app_state = crate::build_app_state().expect("app state should build");
        let lua_path = write_multi_tool_file("multi_call");
        let resolved_tool = McpResolvedScriptTool {
            script: McpToolScript {
                id: "test-script".to_string(),
                name: "tool_beta".to_string(),
                description: "Beta tool".to_string(),
                expose_to_mcp: true,
                source_type: McpToolScriptSourceType::File,
                inline_lua: String::new(),
                lua_path: Some(lua_path),
                input_schema: json!({
                    "type": "object",
                    "properties": { "value": { "type": "integer" } },
                    "required": ["value"],
                    "additionalProperties": false,
                }),
                use_current_channel: true,
                target_channel_id: None,
                protocol_file: None,
                protocol_resource_root: None,
            },
            meta: McpToolScriptMeta {
                name: "tool_beta".to_string(),
                description: "Beta tool".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "value": { "type": "integer" } },
                    "required": ["value"],
                    "additionalProperties": false,
                }),
                protocol_file: None,
                exclusive_group: None,
            },
        };

        let result = execute_mcp_tool_script(
            &app_state,
            None,
            &resolved_tool,
            json!({ "value": 42 }),
            None,
        )
        .await
        .expect("multi-tool execution should succeed");

        assert_eq!(
            result,
            json!({
                "ok": true,
                "tool": "tool_beta",
                "value": 42,
            })
        );
    }

    #[tokio::test]
    async fn invoke_tool_requires_app_handle_in_direct_execution_tests() {
        let app_state = crate::build_app_state().expect("app state should build");
        let lua_path = write_invoke_tool_file("invoke_tool_without_handle");
        let resolved_tool = McpResolvedScriptTool {
            script: McpToolScript {
                id: "test-script".to_string(),
                name: "tool_invoke_greet".to_string(),
                description: "Invoke greet tool".to_string(),
                expose_to_mcp: true,
                source_type: McpToolScriptSourceType::File,
                inline_lua: String::new(),
                lua_path: Some(lua_path),
                input_schema: json!({
                    "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"],
                    "additionalProperties": false,
                }),
                use_current_channel: true,
                target_channel_id: None,
                protocol_file: None,
                protocol_resource_root: None,
            },
            meta: McpToolScriptMeta {
                name: "tool_invoke_greet".to_string(),
                description: "Invoke greet tool".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": { "name": { "type": "string" } },
                    "required": ["name"],
                    "additionalProperties": false,
                }),
                protocol_file: None,
                exclusive_group: None,
            },
        };

        let error = execute_mcp_tool_script(
            &app_state,
            None,
            &resolved_tool,
            json!({ "name": "LinkAssist" }),
            None,
        )
        .await
        .expect_err("invoke_tool should require an AppHandle in direct execution tests");

        assert!(error
            .to_string()
            .contains("invoke_tool is unavailable without an AppHandle"));
    }

    #[tokio::test]
    async fn cooperative_cancellation_interrupts_sleeping_lua_execution() {
        let app_state = crate::build_app_state().expect("app state should build");
        let execution_id = "cancel-test";
        let _reservation = app_state
            .script_execution_registry
            .reserve(execution_id)
            .expect("test should reserve its execution id");
        let lua_path = write_cancellable_file("cooperative_cancel");
        let resolved_tool = McpResolvedScriptTool {
            script: McpToolScript {
                id: "test-script".to_string(),
                name: "tool_cancellable".to_string(),
                description: "Cancellable tool".to_string(),
                expose_to_mcp: true,
                source_type: McpToolScriptSourceType::File,
                inline_lua: String::new(),
                lua_path: Some(lua_path),
                input_schema: json!({ "type": "object", "properties": {} }),
                use_current_channel: true,
                target_channel_id: None,
                protocol_file: None,
                protocol_resource_root: None,
            },
            meta: McpToolScriptMeta {
                name: "tool_cancellable".to_string(),
                description: "Cancellable tool".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                protocol_file: None,
                exclusive_group: None,
            },
        };
        let execution_state = app_state.clone();
        let task = tokio::spawn(async move {
            execute_mcp_tool_script(
                &execution_state,
                None,
                &resolved_tool,
                json!({ "executionId": execution_id }),
                None,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(app_state
            .script_execution_registry
            .cancel(execution_id)
            .expect("cancel request should reach the live token"));
        let error = tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("cooperative cancellation should finish promptly")
            .expect("Lua execution task should join")
            .expect_err("cancelled Lua execution should fail")
            .to_string();
        assert!(error.contains("execution cancelled"), "error was: {error}");
    }

    #[tokio::test]
    async fn session_state_persists_between_calls_for_same_script() {
        let app_state = crate::build_app_state().expect("app state should build");
        let lua_path = write_session_state_file("session_state_counter");
        let resolved_tool = McpResolvedScriptTool {
            script: McpToolScript {
                id: "test-script".to_string(),
                name: "tool_session_counter".to_string(),
                description: "Persist counter in session state".to_string(),
                expose_to_mcp: true,
                source_type: McpToolScriptSourceType::File,
                inline_lua: String::new(),
                lua_path: Some(lua_path),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                }),
                use_current_channel: true,
                target_channel_id: None,
                protocol_file: None,
                protocol_resource_root: None,
            },
            meta: McpToolScriptMeta {
                name: "tool_session_counter".to_string(),
                description: "Persist counter in session state".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                }),
                protocol_file: None,
                exclusive_group: None,
            },
        };

        let first = execute_mcp_tool_script(&app_state, None, &resolved_tool, json!({}), None)
            .await
            .expect("first script call should succeed");
        let second = execute_mcp_tool_script(&app_state, None, &resolved_tool, json!({}), None)
            .await
            .expect("second script call should succeed");

        assert_eq!(first, json!({ "count": 1 }));
        assert_eq!(second, json!({ "count": 2 }));
    }

    #[tokio::test]
    async fn shutdown_hook_runs_and_can_clear_script_session_state() {
        let app_state = crate::build_app_state().expect("app state should build");
        let lua_path = write_shutdown_hook_file("shutdown_hook_state");
        let script = McpToolScript {
            id: "test-script".to_string(),
            name: "tool_shutdown_state".to_string(),
            description: "Exercise shutdown hook".to_string(),
            expose_to_mcp: true,
            source_type: McpToolScriptSourceType::File,
            inline_lua: String::new(),
            lua_path: Some(lua_path),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false,
            }),
            use_current_channel: true,
            target_channel_id: None,
            protocol_file: None,
            protocol_resource_root: None,
        };
        let resolved_tool = McpResolvedScriptTool {
            script: script.clone(),
            meta: McpToolScriptMeta {
                name: "tool_shutdown_state".to_string(),
                description: "Exercise shutdown hook".to_string(),
                input_schema: json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                }),
                protocol_file: None,
                exclusive_group: None,
            },
        };

        let first = execute_mcp_tool_script(&app_state, None, &resolved_tool, json!({}), None)
            .await
            .expect("first script call should succeed");
        let hook_result = execute_mcp_script_shutdown_hook(&app_state, None, &script)
            .await
            .expect("shutdown hook should succeed");
        let second = execute_mcp_tool_script(&app_state, None, &resolved_tool, json!({}), None)
            .await
            .expect("script call after shutdown hook should succeed");

        assert_eq!(first, json!({ "count": 1 }));
        assert_eq!(
            hook_result,
            Some(json!({ "reason": "core_shutdown", "priorCount": 1 }))
        );
        assert_eq!(second, json!({ "count": 1 }));
    }
}
