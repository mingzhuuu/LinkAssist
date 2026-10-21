use crate::protocol::lua_engine::{
    apply_memory_limit, arm_execution_limit, register_helpers as register_binary_helpers,
};
use crate::script_markers::{ensure_lua_script_kind, LuaScriptKind};
use crate::{AppError, AppResult};
use mlua::{Function as LuaFunction, Lua, LuaSerdeExt, Table, Value as LuaValue};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

struct CachedScriptHelper {
    modified: Option<SystemTime>,
    len: u64,
    kind: LuaScriptKind,
    lua: Lua,
    functions: HashSet<String>,
}

type ScriptHelperSlot = Arc<Mutex<Option<CachedScriptHelper>>>;

static SCRIPT_HELPER_CACHE: OnceLock<Mutex<HashMap<PathBuf, ScriptHelperSlot>>> = OnceLock::new();

/// Execute one declared function from a pure Script Helper Lua file.
///
/// Script Helpers intentionally receive only JSON arguments and binary conversion helpers. They
/// have no AppState, channel, MCP, filesystem, process, or session-state capabilities.
pub fn call_lua_script_helper_file(
    file_path: &str,
    base_file_path: Option<&str>,
    function_name: &str,
    args: Value,
) -> AppResult<Value> {
    let path = resolve_helper_path(file_path, base_file_path)?;
    call_lua_helper(&path, LuaScriptKind::ScriptHelper, function_name, args)
}

/// Execute a pure helper declared inside its owning automation script.
///
/// The helper path must resolve to the same file as `base_file_path`; this prevents the embedded
/// mode from being used as a general way to execute unrelated automation scripts.
pub fn call_lua_embedded_script_helper_file(
    file_path: &str,
    base_file_path: Option<&str>,
    function_name: &str,
    args: Value,
) -> AppResult<Value> {
    let path = resolve_helper_path(file_path, base_file_path)?;
    let owner_path = base_file_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::Protocol(
                "Embedded Lua script helper requires the owning automation script path".to_string(),
            )
        })?;
    let owner = resolve_helper_path(owner_path, None)?;
    if path != owner {
        return Err(AppError::Protocol(
            "Embedded Lua script helper must use the owning automation script file".to_string(),
        ));
    }
    call_lua_helper(&path, LuaScriptKind::Script, function_name, args)
}

fn call_lua_helper(
    path: &Path,
    kind: LuaScriptKind,
    function_name: &str,
    args: Value,
) -> AppResult<Value> {
    validate_helper_name(function_name)?;
    if !args.is_object() {
        return Err(AppError::Protocol(
            "Lua script helper args must be an object".to_string(),
        ));
    }

    with_cached_helper(path, kind, |helper| {
        if !helper.functions.contains(function_name) {
            return Err(AppError::Protocol(format!(
                "Lua script helper '{}' does not declare a function named '{}'",
                path.display(),
                function_name
            )));
        }

        arm_execution_limit(&helper.lua);
        let call_fn: LuaFunction = helper.lua.globals().get("call").map_err(|_| {
            AppError::Protocol("Lua script helper must define a global 'call' function".to_string())
        })?;
        let lua_args = helper.lua.to_value(&args).map_err(|error| {
            AppError::Protocol(format!("Lua script helper args conversion error: {error}"))
        })?;
        let result: LuaValue = call_fn
            .call((function_name.to_string(), lua_args))
            .map_err(|error| {
                AppError::Protocol(format!(
                    "Lua script helper '{}' call '{}' failed: {}",
                    path.display(),
                    function_name,
                    error
                ))
            })?;
        helper.lua.from_value(result).map_err(|error| {
            AppError::Protocol(format!(
                "Lua script helper '{}' result conversion error: {}",
                path.display(),
                error
            ))
        })
    })
}

fn resolve_helper_path(file_path: &str, base_file_path: Option<&str>) -> AppResult<PathBuf> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Protocol(
            "Lua script helper filePath must not be empty".to_string(),
        ));
    }

    let requested = PathBuf::from(trimmed);
    let candidate = if requested.is_absolute() {
        requested
    } else {
        let base_file_path = base_file_path
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                AppError::Protocol(
                    "Relative Lua script helper filePath requires baseFilePath".to_string(),
                )
            })?;
        let base_path = PathBuf::from(base_file_path);
        if !base_path.is_absolute() {
            return Err(AppError::Protocol(
                "Lua script helper baseFilePath must be absolute".to_string(),
            ));
        }
        let base_directory = if base_path.is_dir() {
            base_path.as_path()
        } else {
            base_path.parent().ok_or_else(|| {
                AppError::Protocol(
                    "Lua script helper baseFilePath has no parent directory".to_string(),
                )
            })?
        };
        base_directory.join(requested)
    };

    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        AppError::Protocol(format!(
            "Unable to resolve Lua script helper '{}': {}",
            candidate.display(),
            error
        ))
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        AppError::Protocol(format!(
            "Unable to inspect Lua script helper '{}': {}",
            canonical.display(),
            error
        ))
    })?;
    if !metadata.is_file() {
        return Err(AppError::Protocol(format!(
            "Lua script helper path is not a file: '{}'",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn helper_slot(path: &Path) -> ScriptHelperSlot {
    let cache = SCRIPT_HELPER_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut entries = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    entries.entry(path.to_path_buf()).or_default().clone()
}

fn with_cached_helper<T>(
    path: &Path,
    kind: LuaScriptKind,
    body: impl FnOnce(&CachedScriptHelper) -> AppResult<T>,
) -> AppResult<T> {
    let metadata = fs::metadata(path).map_err(|error| {
        AppError::Protocol(format!(
            "Unable to inspect Lua script helper '{}': {}",
            path.display(),
            error
        ))
    })?;
    let modified = metadata.modified().ok();
    let len = metadata.len();
    let slot = helper_slot(path);
    let mut guard = slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let needs_rebuild = match guard.as_ref() {
        Some(cached) => cached.modified != modified || cached.len != len || cached.kind != kind,
        None => true,
    };
    if needs_rebuild {
        let (lua, functions) = build_helper(path, kind)?;
        *guard = Some(CachedScriptHelper {
            modified,
            len,
            kind,
            lua,
            functions,
        });
    }

    let helper = guard.as_ref().ok_or_else(|| {
        AppError::Protocol("Lua script helper cache was not initialized".to_string())
    })?;
    body(helper)
}

fn build_helper(path: &Path, kind: LuaScriptKind) -> AppResult<(Lua, HashSet<String>)> {
    let script = fs::read_to_string(path).map_err(|error| {
        AppError::Protocol(format!(
            "Unable to read Lua script helper '{}': {}",
            path.display(),
            error
        ))
    })?;
    ensure_lua_script_kind(&script, kind)?;

    let lua = Lua::new();
    apply_memory_limit(&lua);
    setup_sandbox(&lua)?;
    register_binary_helpers(&lua)?;
    arm_execution_limit(&lua);
    lua.load(&script).exec().map_err(|error| {
        AppError::Protocol(format!(
            "Lua script helper '{}' load error: {}",
            path.display(),
            error
        ))
    })?;

    let globals = lua.globals();
    let helpers_fn: LuaFunction = globals.get("helpers").map_err(|_| {
        AppError::Protocol("Lua script helper must define a global 'helpers' function".to_string())
    })?;
    let declared: LuaValue = helpers_fn.call(()).map_err(|error| {
        AppError::Protocol(format!(
            "Lua script helper '{}' helpers() failed: {}",
            path.display(),
            error
        ))
    })?;
    let table = match declared {
        LuaValue::Table(table) => table,
        other => {
            return Err(AppError::Protocol(format!(
                "Lua script helper helpers() must return an array table, got {}",
                other.type_name()
            )))
        }
    };
    let functions = parse_declared_helpers(table)?;
    if functions.is_empty() {
        return Err(AppError::Protocol(
            "Lua script helper helpers() must declare at least one function".to_string(),
        ));
    }

    let _: LuaFunction = globals.get("call").map_err(|_| {
        AppError::Protocol("Lua script helper must define a global 'call' function".to_string())
    })?;
    drop(globals);
    Ok((lua, functions))
}

fn parse_declared_helpers(table: Table) -> AppResult<HashSet<String>> {
    let mut functions = HashSet::new();
    for item in table.sequence_values::<LuaValue>() {
        let item = item.map_err(|error| {
            AppError::Protocol(format!("Invalid Lua script helper metadata: {error}"))
        })?;
        let name = match item {
            LuaValue::String(value) => value
                .to_str()
                .map_err(|error| {
                    AppError::Protocol(format!("Invalid Lua script helper function name: {error}"))
                })?
                .to_string(),
            LuaValue::Table(value) => value.get::<String>("name").map_err(|_| {
                AppError::Protocol(
                    "Each helpers() entry must be a name string or a table containing 'name'"
                        .to_string(),
                )
            })?,
            other => {
                return Err(AppError::Protocol(format!(
                    "Each helpers() entry must be a string or table, got {}",
                    other.type_name()
                )))
            }
        };
        validate_helper_name(&name)?;
        if !functions.insert(name.clone()) {
            return Err(AppError::Protocol(format!(
                "Lua script helper declares duplicate function '{}'",
                name
            )));
        }
    }
    Ok(functions)
}

fn validate_helper_name(value: &str) -> AppResult<()> {
    if value.is_empty()
        || value.len() > 128
        || value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(AppError::Protocol(
            "Lua script helper function name must be 1-128 ASCII letters, digits, '.', '_' or '-'"
                .to_string(),
        ));
    }
    Ok(())
}

fn setup_sandbox(lua: &Lua) -> AppResult<()> {
    let globals = lua.globals();
    for name in [
        "os", "io", "loadfile", "dofile", "require", "load", "debug", "package",
    ] {
        globals.set(name, LuaValue::Nil)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    const BUNDLED_TEST_BENCH_HELPER: &str =
        include_str!("../../config/script-helper/script-helper-test-bench.lua");
    const BUNDLED_METER_SCRIPT: &str =
        include_str!("../../config/script/script-serial-rpm-example.lua");

    fn test_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "linkassist-script-helper-{}-{}-{}",
            label,
            std::process::id(),
            unique
        ))
    }

    fn write_helper(directory: &Path, name: &str, content: &str) -> PathBuf {
        fs::create_dir_all(directory).expect("create script helper test directory");
        let path = directory.join(name);
        fs::write(&path, content).expect("write script helper test file");
        path
    }

    fn cleanup(directory: &Path, files: &[&Path]) {
        for file in files {
            let _ = fs::remove_file(file);
        }
        let _ = fs::remove_dir(directory);
    }

    fn call_bundled_helper(path: &Path, function_name: &str, args: Value) -> Value {
        call_lua_script_helper_file(
            path.to_str().expect("UTF-8 bundled helper path"),
            None,
            function_name,
            args,
        )
        .unwrap_or_else(|error| panic!("bundled helper '{function_name}' failed: {error}"))
    }

    fn crc16_modbus(bytes: &[u8]) -> u16 {
        let mut crc = 0xFFFF_u16;
        for byte in bytes {
            crc ^= u16::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xA001
                } else {
                    crc >> 1
                };
            }
        }
        crc
    }

    fn torque_frame(torque_hz: f32, speed_hz: f32) -> Vec<u8> {
        let mut bytes = vec![0x01, 0x32, 0x08];
        bytes.extend_from_slice(&torque_hz.to_le_bytes());
        bytes.extend_from_slice(&speed_hz.to_le_bytes());
        let crc = crc16_modbus(&bytes);
        bytes.extend_from_slice(&crc.to_le_bytes());
        bytes
    }

    fn assert_json_number(value: &Value, field: &str, expected: f64) {
        let actual = value
            .get(field)
            .and_then(Value::as_f64)
            .unwrap_or_else(|| panic!("'{field}' must be numeric in {value}"));
        assert!(
            (actual - expected).abs() < 0.000_001,
            "'{field}' was {actual}, expected {expected} in {value}"
        );
    }

    #[test]
    fn calls_declared_helper_with_binary_helpers_and_strict_sandbox() {
        let directory = test_directory("call");
        let path = write_helper(
            &directory,
            "bench.lua",
            r#"-- linkassist:type = script-helper
function helpers()
  return { { name = "decode" }, "sandbox" }
end

function call(name, args)
  if name == "decode" then
    return { value = read_u16_le(args.bytes, 0), hex = bytes_to_hex(args.bytes) }
  end
  if name == "sandbox" then
    return {
      os = type(os), io = type(io), require = type(require), load = type(load),
      invokeTool = type(invoke_tool), send = type(send), openChannel = type(open_current_channel),
    }
  end
  error("unknown helper")
end
"#,
        );

        let decoded = call_lua_script_helper_file(
            path.to_str().expect("UTF-8 path"),
            None,
            "decode",
            json!({ "bytes": [0x34, 0x12] }),
        )
        .expect("decode helper result");
        assert_eq!(decoded, json!({ "value": 0x1234, "hex": "34 12" }));

        let sandbox = call_lua_script_helper_file(
            path.to_str().expect("UTF-8 path"),
            None,
            "sandbox",
            json!({}),
        )
        .expect("sandbox helper result");
        assert_eq!(
            sandbox,
            json!({
                "os": "nil",
                "io": "nil",
                "require": "nil",
                "load": "nil",
                "invokeTool": "nil",
                "send": "nil",
                "openChannel": "nil",
            })
        );

        cleanup(&directory, &[&path]);
    }

    #[test]
    fn calls_helpers_embedded_in_the_owning_automation_script() {
        let directory = test_directory("embedded");
        let path = write_helper(
            &directory,
            "script-serial-rpm-example.lua",
            BUNDLED_METER_SCRIPT,
        );
        let file_path = path.to_str().expect("UTF-8 embedded script path");
        let zero = torque_frame(1000.0, 0.0);
        let sample = torque_frame(1500.0, 1024.0);

        let measurement = call_lua_embedded_script_helper_file(
            file_path,
            Some(file_path),
            "torqueMeasurement",
            json!({
                "sampleBytes": sample,
                "zeroBytes": zero,
                "toothCount": 1024,
            }),
        )
        .expect("embedded torque measurement");
        assert_json_number(&measurement, "torqueNm", 10.0);
        assert_json_number(&measurement, "rpm", 60.0);
        assert_json_number(&measurement, "powerW", 62.832);

        let control = call_lua_embedded_script_helper_file(
            file_path,
            Some(file_path),
            "prepareControl",
            json!({
                "rpm": 100,
                "direction": 1,
                "delay": 2.25,
                "mode": "percent",
                "value": 50,
                "resistanceRangeBytes": [0, 100, 1],
            }),
        )
        .expect("embedded control preparation");
        assert_eq!(
            control,
            json!({
                "motorCommand": "W5360333BE,",
                "ftmsCommandHex": "04 32",
                "ftmsResponsePrefix": "80 04 01",
                "sampleCount": 2,
                "sampleRemainderMs": 250,
            })
        );

        let custom_data = call_lua_embedded_script_helper_file(
            file_path,
            Some(file_path),
            "ftmsCustomData",
            json!({
                "packet": {
                    "available": true,
                    "bytes": [
                        0x01, 0x00,
                        0xDC, 0x05,
                        0xF5, 0xFF,
                        0xFA, 0x00,
                        0x07, 0x01,
                        0x50, 0x04
                    ]
                }
            }),
        )
        .expect("embedded FTMS custom data");
        assert_eq!(custom_data.get("valid"), Some(&json!(true)));
        assert_eq!(custom_data.get("rearWheelSpeedRpm"), Some(&json!(1500)));
        assert_eq!(custom_data.get("adcCurrent"), Some(&json!(-11)));
        assert_eq!(custom_data.get("wheelTemperatureC"), Some(&json!("")));

        let infrared = call_lua_embedded_script_helper_file(
            file_path,
            Some(file_path),
            "infraredTemperature",
            json!({ "bytes": [0x01, 0x03, 0x02, 0x01, 0x07, 0xF8, 0x16] }),
        )
        .expect("embedded infrared temperature");
        assert_json_number(&infrared, "temperatureC", 26.3);

        cleanup(&directory, &[&path]);
    }

    #[test]
    fn embedded_helper_rejects_a_file_other_than_its_owning_script() {
        let directory = test_directory("embedded-owner");
        let owner = write_helper(&directory, "owner.lua", BUNDLED_METER_SCRIPT);
        let other = write_helper(&directory, "other.lua", BUNDLED_METER_SCRIPT);

        let error = call_lua_embedded_script_helper_file(
            other.to_str().expect("UTF-8 other script path"),
            Some(owner.to_str().expect("UTF-8 owner script path")),
            "torqueFrameValid",
            json!({ "bytes": [] }),
        )
        .expect_err("another script must not be callable as an embedded helper")
        .to_string();
        assert!(error.contains("must use the owning automation script file"));

        cleanup(&directory, &[&owner, &other]);
    }

    #[test]
    fn resolves_relative_helper_from_base_script_file() {
        let directory = test_directory("relative");
        let base_path = write_helper(&directory, "automation.lua", "-- test base file");
        let helper_path = write_helper(
            &directory,
            "helper.lua",
            r#"-- linkassist:type = script-helper
function helpers() return { "answer" } end
function call(name, args) return { value = 42 } end
"#,
        );

        let result = call_lua_script_helper_file(
            "helper.lua",
            Some(base_path.to_str().expect("UTF-8 path")),
            "answer",
            json!({}),
        )
        .expect("relative helper result");
        assert_eq!(result, json!({ "value": 42 }));

        cleanup(&directory, &[&base_path, &helper_path]);
    }

    #[test]
    fn reloads_cached_helper_when_file_size_changes() {
        let directory = test_directory("reload");
        let path = write_helper(
            &directory,
            "helper.lua",
            r#"-- linkassist:type = script-helper
function helpers() return { "value" } end
function call(name, args) return 1 end
"#,
        );
        let file_path = path.to_str().expect("UTF-8 path");
        assert_eq!(
            call_lua_script_helper_file(file_path, None, "value", json!({}))
                .expect("initial helper result"),
            json!(1)
        );

        fs::write(
            &path,
            r#"-- linkassist:type = script-helper
-- changed length forces cache refresh even on coarse timestamp filesystems
function helpers() return { "value" } end
function call(name, args) return 22 end
"#,
        )
        .expect("rewrite helper file");
        assert_eq!(
            call_lua_script_helper_file(file_path, None, "value", json!({}))
                .expect("reloaded helper result"),
            json!(22)
        );

        cleanup(&directory, &[&path]);
    }

    #[test]
    fn rejects_wrong_marker_and_undeclared_function() {
        let directory = test_directory("reject");
        let wrong_marker = write_helper(
            &directory,
            "wrong.lua",
            r#"-- linkassist:type = mcp
function helpers() return { "value" } end
function call(name, args) return 1 end
"#,
        );
        let error = call_lua_script_helper_file(
            wrong_marker.to_str().expect("UTF-8 path"),
            None,
            "value",
            json!({}),
        )
        .expect_err("wrong marker must fail")
        .to_string();
        assert!(error.contains("Expected Lua script helper file marker"));

        let helper_path = write_helper(
            &directory,
            "helper.lua",
            r#"-- linkassist:type = script-helper
function helpers() return { "declared" } end
function call(name, args) return 1 end
"#,
        );
        let error = call_lua_script_helper_file(
            helper_path.to_str().expect("UTF-8 path"),
            None,
            "missing",
            json!({}),
        )
        .expect_err("undeclared helper must fail")
        .to_string();
        assert!(error.contains("does not declare a function named 'missing'"));

        cleanup(&directory, &[&wrong_marker, &helper_path]);
    }

    #[test]
    fn bundled_test_bench_builds_teco_percent_and_power_commands() {
        let directory = test_directory("bundled-control");
        let path = write_helper(
            &directory,
            "script-helper-test-bench.lua",
            BUNDLED_TEST_BENCH_HELPER,
        );

        let percent = call_bundled_helper(
            &path,
            "prepareControl",
            json!({
                "rpm": 100,
                "direction": 1,
                "delay": 2.25,
                "mode": "percent",
                "value": 50,
                "resistanceRangeBytes": [0, 100, 1],
            }),
        );
        assert_eq!(
            percent,
            json!({
                "motorCommand": "W5360333BE,",
                "ftmsCommandHex": "04 32",
                "ftmsResponsePrefix": "80 04 01",
                "sampleCount": 2,
                "sampleRemainderMs": 250,
            })
        );

        let power = call_bundled_helper(
            &path,
            "prepareControl",
            json!({
                "rpm": 100,
                "direction": 1,
                "delay": 1,
                "mode": "power",
                "value": 250,
                "resistanceRangeBytes": [0, 100, 1],
            }),
        );
        assert_eq!(
            power,
            json!({
                "motorCommand": "W5360333BE,",
                "ftmsCommandHex": "05 FA 00",
                "ftmsResponsePrefix": "80 05 01",
                "sampleCount": 1,
                "sampleRemainderMs": 0,
            })
        );

        cleanup(&directory, &[&path]);
    }

    #[test]
    fn meter_grade_commands_encode_defaults_signed_values_and_reject_invalid_input() {
        let directory = test_directory("grade-control");
        for (filename, source, embedded) in [
            ("meter.lua", BUNDLED_METER_SCRIPT, true),
            ("helper.lua", BUNDLED_TEST_BENCH_HELPER, false),
        ] {
            let path = write_helper(&directory, filename, source);
            let file_path = path.to_str().expect("UTF-8 script path");
            let call = |value: Value| {
                let args = json!({ "rpm": 100, "delay": 1, "mode": " GRADE ", "value": value });
                if embedded {
                    call_lua_embedded_script_helper_file(
                        file_path,
                        Some(file_path),
                        "prepareControl",
                        args,
                    )
                } else {
                    call_lua_script_helper_file(file_path, Some(file_path), "prepareControl", args)
                }
            };
            for (value, expected) in [
                (json!(1), "11 00 00 64 00 28 33"),
                (json!("2.5"), "11 00 00 FA 00 28 33"),
                (json!(-1), "11 00 00 9C FF 28 33"),
                (json!(0), "11 00 00 00 00 28 33"),
                (json!(-327.68), "11 00 00 00 80 28 33"),
                (json!(327.67), "11 00 00 FF 7F 28 33"),
                (json!(""), "11 00 00 64 00 28 33"),
                (json!("  "), "11 00 00 64 00 28 33"),
            ] {
                let result = call(value).expect("grade command");
                assert_eq!(result["ftmsCommandHex"], expected);
                assert_eq!(result["ftmsResponsePrefix"], "80 11 01");
            }
            for value in [json!("bad"), json!(327.68), json!(-327.69), json!("1e999")] {
                assert!(call(value).is_err(), "invalid grade must fail");
            }
            std::fs::remove_file(path).expect("remove test script");
        }
        cleanup(&directory, &[]);
    }

    #[test]
    fn bundled_test_bench_converts_both_tooth_counts_and_infrared_temperature() {
        let directory = test_directory("bundled-measurement");
        let path = write_helper(
            &directory,
            "script-helper-test-bench.lua",
            BUNDLED_TEST_BENCH_HELPER,
        );
        let zero = torque_frame(1000.0, 0.0);
        let sample = torque_frame(1500.0, 1024.0);

        let measurement_1024 = call_bundled_helper(
            &path,
            "torqueMeasurement",
            json!({
                "sampleBytes": sample,
                "zeroBytes": zero,
                "toothCount": 1024,
            }),
        );
        assert_json_number(&measurement_1024, "torqueNm", 10.0);
        assert_json_number(&measurement_1024, "rpm", 60.0);
        assert_json_number(&measurement_1024, "powerW", 62.832);

        let measurement_60 = call_bundled_helper(
            &path,
            "torqueMeasurement",
            json!({
                "sampleBytes": torque_frame(1500.0, 1024.0),
                "zeroBytes": torque_frame(1000.0, 0.0),
                "toothCount": 60,
            }),
        );
        assert_json_number(&measurement_60, "torqueNm", 10.0);
        assert_json_number(&measurement_60, "rpm", 1024.0);
        assert_json_number(&measurement_60, "powerW", 1072.33);

        let infrared_bytes = [0x01, 0x03, 0x02, 0x01, 0x07, 0xF8, 0x16];
        let valid = call_bundled_helper(
            &path,
            "infraredFrameValid",
            json!({ "bytes": infrared_bytes }),
        );
        assert_eq!(valid, json!({ "valid": true }));
        let temperature = call_bundled_helper(
            &path,
            "infraredTemperature",
            json!({ "bytes": infrared_bytes }),
        );
        assert_json_number(&temperature, "temperatureC", 26.3);

        cleanup(&directory, &[&path]);
    }

    #[test]
    fn bundled_test_bench_decodes_ftms_suffix_variants_and_spin_down() {
        let directory = test_directory("bundled-ftms");
        let path = write_helper(
            &directory,
            "script-helper-test-bench.lua",
            BUNDLED_TEST_BENCH_HELPER,
        );

        let ten_byte = call_bundled_helper(
            &path,
            "ftmsCustomData",
            json!({
                "packet": {
                    "available": true,
                    "bytes": [
                        0x01, 0x00,
                        0xDC, 0x05,
                        0xF5, 0xFF,
                        0xFA, 0x00,
                        0x07, 0x01,
                        0x50, 0x04
                    ]
                }
            }),
        );
        assert_eq!(ten_byte.get("valid"), Some(&json!(true)));
        assert_eq!(ten_byte.get("rearWheelSpeedRpm"), Some(&json!(1500)));
        assert_eq!(ten_byte.get("adcCurrent"), Some(&json!(-11)));
        assert_eq!(ten_byte.get("coilCurrentMa"), Some(&json!(250)));
        assert_json_number(&ten_byte, "siliconTemperatureC", 26.3);
        assert_eq!(ten_byte.get("pwmTicks"), Some(&json!(1104)));
        assert_eq!(ten_byte.get("wheelTemperatureC"), Some(&json!("")));

        let twelve_byte = call_bundled_helper(
            &path,
            "ftmsCustomData",
            json!({
                "packet": {
                    "available": true,
                    "bytes": [
                        0x01, 0x00,
                        0xDC, 0x05,
                        0xF5, 0xFF,
                        0xFA, 0x00,
                        0x07, 0x01,
                        0x50, 0x04,
                        0x3B, 0x01
                    ]
                }
            }),
        );
        assert_eq!(twelve_byte.get("valid"), Some(&json!(true)));
        assert_json_number(&twelve_byte, "wheelTemperatureC", 31.5);

        // Flags 0x0044 add the standard instantaneous speed, cadence, and
        // instantaneous power fields before the vendor suffix. This catches
        // regressions where the custom decoder assumes a fixed byte offset.
        let standard_fields = call_bundled_helper(
            &path,
            "ftmsCustomData",
            json!({
                "packet": {
                    "available": true,
                    "bytes": [
                        0x44, 0x00,
                        0xDC, 0x05,
                        0xB4, 0x00,
                        0xFA, 0x00,
                        0xDC, 0x05,
                        0xF5, 0xFF,
                        0xFA, 0x00,
                        0x07, 0x01,
                        0x50, 0x04,
                        0x3B, 0x01
                    ]
                }
            }),
        );
        assert_eq!(standard_fields.get("valid"), Some(&json!(true)));
        assert_eq!(
            standard_fields.get("instantaneousPowerW"),
            Some(&json!(250))
        );
        assert_eq!(standard_fields.get("rearWheelSpeedRpm"), Some(&json!(1500)));
        assert_json_number(&standard_fields, "wheelTemperatureC", 31.5);

        let target = call_bundled_helper(
            &path,
            "spinDownTarget",
            json!({ "bytes": [0x80, 0x13, 0x01, 0xE8, 0x03, 0xD0, 0x07] }),
        );
        assert_eq!(
            target,
            json!({
                "available": true,
                "lowKph": 10.0,
                "highKph": 20.0,
                "label": "10.0-20.0 km/h",
            })
        );
        let speed = call_bundled_helper(
            &path,
            "indoorBikeSpeed",
            json!({ "bytes": [0x00, 0x00, 0xDC, 0x05] }),
        );
        assert_eq!(
            speed,
            json!({ "available": true, "speedKph": 15.0, "label": "15.0 km/h" })
        );
        let in_target = call_bundled_helper(
            &path,
            "indoorBikeSpeedInTarget",
            json!({
                "bytes": [0x00, 0x00, 0xDC, 0x05],
                "target": target,
            }),
        );
        assert_eq!(in_target, json!({ "matched": true }));

        let status = call_bundled_helper(&path, "spinDownStatus", json!({ "bytes": [0x14, 0x02] }));
        assert_eq!(
            status,
            json!({ "available": true, "code": 2, "label": "Success", "resultReady": true })
        );
        let result_ready = call_bundled_helper(
            &path,
            "spinDownResultReady",
            json!({ "bytes": [0x14, 0x02] }),
        );
        assert_eq!(result_ready, json!({ "matched": true }));

        cleanup(&directory, &[&path]);
    }
}
