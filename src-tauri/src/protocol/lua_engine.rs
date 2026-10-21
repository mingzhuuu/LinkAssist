use crate::error::AppError;
use crate::protocol::types::{
    DataGroup, FieldValue, ParseResult, ParsedField, ProtocolFieldSummary, ProtocolFileSummary,
};
use mlua::{Lua, LuaSerdeExt, Table, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const LUA_MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const LUA_INSTRUCTION_BUDGET: u64 = 100_000_000;
const LUA_HOOK_GRANULARITY: u32 = 10_000;

/// Arm a fresh instruction budget on the Lua state. Without it a script stuck
/// in `while true do end` would hang whichever manager/thread runs it forever;
/// with it the VM raises a Lua error once the budget is exhausted.
pub(crate) fn arm_execution_limit(lua: &Lua) {
    arm_execution_limit_with_cancellation(lua, None);
}

pub(crate) fn arm_execution_limit_with_cancellation(
    lua: &Lua,
    cancellation: Option<Arc<AtomicBool>>,
) {
    let executed = Arc::new(AtomicU64::new(0));
    lua.set_hook(
        mlua::HookTriggers {
            every_nth_instruction: Some(LUA_HOOK_GRANULARITY),
            ..Default::default()
        },
        move |_, _| {
            if cancellation
                .as_ref()
                .is_some_and(|flag| flag.swap(false, Ordering::SeqCst))
            {
                return Err(mlua::Error::RuntimeError(
                    "LinkAssist script execution cancelled".to_string(),
                ));
            }
            let total = executed.fetch_add(u64::from(LUA_HOOK_GRANULARITY), Ordering::Relaxed)
                + u64::from(LUA_HOOK_GRANULARITY);
            if total > LUA_INSTRUCTION_BUDGET {
                Err(mlua::Error::RuntimeError(
                    "Lua script exceeded instruction budget (possible infinite loop)".to_string(),
                ))
            } else {
                Ok(mlua::VmState::Continue)
            }
        },
    );
}

pub(crate) fn apply_memory_limit(lua: &Lua) {
    // Best-effort: supported on the vendored Lua 5.4 build.
    let _ = lua.set_memory_limit(LUA_MEMORY_LIMIT_BYTES);
}

pub struct LuaEngine {
    lua: Lua,
    current_script: Option<String>,
}

impl LuaEngine {
    pub fn new() -> Result<Self, AppError> {
        let lua = Lua::new();
        apply_memory_limit(&lua);
        setup_sandbox(&lua)?;
        register_helpers(&lua)?;
        Ok(Self {
            lua,
            current_script: None,
        })
    }

    pub fn load_script(&mut self, script: &str) -> Result<(), AppError> {
        self.lua
            .load(script)
            .into_function()
            .map_err(|e| AppError::Protocol(format!("Lua script load error: {}", e)))?;
        self.current_script = Some(script.to_string());
        Ok(())
    }

    pub fn execute(&self, data: &[u8]) -> Result<ParseResult, AppError> {
        let script = self
            .current_script
            .as_ref()
            .ok_or_else(|| AppError::Protocol("no Lua script loaded".to_string()))?;

        execute_script(&self.lua, script, data)
    }

    pub fn validate_script(script: &str) -> Result<(), AppError> {
        let lua = Lua::new();
        lua.load(script)
            .into_function()
            .map_err(|e| AppError::Protocol(format!("Lua syntax error: {}", e)))?;
        Ok(())
    }
}

pub fn summarize_lua_protocol_file(
    path: PathBuf,
    resource_root: Option<PathBuf>,
) -> Result<ProtocolFileSummary, AppError> {
    let script = fs::read_to_string(&path)?;
    LuaEngine::validate_script(&script)?;

    let lua = Lua::new();
    apply_memory_limit(&lua);
    setup_sandbox(&lua)?;
    register_helpers(&lua)?;
    if let Some(file_root) = resource_root
        .as_deref()
        .or_else(|| path.parent().filter(|p| !p.as_os_str().is_empty()))
    {
        register_file_helpers(&lua, file_root)?;
    }
    arm_execution_limit(&lua);
    lua.load(&script)
        .exec()
        .map_err(|e| AppError::Protocol(format!("Lua execution error: {}", e)))?;

    let schema_fn: mlua::Function = lua.globals().get("schema").map_err(|_| {
        AppError::Protocol("Lua script must define a global 'schema' function".to_string())
    })?;

    let result: Value = schema_fn
        .call(())
        .map_err(|e| AppError::Protocol(format!("Lua schema function error: {}", e)))?;

    let schema_table = match result {
        Value::Table(t) => t,
        _ => {
            return Err(AppError::Protocol(
                "schema() must return an array-like table".to_string(),
            ))
        }
    };

    let mut fields = Vec::new();
    for item in schema_table.sequence_values::<Table>() {
        let field_tbl = item.map_err(|e| AppError::Protocol(e.to_string()))?;
        let id: String = field_tbl
            .get("id")
            .map_err(|_| AppError::Protocol("schema field must include id".to_string()))?;
        let name: String = field_tbl.get("alias").unwrap_or_else(|_| id.clone());
        let description: String = field_tbl.get("description").unwrap_or_default();
        // Optional per-field type label supplied by the script; empty when not provided.
        let field_type: String = field_tbl.get("type").unwrap_or_default();
        fields.push(ProtocolFieldSummary {
            id,
            name,
            field_type,
            description,
            display_format: "Auto".to_string(),
        });
    }

    Ok(ProtocolFileSummary {
        file_path: path.to_string_lossy().to_string(),
        name: protocol_name_from_path(path.as_path()),
        fields,
    })
}

/// Per-file cached Lua VM. Rebuilding the engine (read + validate + sandbox +
/// helpers + exec) for every packet costs milliseconds; at BLE/serial data
/// rates that lag accumulates behind the per-canvas ingest queues. The cache
/// drops per-packet cost to a single `parse()` call and is invalidated when
/// the file's mtime or size changes.
///
/// Note: this intentionally keeps the VM alive across packets, so top-level
/// script state (e.g. `local buf = {}`) persists until the file changes —
/// useful for stream reassembly together with the `remaining` return field.
struct CachedFileEngine {
    modified: Option<SystemTime>,
    len: u64,
    lua: Lua,
}

type FileEngineSlot = Arc<Mutex<Option<CachedFileEngine>>>;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileEngineKey {
    script_path: PathBuf,
    resource_root: Option<PathBuf>,
}

static FILE_ENGINE_CACHE: OnceLock<Mutex<HashMap<FileEngineKey, FileEngineSlot>>> = OnceLock::new();

fn file_engine_slot(path: &Path, resource_root: Option<&Path>) -> FileEngineSlot {
    let cache = FILE_ENGINE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.entry(FileEngineKey {
        script_path: path.to_path_buf(),
        resource_root: resource_root.map(Path::to_path_buf),
    })
    .or_default()
    .clone()
}

/// Build a fresh sandboxed Lua VM for a protocol file (read + validate + sandbox + helpers + exec).
fn build_file_engine(path: &Path, resource_root: Option<&Path>) -> Result<Lua, AppError> {
    let script = fs::read_to_string(path)?;
    LuaEngine::validate_script(&script)?;

    let lua = Lua::new();
    apply_memory_limit(&lua);
    setup_sandbox(&lua)?;
    register_helpers(&lua)?;
    if let Some(file_root) =
        resource_root.or_else(|| path.parent().filter(|p| !p.as_os_str().is_empty()))
    {
        register_file_helpers(&lua, file_root)?;
    }
    arm_execution_limit(&lua);
    lua.load(&script)
        .exec()
        .map_err(|e| AppError::Protocol(format!("Lua execution error: {}", e)))?;
    Ok(lua)
}

/// Run `body` against the file's cached VM, rebuilding it when the file's mtime or size changes.
/// The per-file mutex serializes VM entry; the same VM is shared by parse and encode calls.
fn with_cached_file_engine<T>(
    path: &Path,
    resource_root: Option<&Path>,
    body: impl FnOnce(&Lua) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let metadata = fs::metadata(path)?;
    let modified = metadata.modified().ok();
    let len = metadata.len();

    let slot = file_engine_slot(path, resource_root);
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let needs_rebuild = match guard.as_ref() {
        Some(cached) => cached.modified != modified || cached.len != len,
        None => true,
    };
    if needs_rebuild {
        let lua = build_file_engine(path, resource_root)?;
        *guard = Some(CachedFileEngine { modified, len, lua });
    }

    let cached = guard
        .as_ref()
        .expect("file engine populated by the rebuild branch above");
    body(&cached.lua)
}

pub fn parse_with_lua_protocol_file(
    path: PathBuf,
    resource_root: Option<PathBuf>,
    data: &[u8],
) -> Result<ParseResult, AppError> {
    with_cached_file_engine(&path, resource_root.as_deref(), |lua| {
        call_parse_function(lua, data)
    })
}

/// Result of encoding a single protocol field for a host "Send" form: the bytes and the
/// absolute frame offset the host should place them at.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LuaEncodeResult {
    pub offset: u32,
    pub bytes: Vec<u8>,
}

/// Encode one protocol field via the script's global `encode(fieldId, value)` function.
pub fn encode_field_with_lua_protocol_file(
    path: PathBuf,
    resource_root: Option<PathBuf>,
    field_id: &str,
    value: &str,
) -> Result<LuaEncodeResult, AppError> {
    with_cached_file_engine(&path, resource_root.as_deref(), |lua| {
        call_encode_function(lua, field_id, value)
    })
}

fn call_encode_function(
    lua: &Lua,
    field_id: &str,
    value: &str,
) -> Result<LuaEncodeResult, AppError> {
    arm_execution_limit(lua);

    let encode_fn: mlua::Function = lua.globals().get("encode").map_err(|_| {
        AppError::Protocol("Lua script must define a global 'encode' function".to_string())
    })?;

    let result: Value = encode_fn
        .call((field_id, value))
        .map_err(|e| AppError::Protocol(format!("Lua encode function error: {}", e)))?;

    match result {
        Value::Table(table) => {
            let offset: u32 = table.get("offset").unwrap_or(0);
            let bytes_table: Table = table.get("bytes").map_err(|_| {
                AppError::Protocol("encode() result must include a 'bytes' array".to_string())
            })?;
            let mut bytes = Vec::new();
            for byte in bytes_table.sequence_values::<u8>() {
                bytes.push(byte.map_err(|e| AppError::Protocol(e.to_string()))?);
            }
            Ok(LuaEncodeResult { offset, bytes })
        }
        Value::Nil => Err(AppError::Protocol(format!(
            "protocol field '{}' is not directly encodable",
            field_id
        ))),
        other => Err(AppError::Protocol(format!(
            "encode() must return a table or nil, got {}",
            other.type_name()
        ))),
    }
}

/// Result of encoding a whole protocol transaction into an outbound frame, with the transport
/// endpoint the caller should send it to and the function code to expect in the reply.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaTransactionEncodeResult {
    pub transaction_id: String,
    pub bytes: Vec<u8>,
    pub channel_id: Option<String>,
    pub service_uuid: Option<String>,
    pub characteristic_uuid: Option<String>,
    pub request_function_code: u8,
    pub expect_response_function_code: Option<u8>,
    pub write_type: Option<String>,
    pub danger: Option<String>,
    pub content_revision: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LuaTransactionMatchResult {
    pub transaction_id: String,
    pub matched: bool,
    pub expected: Option<serde_json::Value>,
    pub actual: Option<serde_json::Value>,
    pub reason: Option<String>,
}

/// Encode a whole transaction frame via the script's global `encode_transaction(id, valuesJson)`.
/// `values_json` is a JSON object string of payload field values.
pub fn encode_transaction_with_lua_protocol_file(
    path: PathBuf,
    resource_root: Option<PathBuf>,
    transaction_id: &str,
    values_json: &str,
) -> Result<LuaTransactionEncodeResult, AppError> {
    with_cached_file_engine(&path, resource_root.as_deref(), |lua| {
        call_encode_transaction_function(lua, transaction_id, values_json)
    })
}

fn call_encode_transaction_function(
    lua: &Lua,
    transaction_id: &str,
    values_json: &str,
) -> Result<LuaTransactionEncodeResult, AppError> {
    arm_execution_limit(lua);

    let encode_fn: mlua::Function = lua.globals().get("encode_transaction").map_err(|_| {
        AppError::Protocol(
            "Lua script must define a global 'encode_transaction' function".to_string(),
        )
    })?;

    let result: Value = encode_fn
        .call((transaction_id, values_json))
        .map_err(|e| AppError::Protocol(format!("Lua encode_transaction error: {}", e)))?;

    let table = match result {
        Value::Table(table) => table,
        other => {
            return Err(AppError::Protocol(format!(
                "encode_transaction() must return a table, got {}",
                other.type_name()
            )))
        }
    };

    let bytes_table: Table = table.get("bytes").map_err(|_| {
        AppError::Protocol("encode_transaction() result must include a 'bytes' array".to_string())
    })?;
    let mut bytes = Vec::new();
    for byte in bytes_table.sequence_values::<u8>() {
        bytes.push(byte.map_err(|e| AppError::Protocol(e.to_string()))?);
    }

    Ok(LuaTransactionEncodeResult {
        transaction_id: table
            .get::<Option<String>>("transactionId")
            .unwrap_or(None)
            .unwrap_or_else(|| transaction_id.to_string()),
        bytes,
        channel_id: table.get::<Option<String>>("channelId").unwrap_or(None),
        service_uuid: table.get::<Option<String>>("serviceUuid").unwrap_or(None),
        characteristic_uuid: table
            .get::<Option<String>>("characteristicUuid")
            .unwrap_or(None),
        request_function_code: table.get::<u8>("requestFunctionCode").unwrap_or(0),
        expect_response_function_code: table.get::<Option<u8>>("expectResponseFc").unwrap_or(None),
        write_type: table.get::<Option<String>>("writeType").unwrap_or(None),
        danger: table.get::<Option<String>>("danger").unwrap_or(None),
        content_revision: table
            .get::<Option<String>>("contentRevision")
            .unwrap_or(None),
    })
}

/// Match inbound bytes against a transaction via the script's global
/// `match_transaction_response(transactionId, dataTable)` function.
pub fn match_transaction_response_with_lua_protocol_file(
    path: PathBuf,
    resource_root: Option<PathBuf>,
    transaction_id: &str,
    data: &[u8],
) -> Result<LuaTransactionMatchResult, AppError> {
    with_cached_file_engine(&path, resource_root.as_deref(), |lua| {
        call_match_transaction_response_function(lua, transaction_id, data)
    })
}

fn call_match_transaction_response_function(
    lua: &Lua,
    transaction_id: &str,
    data: &[u8],
) -> Result<LuaTransactionMatchResult, AppError> {
    arm_execution_limit(lua);
    let match_fn: mlua::Function =
        lua.globals()
            .get("match_transaction_response")
            .map_err(|_| {
                AppError::Protocol(
                    "Lua script must define a global 'match_transaction_response' function"
                        .to_string(),
                )
            })?;
    let data_table = lua
        .create_sequence_from(data.iter().copied())
        .map_err(|error| AppError::Protocol(error.to_string()))?;
    let result: Value = match_fn
        .call((transaction_id, data_table))
        .map_err(|error| {
            AppError::Protocol(format!("Lua match_transaction_response error: {}", error))
        })?;
    let table = match result {
        Value::Table(table) => table,
        other => {
            return Err(AppError::Protocol(format!(
                "match_transaction_response() must return a table, got {}",
                other.type_name()
            )))
        }
    };

    Ok(LuaTransactionMatchResult {
        transaction_id: table
            .get::<Option<String>>("transactionId")
            .unwrap_or(None)
            .unwrap_or_else(|| transaction_id.to_string()),
        matched: table.get::<bool>("matched").map_err(|_| {
            AppError::Protocol(
                "match_transaction_response() result must include boolean 'matched'".to_string(),
            )
        })?,
        expected: lua_table_json_value(lua, &table, "expected")?,
        actual: lua_table_json_value(lua, &table, "actual")?,
        reason: table.get::<Option<String>>("reason").unwrap_or(None),
    })
}

fn lua_table_json_value(
    lua: &Lua,
    table: &Table,
    key: &str,
) -> Result<Option<serde_json::Value>, AppError> {
    let value: Value = table.get(key).unwrap_or(Value::Nil);
    if matches!(value, Value::Nil) {
        return Ok(None);
    }
    lua.from_value(value)
        .map(Some)
        .map_err(|error| AppError::Protocol(format!("invalid '{}' match value: {}", key, error)))
}

fn execute_script(lua: &Lua, script: &str, data: &[u8]) -> Result<ParseResult, AppError> {
    arm_execution_limit(lua);
    lua.load(script)
        .exec()
        .map_err(|e| AppError::Protocol(format!("Lua execution error: {}", e)))?;

    call_parse_function(lua, data)
}

fn call_parse_function(lua: &Lua, data: &[u8]) -> Result<ParseResult, AppError> {
    // Fresh instruction budget per parse call.
    arm_execution_limit(lua);

    let parse_fn: mlua::Function = lua.globals().get("parse").map_err(|_| {
        AppError::Protocol("Lua script must define a global 'parse' function".to_string())
    })?;

    let data_table = lua.create_table()?;
    for (i, &byte) in data.iter().enumerate() {
        data_table.set(i + 1, byte as u32)?;
    }

    let result: Value = parse_fn
        .call((data_table, data.len() as u32))
        .map_err(|e| AppError::Protocol(format!("Lua parse function error: {}", e)))?;

    lua_value_to_parse_result(result)
}

fn protocol_name_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Lua Protocol")
        .to_string()
}

fn setup_sandbox(lua: &Lua) -> Result<(), AppError> {
    let globals = lua.globals();

    if let Ok(os_table) = globals.get::<Table>("os") {
        os_table.set("execute", Value::Nil)?;
        os_table.set("remove", Value::Nil)?;
        os_table.set("rename", Value::Nil)?;
        os_table.set("tmpname", Value::Nil)?;
        os_table.set("exit", Value::Nil)?;
    }

    globals.set("io", Value::Nil)?;
    globals.set("loadfile", Value::Nil)?;
    globals.set("dofile", Value::Nil)?;
    globals.set("require", Value::Nil)?;
    globals.set("load", Value::Nil)?;
    globals.set("debug", Value::Nil)?;
    globals.set("package", Value::Nil)?;

    Ok(())
}

pub(crate) fn register_helpers(lua: &Lua) -> Result<(), AppError> {
    let globals = lua.globals();

    let bytes_to_hex = lua.create_function(|_, tbl: Table| {
        let mut hex = String::new();
        let mut i = 1i64;
        loop {
            match tbl.get::<Option<u8>>(i)? {
                Some(b) => {
                    if !hex.is_empty() {
                        hex.push(' ');
                    }
                    hex.push_str(&format!("{:02X}", b));
                    i += 1;
                }
                None => break,
            }
        }
        Ok(hex)
    })?;
    globals.set("bytes_to_hex", bytes_to_hex)?;

    let hex_to_bytes = lua.create_function(|lua_ctx, hex: String| {
        let stripped: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        if stripped.len() % 2 != 0 {
            return Err(mlua::Error::RuntimeError(
                "hex string has odd length".to_string(),
            ));
        }
        let tbl = lua_ctx.create_table()?;
        for (i, chunk) in stripped.as_bytes().chunks(2).enumerate() {
            let s =
                std::str::from_utf8(chunk).map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
            let b =
                u8::from_str_radix(s, 16).map_err(|e| mlua::Error::RuntimeError(e.to_string()))?;
            tbl.set(i + 1, b)?;
        }
        Ok(tbl)
    })?;
    globals.set("hex_to_bytes", hex_to_bytes)?;

    let read_u8 = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b: u8 = tbl.get(offset + 1).map_err(|_| {
            mlua::Error::RuntimeError(format!("read_u8: offset {} out of bounds", offset))
        })?;
        Ok(b as u32)
    })?;
    globals.set("read_u8", read_u8)?;

    let read_u16_le = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        Ok(u16::from_le_bytes([b0, b1]) as u32)
    })?;
    globals.set("read_u16_le", read_u16_le)?;

    let read_u16_be = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        Ok(u16::from_be_bytes([b0, b1]) as u32)
    })?;
    globals.set("read_u16_be", read_u16_be)?;

    let read_u32_le = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        let b2: u8 = tbl.get(offset + 3)?;
        let b3: u8 = tbl.get(offset + 4)?;
        Ok(u32::from_le_bytes([b0, b1, b2, b3]))
    })?;
    globals.set("read_u32_le", read_u32_le)?;

    let read_u32_be = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        let b2: u8 = tbl.get(offset + 3)?;
        let b3: u8 = tbl.get(offset + 4)?;
        Ok(u32::from_be_bytes([b0, b1, b2, b3]))
    })?;
    globals.set("read_u32_be", read_u32_be)?;

    let read_i8 = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b: u8 = tbl.get(offset + 1)?;
        Ok(b as i8 as i32)
    })?;
    globals.set("read_i8", read_i8)?;

    let read_i16_le = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        Ok(i16::from_le_bytes([b0, b1]) as i32)
    })?;
    globals.set("read_i16_le", read_i16_le)?;

    let read_i32_le = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        let b2: u8 = tbl.get(offset + 3)?;
        let b3: u8 = tbl.get(offset + 4)?;
        Ok(i32::from_le_bytes([b0, b1, b2, b3]))
    })?;
    globals.set("read_i32_le", read_i32_le)?;

    let read_float_le = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        let b2: u8 = tbl.get(offset + 3)?;
        let b3: u8 = tbl.get(offset + 4)?;
        Ok(f32::from_le_bytes([b0, b1, b2, b3]) as f64)
    })?;
    globals.set("read_float_le", read_float_le)?;

    let read_float_be = lua.create_function(|_, (tbl, offset): (Table, usize)| {
        let b0: u8 = tbl.get(offset + 1)?;
        let b1: u8 = tbl.get(offset + 2)?;
        let b2: u8 = tbl.get(offset + 3)?;
        let b3: u8 = tbl.get(offset + 4)?;
        Ok(f32::from_be_bytes([b0, b1, b2, b3]) as f64)
    })?;
    globals.set("read_float_be", read_float_be)?;

    let read_string = lua.create_function(|_, (tbl, offset, length): (Table, usize, usize)| {
        let mut bytes = Vec::with_capacity(length);
        for i in 0..length {
            let b: u8 = tbl.get(offset + i + 1)?;
            if b == 0 {
                break;
            }
            bytes.push(b);
        }
        String::from_utf8(bytes)
            .map_err(|e| mlua::Error::RuntimeError(format!("invalid UTF-8: {}", e)))
    })?;
    globals.set("read_string", read_string)?;

    Ok(())
}

const LUA_FILE_READ_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

/// Resolve a script-relative path and enforce that it stays inside the script's
/// directory. Canonicalization also resolves symlinks, so a link pointing
/// outside the sandbox root is rejected by the prefix check.
fn resolve_sandboxed_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("path is empty".to_string());
    }
    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err(format!(
            "'{}' must be relative to the script directory",
            relative
        ));
    }
    let joined = base.join(candidate);
    let resolved = joined
        .canonicalize()
        .map_err(|e| format!("'{}': {}", relative, e))?;
    if !resolved.starts_with(base) {
        return Err(format!("'{}' escapes the protocol resource root", relative));
    }
    Ok(resolved)
}

/// File helpers for data-driven protocol scripts (e.g. schema-package loaders).
/// Only registered on the file-based engine paths, where the script's own
/// directory is the default sandbox root; callers may provide a separate resource root.
fn register_file_helpers(lua: &Lua, resource_root: &Path) -> Result<(), AppError> {
    let base = resource_root
        .canonicalize()
        .map_err(|e| AppError::Protocol(format!("protocol resource root: {}", e)))?;
    let globals = lua.globals();

    let read_base = base.clone();
    let read_text_file = lua.create_function(move |_, relative: String| {
        let path = resolve_sandboxed_path(&read_base, &relative)
            .map_err(|e| mlua::Error::RuntimeError(format!("read_text_file: {}", e)))?;
        let metadata = fs::metadata(&path).map_err(|e| {
            mlua::Error::RuntimeError(format!("read_text_file: '{}': {}", relative, e))
        })?;
        if metadata.len() > LUA_FILE_READ_LIMIT_BYTES {
            return Err(mlua::Error::RuntimeError(format!(
                "read_text_file: '{}' is {} bytes, limit is {}",
                relative,
                metadata.len(),
                LUA_FILE_READ_LIMIT_BYTES
            )));
        }
        fs::read_to_string(&path).map_err(|e| {
            mlua::Error::RuntimeError(format!("read_text_file: '{}': {}", relative, e))
        })
    })?;
    globals.set("read_text_file", read_text_file)?;

    let mtime_base = base;
    let file_mtime = lua.create_function(move |_, relative: String| {
        let mtime = resolve_sandboxed_path(&mtime_base, &relative)
            .ok()
            .and_then(|path| fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);
        Ok(mtime)
    })?;
    globals.set("file_mtime", file_mtime)?;

    Ok(())
}

fn lua_value_to_parse_result(value: Value) -> Result<ParseResult, AppError> {
    let tbl = match value {
        Value::Table(t) => t,
        other => {
            return Err(AppError::Protocol(format!(
                "parse() must return a table, got {:?}",
                other.type_name()
            )))
        }
    };

    let mut fields: Vec<ParsedField> = Vec::new();
    let mut data_groups: Vec<DataGroup> = Vec::new();

    if let Ok(fields_tbl) = tbl.get::<Table>("fields") {
        for pair in fields_tbl.sequence_values::<Table>() {
            let field_tbl = pair.map_err(|e| AppError::Protocol(e.to_string()))?;
            fields.push(lua_table_to_parsed_field(field_tbl)?);
        }
    } else {
        // Fallback: direct array return (e.g., `return fields` instead of `return { fields = fields }`)
        // Treat the returned table itself as the fields array
        for pair in tbl.sequence_values::<Table>() {
            let field_tbl = pair.map_err(|e| AppError::Protocol(e.to_string()))?;
            fields.push(lua_table_to_parsed_field(field_tbl)?);
        }
    }

    if let Ok(groups_tbl) = tbl.get::<Table>("groups") {
        for pair in groups_tbl.sequence_values::<Table>() {
            let group_tbl = pair.map_err(|e| AppError::Protocol(e.to_string()))?;
            let name: String = group_tbl
                .get("name")
                .unwrap_or_else(|_| "unnamed".to_string());
            let mut group_fields: Vec<ParsedField> = Vec::new();
            if let Ok(gf_tbl) = group_tbl.get::<Table>("fields") {
                for fp in gf_tbl.sequence_values::<Table>() {
                    let ft = fp.map_err(|e| AppError::Protocol(e.to_string()))?;
                    group_fields.push(lua_table_to_parsed_field(ft)?);
                }
            }
            data_groups.push(DataGroup {
                name,
                fields: group_fields,
            });
        }
    }

    // Optional unconsumed-bytes report for stream reassembly, mirroring the
    // FieldDefinition parser. Accept `remaining` or `remaining_bytes`.
    let mut remaining_bytes: Vec<u8> = Vec::new();
    for key in ["remaining", "remaining_bytes"] {
        if let Ok(Value::Table(remaining_tbl)) = tbl.get::<Value>(key) {
            for byte in remaining_tbl.sequence_values::<u8>() {
                remaining_bytes.push(byte.map_err(|e| {
                    AppError::Protocol(format!("invalid byte in '{}': {}", key, e))
                })?);
            }
            break;
        }
    }

    Ok(ParseResult {
        fields,
        remaining_bytes,
        data_groups,
    })
}

fn lua_table_to_parsed_field(tbl: Table) -> Result<ParsedField, AppError> {
    let id: Option<String> = tbl.get("id").ok();
    let alias: Option<String> = tbl.get("alias").ok();
    let name: String = tbl
        .get("name")
        .unwrap_or_else(|_| id.clone().unwrap_or_else(|| "unknown".to_string()));

    let display: String = tbl.get("display").unwrap_or_else(|_| String::new());

    let value: FieldValue = match tbl.get::<Value>("value") {
        Ok(Value::Integer(n)) => FieldValue::Integer(n),
        Ok(Value::Number(f)) => FieldValue::Float(f),
        Ok(Value::Boolean(b)) => FieldValue::Bool(b),
        Ok(Value::String(s)) => FieldValue::String(
            s.to_str()
                .map_err(|e| AppError::Protocol(e.to_string()))?
                .to_string(),
        ),
        Ok(Value::Table(t)) => {
            let mut bytes = Vec::new();
            for v in t.sequence_values::<u8>() {
                bytes.push(v.map_err(|e| AppError::Protocol(e.to_string()))?);
            }
            FieldValue::Bytes(bytes)
        }
        _ => FieldValue::String(String::new()),
    };

    let raw_bytes: Vec<u8> = match tbl.get::<Value>("raw_bytes") {
        Ok(Value::Table(t)) => {
            let mut bytes = Vec::new();
            for v in t.sequence_values::<u8>() {
                bytes.push(v.map_err(|e| AppError::Protocol(e.to_string()))?);
            }
            bytes
        }
        _ => vec![],
    };

    Ok(ParsedField {
        id,
        alias,
        name,
        raw_bytes,
        value,
        display,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lua_basic_parse() {
        let mut engine = LuaEngine::new().unwrap();
        let script = r#"
function parse(data, length)
    local val = read_u8(data, 0)
    return {
        fields = {
            { id = "byte0", alias = "Byte 0", name = "byte0", value = val, display = tostring(val), raw_bytes = {data[1]} }
        },
        groups = {}
    }
end
"#;
        engine.load_script(script).unwrap();
        let data = [0xABu8];
        let result = engine.execute(&data).unwrap();
        assert_eq!(result.fields.len(), 1);
        assert_eq!(result.fields[0].id.as_deref(), Some("byte0"));
    }

    #[test]
    fn test_parse_with_lua_file_reuses_cached_engine_until_file_changes() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("linkassist_lua_cache_test_{}.lua", stamp));

        let counter_script = r#"
local count = 0
function parse(data, length)
    count = count + 1
    return { fields = { { id = "count", name = "count", value = count, display = tostring(count) } } }
end
"#;
        std::fs::write(&path, counter_script).unwrap();

        let first = parse_with_lua_protocol_file(path.clone(), None, &[0x01]).unwrap();
        let second = parse_with_lua_protocol_file(path.clone(), None, &[0x01]).unwrap();
        // Same VM reused: top-level `count` persisted across calls.
        assert_eq!(first.fields[0].value, FieldValue::Integer(1));
        assert_eq!(second.fields[0].value, FieldValue::Integer(2));

        // Changing the file (different length) invalidates the cache.
        std::fs::write(&path, format!("{counter_script}\n-- v2")).unwrap();
        let third = parse_with_lua_protocol_file(path.clone(), None, &[0x01]).unwrap();
        assert_eq!(third.fields[0].value, FieldValue::Integer(1));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_encode_field_with_lua_file() {
        let dir = unique_temp_dir("encode");
        let script_path = dir.join("proto.lua");
        std::fs::write(
            &script_path,
            r#"
function parse(data, length) return { fields = {} } end
function encode(fieldId, value)
    if fieldId == "addr" then
        return { offset = 0, bytes = { (tonumber(value, 16) & 0x7F) | 0x80 } }
    elseif fieldId == "word" then
        local n = tonumber(value, 16)
        return { offset = 4, bytes = { n & 0xFF, (n >> 8) & 0xFF } }
    end
    return nil
end
"#,
        )
        .unwrap();

        let header =
            encode_field_with_lua_protocol_file(script_path.clone(), None, "addr", "29").unwrap();
        assert_eq!(header.offset, 0);
        assert_eq!(header.bytes, vec![0xA9]);

        let word =
            encode_field_with_lua_protocol_file(script_path.clone(), None, "word", "1234").unwrap();
        assert_eq!(word.offset, 4);
        assert_eq!(word.bytes, vec![0x34, 0x12]);

        // A field the script cannot encode returns nil -> a clear error the host can surface.
        let err = encode_field_with_lua_protocol_file(script_path, None, "other", "0").unwrap_err();
        assert!(format!("{err:?}").contains("not directly encodable"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_encode_transaction_with_lua_file() {
        let dir = unique_temp_dir("encode_tx");
        let script_path = dir.join("proto.lua");
        std::fs::write(
            &script_path,
            r#"
function parse(data, length) return { fields = {} } end
function encode_transaction(id, valuesJson)
    if id ~= "demo" then error("unknown transaction '" .. tostring(id) .. "'") end
    -- echo a couple of bytes derived from the JSON so we can assert the string reached Lua
    local n = tonumber(valuesJson:match('"n":(%d+)') or "0")
    return {
        transactionId = id,
        bytes = { 0xA9, 0xF2, n & 0xFF },
        channelId = "control",
        characteristicUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        serviceUuid = "11111111-2222-3333-4444-555555555555",
        requestFunctionCode = 2,
        expectResponseFc = 5,
        writeType = "withoutResponse",
        danger = "write",
        contentRevision = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }
end
"#,
        )
        .unwrap();

        let result = encode_transaction_with_lua_protocol_file(
            script_path.clone(),
            None,
            "demo",
            r#"{"n":7}"#,
        )
        .unwrap();
        assert_eq!(result.bytes, vec![0xA9, 0xF2, 0x07]);
        assert_eq!(result.transaction_id, "demo");
        assert_eq!(result.channel_id.as_deref(), Some("control"));
        assert_eq!(
            result.characteristic_uuid.as_deref(),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
        assert_eq!(result.request_function_code, 2);
        assert_eq!(result.expect_response_function_code, Some(5));
        assert_eq!(result.write_type.as_deref(), Some("withoutResponse"));
        assert_eq!(result.danger.as_deref(), Some("write"));
        assert_eq!(
            result.content_revision.as_deref(),
            Some("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );

        let err = encode_transaction_with_lua_protocol_file(script_path, None, "missing", "{}")
            .unwrap_err();
        assert!(format!("{err:?}").contains("unknown transaction"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_match_transaction_response_with_lua_file() {
        let dir = unique_temp_dir("match_tx");
        let script_path = dir.join("proto.lua");
        std::fs::write(
            &script_path,
            r#"
function parse(data, length) return { fields = {} } end
function match_transaction_response(id, data)
    local expected = { transactionId = id, firstByte = 0xA5 }
    local actual = { firstByte = data[1], length = #data }
    if data[1] == 0xA5 then
        return { matched = true, expected = expected, actual = actual }
    end
    return {
        matched = false,
        expected = expected,
        actual = actual,
        reason = "first byte mismatch",
    }
end
"#,
        )
        .unwrap();

        let matched = match_transaction_response_with_lua_protocol_file(
            script_path.clone(),
            None,
            "demo",
            &[0xA5, 0x01],
        )
        .unwrap();
        assert!(matched.matched);
        assert_eq!(matched.transaction_id, "demo");
        assert_eq!(matched.expected.as_ref().unwrap()["transactionId"], "demo");
        assert_eq!(matched.actual.as_ref().unwrap()["length"], 2);
        assert!(matched.reason.is_none());

        let mismatch =
            match_transaction_response_with_lua_protocol_file(script_path, None, "demo", &[0x00])
                .unwrap();
        assert!(!mismatch.matched);
        assert_eq!(mismatch.reason.as_deref(), Some("first byte mismatch"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_lua_parse_reports_remaining_bytes() {
        let mut engine = LuaEngine::new().unwrap();
        let script = r#"
function parse(data, length)
    return {
        fields = {
            { id = "b0", name = "b0", value = data[1], display = tostring(data[1]) }
        },
        remaining = { data[2], data[3] }
    }
end
"#;
        engine.load_script(script).unwrap();
        let result = engine.execute(&[0x01, 0x02, 0x03]).unwrap();
        assert_eq!(result.fields.len(), 1);
        assert_eq!(result.remaining_bytes, vec![0x02, 0x03]);
    }

    #[test]
    fn test_lua_instruction_budget_stops_infinite_loop() {
        let mut engine = LuaEngine::new().unwrap();
        let script = r#"
function parse(data, length)
    while true do end
end
"#;
        engine.load_script(script).unwrap();
        let error = engine
            .execute(&[0x00])
            .expect_err("infinite loop should be interrupted")
            .to_string();
        assert!(error.contains("instruction budget"), "error was: {}", error);
    }

    #[test]
    fn test_lua_cancellation_interrupts_execution_and_is_consumed_for_cleanup() {
        let lua = Lua::new();
        let cancellation = Arc::new(AtomicBool::new(true));
        arm_execution_limit_with_cancellation(&lua, Some(cancellation.clone()));
        let (ok, cleaned): (bool, bool) = lua
            .load(
                "local cleaned = false; local ok = pcall(function() local total = 0; \
                 for i = 1, 20000 do total = total + i end end); cleaned = true; \
                 return ok, cleaned",
            )
            .eval()
            .expect("the cancellation should be catchable so cleanup can finish");
        assert!(!ok);
        assert!(cleaned);
        assert!(!cancellation.load(Ordering::SeqCst));
    }

    #[test]
    fn test_lua_schema() {
        let path = std::env::temp_dir().join("linkassist_lua_schema_test.lua");
        std::fs::write(
            &path,
            r#"
function schema()
  return {
    { id = "temperature", alias = "Temperature" },
    { id = "humidity", alias = "Humidity", description = "Relative humidity" }
  }
end

function parse(data, length)
  return { fields = {} }
end
"#,
        )
        .unwrap();

        let summary = summarize_lua_protocol_file(path.clone(), None).unwrap();
        assert_eq!(summary.fields.len(), 2);
        assert_eq!(summary.fields[0].id, "temperature");
        let _ = std::fs::remove_file(path);
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("linkassist_file_helper_{}_{}", tag, stamp));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_read_text_file_reads_sibling_files() {
        let dir = unique_temp_dir("read");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("data.txt"), "hello schema").unwrap();
        let script_path = dir.join("script.lua");
        std::fs::write(
            &script_path,
            r#"
local content = read_text_file("sub/data.txt")
local mtime = file_mtime("sub/data.txt")
function parse(data, length)
    return { fields = {
        { id = "content", name = "content", value = content, display = content },
        { id = "has_mtime", name = "has_mtime", value = mtime ~= nil, display = "" },
    } }
end
"#,
        )
        .unwrap();

        let result = parse_with_lua_protocol_file(script_path, None, &[0x00]).unwrap();
        assert_eq!(
            result.fields[0].value,
            FieldValue::String("hello schema".to_string())
        );
        assert_eq!(result.fields[1].value, FieldValue::Bool(true));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_protocol_resource_root_is_external_and_part_of_cache_key() {
        let script_dir = unique_temp_dir("adapter");
        let root_a = unique_temp_dir("root_a");
        let root_b = unique_temp_dir("root_b");
        std::fs::write(root_a.join("value.txt"), "A").unwrap();
        std::fs::write(root_b.join("value.txt"), "B").unwrap();
        let script_path = script_dir.join("protocol.lua");
        std::fs::write(
            &script_path,
            r#"
local value = read_text_file("value.txt")
function parse(data, length)
    return { fields = { { id = "value", name = "value", value = value, display = value } } }
end
"#,
        )
        .unwrap();

        let parsed_a =
            parse_with_lua_protocol_file(script_path.clone(), Some(root_a.clone()), &[]).unwrap();
        let parsed_b =
            parse_with_lua_protocol_file(script_path, Some(root_b.clone()), &[]).unwrap();
        assert_eq!(
            parsed_a.fields[0].value,
            FieldValue::String("A".to_string())
        );
        assert_eq!(
            parsed_b.fields[0].value,
            FieldValue::String("B".to_string())
        );

        let _ = std::fs::remove_dir_all(script_dir);
        let _ = std::fs::remove_dir_all(root_a);
        let _ = std::fs::remove_dir_all(root_b);
    }

    #[test]
    fn test_read_text_file_rejects_escape_and_absolute_paths() {
        let dir = unique_temp_dir("escape");
        let parent_secret = dir.parent().expect("temp dir has a parent").join(format!(
            "secret_{}.txt",
            dir.file_name().unwrap().to_string_lossy()
        ));
        std::fs::write(&parent_secret, "secret").unwrap();
        let script_path = dir.join("script.lua");
        let escape_target = format!(
            "../{}",
            parent_secret.file_name().unwrap().to_string_lossy()
        );
        std::fs::write(
            &script_path,
            format!(
                r#"
function parse(data, length)
    local ok_rel = pcall(read_text_file, "{escape}")
    local ok_abs = pcall(read_text_file, "C:/Windows/win.ini")
    return {{ fields = {{
        {{ id = "escape_blocked", name = "escape_blocked", value = not ok_rel, display = "" }},
        {{ id = "absolute_blocked", name = "absolute_blocked", value = not ok_abs, display = "" }},
    }} }}
end
"#,
                escape = escape_target.replace('\\', "/")
            ),
        )
        .unwrap();

        let result = parse_with_lua_protocol_file(script_path, None, &[0x00]).unwrap();
        assert_eq!(result.fields[0].value, FieldValue::Bool(true));
        assert_eq!(result.fields[1].value, FieldValue::Bool(true));
        let _ = std::fs::remove_file(parent_secret);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_file_mtime_returns_nil_for_missing_file() {
        let dir = unique_temp_dir("mtime");
        let script_path = dir.join("script.lua");
        std::fs::write(
            &script_path,
            r#"
function parse(data, length)
    return { fields = {
        { id = "missing_is_nil", name = "missing_is_nil", value = file_mtime("nope.json") == nil, display = "" },
    } }
end
"#,
        )
        .unwrap();

        let result = parse_with_lua_protocol_file(script_path, None, &[0x00]).unwrap();
        assert_eq!(result.fields[0].value, FieldValue::Bool(true));
        let _ = std::fs::remove_dir_all(dir);
    }
}
