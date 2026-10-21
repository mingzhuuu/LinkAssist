use crate::error::AppError;
use crate::protocol::lua_engine::{apply_memory_limit, arm_execution_limit};
use crate::script_markers::{ensure_lua_script_kind, LuaScriptKind};
use mlua::{Lua, LuaSerdeExt, Value};
use serde_json::Value as JsonValue;
use std::path::Path;

#[tauri::command]
pub async fn parse_lua_automation_script(content: String) -> Result<JsonValue, AppError> {
    parse_lua_document_off_thread(content, false).await
}

#[tauri::command]
pub async fn parse_lua_automation_file(path: String) -> Result<JsonValue, AppError> {
    let path = crate::snapshot::resolve_path(&path);
    let content = tokio::fs::read_to_string(&path).await?;
    ensure_lua_script_kind(&content, LuaScriptKind::Script)?;
    parse_lua_document_off_thread(content, false).await
}

#[tauri::command]
pub async fn parse_lua_canvas_lifecycle_file(path: String) -> Result<JsonValue, AppError> {
    let path = crate::snapshot::resolve_path(&path);
    ensure_canvas_lifecycle_file_name(&path)?;
    let content = tokio::fs::read_to_string(&path).await?;
    ensure_lua_script_kind(&content, LuaScriptKind::CanvasLifecycle)?;
    parse_lua_document_off_thread(content, true).await
}

async fn parse_lua_document_off_thread(content: String, lifecycle: bool) -> Result<JsonValue, AppError> {
    tokio::task::spawn_blocking(move || {
        if lifecycle {
            parse_lua_canvas_lifecycle_document(&content)
        } else {
            parse_lua_script_document(&content)
        }
    })
    .await
    .map_err(|error| AppError::Protocol(format!("Lua document task failed: {error}")))?
}

pub(crate) fn parse_lua_script_document(content: &str) -> Result<JsonValue, AppError> {
    let document = parse_lua_table(content)?;
    validate_script_document(&document)?;
    Ok(document)
}

pub(crate) fn parse_lua_canvas_lifecycle_document(content: &str) -> Result<JsonValue, AppError> {
    let document = parse_lua_table(content)?;
    validate_canvas_lifecycle_document(&document)?;
    Ok(document)
}

fn parse_lua_table(content: &str) -> Result<JsonValue, AppError> {
    let lua = Lua::new();
    apply_memory_limit(&lua);
    setup_sandbox(&lua)?;
    arm_execution_limit(&lua);

    let value: Value = lua.load(content).eval().map_err(|e| {
        AppError::Protocol(format!("Lua automation script must return a table: {}", e))
    })?;

    let document: JsonValue = lua
        .from_value(value)
        .map_err(|e| AppError::Protocol(format!("Lua automation table conversion error: {}", e)))?;

    Ok(document)
}

#[cfg(test)]
mod resource_limit_tests {
    use super::parse_lua_table;

    #[test]
    fn document_loading_stops_infinite_loops() {
        let error = parse_lua_table("while true do end").unwrap_err().to_string();
        assert!(error.contains("instruction budget"), "{error}");
    }

    #[test]
    fn document_loading_bounds_allocations() {
        let error = parse_lua_table("return { data = string.rep('x', 128 * 1024 * 1024) }")
            .unwrap_err()
            .to_string();
        assert!(error.to_lowercase().contains("memory"), "{error}");
    }
}

fn ensure_canvas_lifecycle_file_name(path: &str) -> Result<(), AppError> {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if file_name.starts_with("canvas-lifecycle-") {
        return Ok(());
    }

    Err(AppError::Protocol(
        "Canvas lifecycle Lua file name must start with 'canvas-lifecycle-'".to_string(),
    ))
}

fn setup_sandbox(lua: &Lua) -> Result<(), AppError> {
    let globals = lua.globals();

    if let Ok(os_table) = globals.get::<mlua::Table>("os") {
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

fn validate_script_document(document: &JsonValue) -> Result<(), AppError> {
    let object = require_document_object(document, "Lua automation script")?;

    let version = object
        .get("version")
        .and_then(JsonValue::as_f64)
        .unwrap_or(1.0);
    if !version.is_finite() || version < 1.0 {
        return Err(AppError::Protocol(
            "version must be a positive number".to_string(),
        ));
    }

    if let Some(value) = object.get("helpers") {
        validate_script_helpers(value, "helpers")?;
    }

    for key in ["setup", "steps", "onStop", "teardown"] {
        if let Some(value) = object.get(key) {
            validate_steps(value, key)?;
        }
    }

    let handler_step_count = if let Some(value) = object.get("handlers") {
        let handlers = value
            .as_object()
            .ok_or_else(|| AppError::Protocol("handlers must be a table object".to_string()))?;
        if handlers.is_empty() {
            return Err(AppError::Protocol(
                "handlers must contain at least one named handler".to_string(),
            ));
        }
        let mut count = 0usize;
        for (name, steps) in handlers {
            if name.is_empty() {
                return Err(AppError::Protocol(
                    "handler names must not be empty".to_string(),
                ));
            }
            validate_steps(steps, &format!("handlers.{name}"))?;
            count += steps.as_array().map(Vec::len).unwrap_or_default();
        }
        count
    } else {
        0
    };

    if let Some(value) = object.get("ui") {
        validate_script_ui(value)?;
    }

    let step_count = ["setup", "steps", "onStop", "teardown"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(JsonValue::as_array))
        .map(Vec::len)
        .sum::<usize>()
        + handler_step_count;
    if step_count == 0 {
        return Err(AppError::Protocol(
            "Script must contain at least one executable step or named handler item".to_string(),
        ));
    }

    Ok(())
}

fn validate_script_ui(value: &JsonValue) -> Result<(), AppError> {
    let ui = value
        .as_object()
        .ok_or_else(|| AppError::Protocol("ui must be a table object".to_string()))?;
    if ui.get("schemaVersion").and_then(JsonValue::as_u64) != Some(1) {
        return Err(AppError::Protocol("ui.schemaVersion must be 1".to_string()));
    }
    optional_bool(ui, "showHeaderInfo", "ui")?;
    let layout = ui
        .get("layout")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| AppError::Protocol("ui.layout must be a table object".to_string()))?;
    let preset = require_string(layout, "preset", "ui.layout")?;
    if !matches!(preset, "top-bottom" | "left-right") {
        return Err(AppError::Protocol(
            "ui.layout.preset must be top-bottom or left-right".to_string(),
        ));
    }
    let region_ids = layout
        .get("regions")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| AppError::Protocol("ui.layout.regions must be an array".to_string()))?;
    if region_ids.len() != 2
        || region_ids
            .iter()
            .any(|region| !region.as_str().is_some_and(|name| !name.is_empty()))
    {
        return Err(AppError::Protocol(
            "ui.layout.regions must contain exactly two non-empty region ids".to_string(),
        ));
    }
    for numeric_key in ["primarySize", "minPrimaryPx", "minSecondaryPx"] {
        if let Some(number) = layout.get(numeric_key) {
            if !number
                .as_f64()
                .is_some_and(|value| value.is_finite() && value >= 0.0)
            {
                return Err(AppError::Protocol(format!(
                    "ui.layout.{numeric_key} must be a non-negative number"
                )));
            }
        }
    }
    optional_bool(layout, "resizable", "ui.layout")?;

    if let Some(toolbar) = ui.get("toolbar") {
        let controls = toolbar
            .as_array()
            .ok_or_else(|| AppError::Protocol("ui.toolbar must be an array".to_string()))?;
        for (index, control) in controls.iter().enumerate() {
            let path = format!("ui.toolbar[{index}]");
            validate_script_ui_control(control, &path)?;
            if !matches!(
                control.get("type").and_then(JsonValue::as_str),
                Some("button" | "select" | "checkbox")
            ) {
                return Err(AppError::Protocol(format!(
                    "{path}.type must be button, select, or checkbox"
                )));
            }
        }
    }

    let regions = ui
        .get("regions")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| AppError::Protocol("ui.regions must be a table object".to_string()))?;
    for region_id in region_ids.iter().filter_map(JsonValue::as_str) {
        let region = regions
            .get(region_id)
            .and_then(JsonValue::as_object)
            .ok_or_else(|| {
                AppError::Protocol(format!("ui.regions.{region_id} must be a table object"))
            })?;
        let controls = require_array(region, "controls", &format!("ui.regions.{region_id}"))?;
        if let Some(controls_layout) = region.get("controlsLayout") {
            if !controls_layout
                .as_str()
                .is_some_and(|layout| matches!(layout, "column" | "row"))
            {
                return Err(AppError::Protocol(format!(
                    "ui.regions.{region_id}.controlsLayout must be column or row"
                )));
            }
        }
        for (index, control) in controls
            .as_array()
            .expect("validated array")
            .iter()
            .enumerate()
        {
            validate_script_ui_control(
                control,
                &format!("ui.regions.{region_id}.controls[{index}]"),
            )?;
        }
    }
    Ok(())
}

fn validate_script_ui_control(value: &JsonValue, path: &str) -> Result<(), AppError> {
    let control = value
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{path} must be a table object")))?;
    require_string(control, "id", path)?;
    let control_type = require_string(control, "type", path)?;
    match control_type {
        "text" | "search" | "password" | "number" | "file" | "directory" | "checkbox"
        | "select" | "multiSelect" => {
            require_string(control, "bind", path)?;
        }
        "button" => {
            require_string(control, "action", path)?;
            optional_string(control, "loadedSource", path)?;
            optional_string(control, "loadedLabel", path)?;
            optional_string(control, "runningAction", path)?;
            optional_string(control, "runningLabel", path)?;
            optional_string(control, "runningHandler", path)?;
            optional_bool(control, "reloadDocument", path)?;
            optional_bool(control, "directoryPicker", path)?;
            if control.get("directoryPicker").and_then(JsonValue::as_bool) == Some(true) {
                require_string(control, "bind", path)?;
            }
        }
        "testCases" => {
            require_string(control, "bind", path)?;
            require_string(control, "catalogSource", path)?;
        }
        "testInputs" => {
            require_string(control, "bind", path)?;
            require_string(control, "catalogSource", path)?;
            require_string(control, "profileBind", path)?;
            require_string(control, "nodeIdsBind", path)?;
        }
        "runSummary" | "testResults" | "stepList" | "logViewer" | "historyList" => {}
        _ => {
            return Err(AppError::Protocol(format!(
                "{path}.type is unsupported: {control_type}"
            )))
        }
    }
    optional_bool(control, "persist", path)?;
    optional_bool(control, "grow", path)?;
    optional_bool(control, "inlineLabel", path)?;
    optional_bool(control, "compact", path)?;
    optional_bool(control, "collapsed", path)?;
    optional_bool(control, "editable", path)?;
    if control_type == "logViewer" {
        optional_bool(control, "errorOnly", path)?;
        optional_bool(control, "hideWhenEmpty", path)?;
    }
    optional_string(control, "refreshAction", path)?;
    if control_type == "password"
        && control.get("persist").and_then(JsonValue::as_bool) == Some(true)
    {
        return Err(AppError::Protocol(format!(
            "{path}.persist cannot be true for password controls"
        )));
    }
    Ok(())
}

fn validate_canvas_lifecycle_document(document: &JsonValue) -> Result<(), AppError> {
    let object = require_document_object(document, "Lua canvas lifecycle script")?;

    let version = object
        .get("version")
        .and_then(JsonValue::as_f64)
        .unwrap_or(1.0);
    if !version.is_finite() || version < 1.0 {
        return Err(AppError::Protocol(
            "version must be a positive number".to_string(),
        ));
    }

    if let Some(value) = object.get("helpers") {
        validate_script_helpers(value, "helpers")?;
    }

    for key in ["setup", "onActivate", "onDeactivate", "teardown"] {
        if let Some(value) = object.get(key) {
            validate_steps(value, key)?;
        }
    }

    let while_active_count = if let Some(value) = object.get("whileActive") {
        validate_while_active(value)?;
        value
            .as_object()
            .and_then(|item| item.get("steps"))
            .and_then(JsonValue::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    } else {
        0
    };

    let hook_count = ["onActivate", "onDeactivate"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(JsonValue::as_array))
        .map(Vec::len)
        .sum::<usize>()
        + while_active_count;

    if hook_count == 0 {
        return Err(AppError::Protocol(
            "Canvas lifecycle script must contain at least one onActivate, onDeactivate, or whileActive item"
                .to_string(),
        ));
    }

    Ok(())
}

fn validate_while_active(value: &JsonValue) -> Result<(), AppError> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::Protocol("whileActive must be a table object".to_string()))?;
    let steps = require_array(object, "steps", "whileActive")?;
    validate_steps(steps, "whileActive.steps")
}

fn require_document_object<'a>(
    document: &'a JsonValue,
    label: &str,
) -> Result<&'a serde_json::Map<String, JsonValue>, AppError> {
    document
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{} root must be a table object", label)))
}

fn validate_script_helpers(value: &JsonValue, path: &str) -> Result<(), AppError> {
    let helpers = value
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{path} must be a table object")))?;
    for (alias, definition) in helpers {
        if alias.is_empty()
            || alias.len() > 128
            || !alias
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(AppError::Protocol(format!(
                "{path} alias '{alias}' must be 1-128 ASCII letters, digits, '.', '_' or '-'"
            )));
        }
        let definition_path = format!("{path}.{alias}");
        let definition = definition.as_object().ok_or_else(|| {
            AppError::Protocol(format!("{definition_path} must be a table object"))
        })?;
        optional_bool(definition, "embedded", &definition_path)?;
        let embedded = definition
            .get("embedded")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        if embedded {
            if definition.contains_key("luaPath") {
                return Err(AppError::Protocol(format!(
                    "{definition_path}.luaPath must be omitted when embedded is true"
                )));
            }
        } else {
            require_string(definition, "luaPath", &definition_path)?;
        }
    }
    Ok(())
}

fn validate_steps(value: &JsonValue, section: &str) -> Result<(), AppError> {
    let steps = value
        .as_array()
        .ok_or_else(|| AppError::Protocol(format!("{} must be an array-like table", section)))?;

    for (index, step) in steps.iter().enumerate() {
        validate_step(step, &format!("{}[{}]", section, index))?;
    }

    Ok(())
}

fn validate_step(step: &JsonValue, path: &str) -> Result<(), AppError> {
    let object = step
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{} must be a table object", path)))?;
    let action = object
        .get("action")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| AppError::Protocol(format!("{} is missing action", path)))?;
    optional_bool_or_ref(object, "when", path)?;

    match action {
        "open" => {
            require_string(object, "channel", path)?;
            let channel_type = require_string(object, "channelType", path)?;
            if !matches!(channel_type, "serial" | "tcp-client" | "udp" | "ble") {
                return Err(AppError::Protocol(format!(
                    "{}.channelType must be serial, tcp-client, udp, or ble",
                    path
                )));
            }
        }
        "close" => {
            require_string(object, "channel", path)?;
        }
        "read" => {
            require_string(object, "channel", path)?;
        }
        "send" => {
            require_string(object, "channel", path)?;
            require_object(object, "data", path)?;
        }
        "wait" => {
            require_string(object, "channel", path)?;
            require_object(object, "expect", path)?;
            if let Some(expect) = object.get("expect") {
                validate_step_expect(expect, path)?;
            }
        }
        "request" => {
            require_string(object, "channel", path)?;
            require_object(object, "send", path)?;
            require_object(object, "expect", path)?;
            if let Some(expect) = object.get("expect") {
                validate_step_expect(expect, path)?;
            }
        }
        "delay" => {}
        "repeat" | "group" => {
            let steps = require_array(object, "steps", path)?;
            validate_steps(steps, &format!("{}.steps", path))?;
        }
        "forEachCsv" => {
            require_string(object, "source", path)?;
            let steps = require_array(object, "steps", path)?;
            validate_steps(steps, &format!("{}.steps", path))?;
        }
        "set" => {
            require_string(object, "name", path)?;
        }
        "assert" => {
            require_string(object, "operator", path)?;
        }
        "log" => {
            require_string(object, "message", path)?;
        }
        "logCsv" => {
            require_string(object, "target", path)?;
            require_object(object, "row", path)?;
        }
        // Calls one tool of a Lua MCP tool script by file path. This is how an automation script
        // reaches capabilities that live outside LinkAssist — protocol-specific orchestration
        // belongs in such a script, not in step types added here.
        "luaTool" => {
            require_string(object, "luaPath", path)?;
            require_string(object, "tool", path)?;
        }
        "luaHelper" => {
            validate_lua_helper_call(object, path)?;
            optional_string(object, "saveAs", path)?;
        }
        "takeLatestPacket" => {
            require_string(object, "channel", path)?;
            require_string(object, "saveAs", path)?;
            optional_number_or_string(object, "maxAgeMs", path)?;
            optional_bool_or_string(object, "consume", path)?;
            optional_bool_or_string(object, "required", path)?;
        }
        // Starts a selection exposed by a project's pytest catalog. LinkAssist
        // deliberately accepts only the structured bridge fields here; a
        // canvas script cannot smuggle an arbitrary shell command or env map.
        "testRun" => {
            for forbidden in ["command", "argv", "env", "shell"] {
                if object.contains_key(forbidden) {
                    return Err(AppError::Protocol(format!(
                        "{}.{} is not allowed for testRun",
                        path, forbidden
                    )));
                }
            }
            require_string(object, "projectRoot", path)?;
            optional_string(object, "pythonPath", path)?;
            optional_string(object, "profile", path)?;
            optional_string(object, "saveAs", path)?;
            optional_string(object, "catalogSource", path)?;
            optional_bool_or_ref(object, "allowDestructive", path)?;
            optional_string_array_or_ref(object, "nodeIds", path)?;
            optional_scalar_object_or_ref(object, "inputs", path)?;
            if let Some(selection_mode) = object.get("selectionMode") {
                if !selection_mode
                    .as_str()
                    .is_some_and(|mode| matches!(mode, "profile-and-nodes" | "exact-or-profile"))
                {
                    return Err(AppError::Protocol(format!(
                        "{}.selectionMode must be profile-and-nodes or exact-or-profile",
                        path
                    )));
                }
            }
        }
        "testCatalog" => {
            for forbidden in ["command", "argv", "env", "shell"] {
                if object.contains_key(forbidden) {
                    return Err(AppError::Protocol(format!(
                        "{}.{} is not allowed for testCatalog",
                        path, forbidden
                    )));
                }
            }
            require_string(object, "projectRoot", path)?;
            optional_string(object, "pythonPath", path)?;
            optional_string(object, "saveAs", path)?;
        }
        "testHistory" => {
            optional_string(object, "projectRoot", path)?;
            optional_string(object, "saveAs", path)?;
        }
        _ => {
            return Err(AppError::Protocol(format!(
                "{}.action is unsupported: {}",
                path, action
            )));
        }
    }

    Ok(())
}

fn validate_step_expect(value: &JsonValue, step_path: &str) -> Result<(), AppError> {
    let expect = value
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{step_path}.expect must be a table object")))?;
    if expect.contains_key("helper") {
        return Err(AppError::Protocol(format!(
            "{step_path}.expect.helper was removed; declare a script helper and use expect.luaHelper"
        )));
    }
    let Some(lua_helper) = expect.get("luaHelper") else {
        return Ok(());
    };
    let path = format!("{step_path}.expect.luaHelper");
    let lua_helper = lua_helper
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{path} must be a table object")))?;
    validate_lua_helper_call(lua_helper, &path)?;
    optional_string(lua_helper, "resultPath", &path)
}

fn validate_lua_helper_call(
    object: &serde_json::Map<String, JsonValue>,
    path: &str,
) -> Result<(), AppError> {
    require_string(object, "helper", path)?;
    require_string(object, "func", path)?;
    if let Some(args) = object.get("args") {
        if !args.is_object() {
            return Err(AppError::Protocol(format!("{path}.args must be an object")));
        }
    }
    Ok(())
}

fn value_is_ref(value: &JsonValue) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == 1
            && object
                .get("$ref")
                .and_then(JsonValue::as_str)
                .is_some_and(|path| !path.is_empty())
    })
}

fn optional_bool_or_ref(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if let Some(value) = object.get(key) {
        if !value.is_boolean() && !value_is_ref(value) {
            return Err(AppError::Protocol(format!(
                "{path}.{key} must be a boolean or {{$ref=...}}"
            )));
        }
    }
    Ok(())
}

fn optional_string_array_or_ref(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if object.get(key).is_some_and(value_is_ref) {
        return Ok(());
    }
    optional_string_array(object, key, path)
}

fn optional_scalar_object_or_ref(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if object.get(key).is_some_and(value_is_ref) {
        return Ok(());
    }
    optional_scalar_object(object, key, path)
}

fn require_string<'a>(
    object: &'a serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<&'a str, AppError> {
    object
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Protocol(format!("{}.{} is required", path, key)))
}

fn require_object(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    object
        .get(key)
        .and_then(JsonValue::as_object)
        .map(|_| ())
        .ok_or_else(|| AppError::Protocol(format!("{}.{} must be an object", path, key)))
}

fn optional_string(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if let Some(value) = object.get(key) {
        if !value.as_str().is_some_and(|item| !item.is_empty()) {
            return Err(AppError::Protocol(format!(
                "{}.{} must be a non-empty string",
                path, key
            )));
        }
    }
    Ok(())
}

fn optional_bool(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if object.get(key).is_some_and(|value| !value.is_boolean()) {
        return Err(AppError::Protocol(format!(
            "{}.{} must be a boolean",
            path, key
        )));
    }
    Ok(())
}

fn optional_number_or_string(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if let Some(value) = object.get(key) {
        let valid_number = value.as_f64().is_some_and(f64::is_finite);
        let valid_string = value.as_str().is_some_and(|item| !item.is_empty());
        if !valid_number && !valid_string {
            return Err(AppError::Protocol(format!(
                "{path}.{key} must be a finite number or non-empty string"
            )));
        }
    }
    Ok(())
}

fn optional_bool_or_string(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    if let Some(value) = object.get(key) {
        let valid_string = value.as_str().is_some_and(|item| !item.is_empty());
        if !value.is_boolean() && !valid_string {
            return Err(AppError::Protocol(format!(
                "{path}.{key} must be a boolean or non-empty string"
            )));
        }
    }
    Ok(())
}

fn optional_string_array(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    let Some(value) = object.get(key) else {
        return Ok(());
    };
    let values = value.as_array().ok_or_else(|| {
        AppError::Protocol(format!("{}.{} must be an array of strings", path, key))
    })?;
    if values.iter().any(|value| {
        !value
            .as_str()
            .is_some_and(|string_value| !string_value.is_empty())
    }) {
        return Err(AppError::Protocol(format!(
            "{}.{} must contain only non-empty strings",
            path, key
        )));
    }
    Ok(())
}

fn optional_scalar_object(
    object: &serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<(), AppError> {
    let Some(value) = object.get(key) else {
        return Ok(());
    };
    let values = value
        .as_object()
        .ok_or_else(|| AppError::Protocol(format!("{}.{} must be an object", path, key)))?;
    if values
        .values()
        .any(|value| value.is_array() || value.is_object() || value.is_null())
    {
        return Err(AppError::Protocol(format!(
            "{}.{} values must be strings, numbers, or booleans",
            path, key
        )));
    }
    Ok(())
}

fn require_array<'a>(
    object: &'a serde_json::Map<String, JsonValue>,
    key: &str,
    path: &str,
) -> Result<&'a JsonValue, AppError> {
    let value = object
        .get(key)
        .ok_or_else(|| AppError::Protocol(format!("{}.{} must be an array", path, key)))?;
    if value.as_array().is_none() {
        return Err(AppError::Protocol(format!(
            "{}.{} must be an array",
            path, key
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_returned_lua_document() {
        let script = r#"
return {
  version = 1,
  name = "Lua Script",
  steps = {
    { action = "log", message = "hello" }
  }
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["name"], "Lua Script");
        assert_eq!(document["steps"][0]["action"], "log");
    }

    #[test]
    fn rejects_missing_step_action() {
        let script = r#"return { steps = { { message = "hello" } } }"#;
        let error = parse_lua_script_document(script).unwrap_err().to_string();
        assert!(error.contains("missing action"));
    }

    #[test]
    fn removes_unsafe_globals() {
        let script = r#"return { steps = { { action = "log", message = tostring(io) } } }"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["steps"][0]["message"], "nil");
    }

    #[test]
    fn accepts_read_steps() {
        let script = r#"
return {
  version = 1,
  name = "Lua Script",
  steps = {
    { action = "read", channel = "ftmsFeature", saveAs = "feature" }
  }
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["steps"][0]["action"], "read");
        assert_eq!(document["steps"][0]["channel"], "ftmsFeature");
    }

    #[test]
    fn accepts_lua_tool_steps() {
        let script = r#"
return {
  version = 1,
  name = "Lua Script",
  steps = {
    {
      action = "luaTool",
      luaPath = "C:/pkg/generated/tools.lua",
      tool = "run_flow",
      args = { flowId = "probe", params = { deviceName = "T01" } },
      expect = { path = "ok", equals = true },
      saveAs = "flowResult"
    }
  }
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["steps"][0]["action"], "luaTool");
        assert_eq!(document["steps"][0]["tool"], "run_flow");
        assert_eq!(document["steps"][0]["args"]["flowId"], "probe");
    }

    #[test]
    fn rejects_lua_tool_step_without_tool_name() {
        let script = r#"
return { steps = { { action = "luaTool", luaPath = "C:/pkg/tools.lua" } } }
"#;
        let error = parse_lua_script_document(script).unwrap_err().to_string();
        assert!(
            error.contains("tool is required"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn accepts_script_helpers_matchers_and_latest_packet_steps() {
        let script = r#"
return {
  helpers = {
    bench = { embedded = true },
    shared = { luaPath = "../script-helper/shared.lua" },
  },
  steps = {
    {
      action = "wait",
      channel = "torque",
      expect = {
        length = 13,
        luaHelper = {
          helper = "bench",
          func = "torqueFrameValid",
          args = { bytes = { ["$ref"] = "packet.bytes" } },
          resultPath = "valid",
          equals = true,
        },
      },
    },
    {
      action = "luaHelper",
      helper = "bench",
      func = "torqueMeasurement",
      args = { sample = { ["$ref"] = "sample.bytes" } },
      saveAs = "measurement",
    },
    {
      action = "takeLatestPacket",
      channel = "ftmsBikeData",
      maxAgeMs = "${ftmsDataMaxAgeMs}",
      consume = true,
      required = false,
      saveAs = "ftmsPacket",
    },
  },
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["helpers"]["bench"]["embedded"], true);
        assert_eq!(
            document["helpers"]["shared"]["luaPath"],
            "../script-helper/shared.lua"
        );
        assert_eq!(
            document["steps"][0]["expect"]["luaHelper"]["func"],
            "torqueFrameValid"
        );
        assert_eq!(document["steps"][1]["action"], "luaHelper");
        assert_eq!(document["steps"][2]["action"], "takeLatestPacket");
        assert_eq!(document["steps"][2]["saveAs"], "ftmsPacket");
    }

    #[test]
    fn rejects_invalid_script_helper_declarations_and_calls() {
        let cases = [
            (
                r#"return { helpers = { bench = {} }, steps = { { action = "log", message = "x" } } }"#,
                "helpers.bench.luaPath is required",
            ),
            (
                r#"return { helpers = { bench = { embedded = "yes" } }, steps = { { action = "log", message = "x" } } }"#,
                "helpers.bench.embedded must be a boolean",
            ),
            (
                r#"return { helpers = { bench = { embedded = true, luaPath = "helper.lua" } }, steps = { { action = "log", message = "x" } } }"#,
                "helpers.bench.luaPath must be omitted when embedded is true",
            ),
            (
                r#"return { helpers = { ["bad alias"] = { luaPath = "helper.lua" } }, steps = { { action = "log", message = "x" } } }"#,
                "helpers alias 'bad alias'",
            ),
            (
                r#"return { steps = { { action = "luaHelper", helper = "bench", args = {} } } }"#,
                ".func is required",
            ),
            (
                r#"return { steps = { { action = "luaHelper", helper = "bench", func = "decode", args = 7 } } }"#,
                ".args must be an object",
            ),
            (
                r#"return { steps = { { action = "wait", channel = "rx", expect = { luaHelper = { helper = "bench", func = "match", args = {}, resultPath = 3 } } } } }"#,
                ".resultPath must be a non-empty string",
            ),
            (
                r#"return { steps = { { action = "wait", channel = "rx", expect = { helper = "legacyFrameValid(packet.bytes)" } } } }"#,
                ".expect.helper was removed",
            ),
        ];

        for (script, expected) in cases {
            let error = parse_lua_script_document(script).unwrap_err().to_string();
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn rejects_invalid_take_latest_packet_fields() {
        let cases = [
            (
                r#"return { steps = { { action = "takeLatestPacket", saveAs = "packet" } } }"#,
                ".channel is required",
            ),
            (
                r#"return { steps = { { action = "takeLatestPacket", channel = "rx" } } }"#,
                ".saveAs is required",
            ),
            (
                r#"return { steps = { { action = "takeLatestPacket", channel = "rx", saveAs = "packet", maxAgeMs = false } } }"#,
                ".maxAgeMs must be a finite number or non-empty string",
            ),
            (
                r#"return { steps = { { action = "takeLatestPacket", channel = "rx", saveAs = "packet", consume = 1 } } }"#,
                ".consume must be a boolean or non-empty string",
            ),
        ];

        for (script, expected) in cases {
            let error = parse_lua_script_document(script).unwrap_err().to_string();
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn parses_structured_test_run_step() {
        let script = r#"
return {
  steps = {
    {
      action = "testRun",
      projectRoot = "D:/project",
      profile = "quick",
      nodeIds = { "tests/test_cases.py::test_project_case[one]" },
      inputs = { DEVICE_NAME = "target", RETRIES = 2 },
      allowDestructive = false,
      saveAs = "result"
    }
  }
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["steps"][0]["action"], "testRun");
        assert_eq!(document["steps"][0]["profile"], "quick");
    }

    #[test]
    fn rejects_test_run_raw_or_nested_inputs() {
        let script = r#"
return {
  steps = {
    { action = "testRun", projectRoot = "D:/project", command = "pytest", inputs = { BAD = { "nested" } } }
  }
}
"#;
        let error = parse_lua_script_document(script).unwrap_err().to_string();
        assert!(
            error.contains("command is not allowed"),
            "unexpected error: {}",
            error
        );
    }

    #[test]
    fn accepts_two_region_interactive_test_dashboard() {
        let script = r#"
return {
  name = "Dashboard",
  variables = { form = { projectRoot = "D:/project", nodeIds = {}, inputs = {} } },
  ui = {
    schemaVersion = 1,
    layout = { preset = "left-right", regions = { "selection", "results" } },
    regions = {
      selection = { controls = {
        { id = "project", type = "directory", bind = "form.projectRoot", persist = true },
        { id = "run", type = "button", action = "runTests" }
      } },
      results = { controls = { { id = "logs", type = "logViewer" } } }
    }
  },
  handlers = {
    runTests = {
      {
        action = "testRun",
        projectRoot = "${form.projectRoot}",
        nodeIds = { ["$ref"] = "form.nodeIds" },
        inputs = { ["$ref"] = "form.inputs" },
        allowDestructive = { ["$ref"] = "form.authorization" }
      }
    }
  }
}
"#;
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["ui"]["layout"]["preset"], "left-right");
        assert_eq!(document["handlers"]["runTests"][0]["action"], "testRun");
    }

    #[test]
    fn parses_shipped_pytest_dashboard_template() {
        let script = include_str!("../../../config/script/script-test-run-example.lua");
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["ui"]["layout"]["preset"], "left-right");
        assert_eq!(document["ui"]["toolbar"][0]["label"], "Load");
        assert_eq!(document["ui"]["toolbar"][0]["loadedLabel"], "Reload");
        assert_eq!(document["ui"]["toolbar"][0]["directoryPicker"], true);
        assert_eq!(document["ui"]["toolbar"][0]["bind"], "form.projectRoot");
        assert_eq!(document["ui"]["toolbar"][1]["runningLabel"], "Stop");
        assert!(document["variables"]["form"].get("pythonPath").is_none());
        assert!(document["variables"]["form"].get("search").is_none());
        assert!(document["variables"].get("history").is_none());
        assert!(document["ui"]["regions"]["selection"]["controls"]
            .as_array()
            .is_some_and(|controls| controls.iter().all(|control| !matches!(
                control["id"].as_str(),
                Some("project-root" | "search")
            ))));
        assert_eq!(
            document["ui"]["regions"]["selection"]["controls"][0]["inlineLabel"],
            true
        );
        assert_eq!(
            document["ui"]["regions"]["selection"]["controls"][1]["label"],
            "Test cases"
        );
        assert_eq!(
            document["ui"]["regions"]["selection"]["controls"][2]["id"],
            "inputs"
        );
        assert!(document["ui"]["regions"]["selection"]["controls"][2]
            .get("authorizationBind")
            .is_none());
        assert!(document["ui"]["regions"]["selection"]["controls"][2]
            .get("label")
            .is_none());
        assert_eq!(
            document["ui"]["regions"]["results"]["controls"][0]["id"],
            "progress"
        );
        assert_eq!(
            document["ui"]["regions"]["results"]["controls"][0]["type"],
            "runSummary"
        );
        assert_eq!(
            document["ui"]["regions"]["results"]["controls"][1]["id"],
            "logs"
        );
        assert!(document["handlers"].get("refreshHistory").is_none());
        assert_eq!(
            document["handlers"]["loadCatalog"][0]["action"],
            "testCatalog"
        );
        assert_eq!(
            document["handlers"]["runTests"][0]["selectionMode"],
            "exact-or-profile"
        );
        assert_eq!(
            document["handlers"]["runTests"][0]["catalogSource"],
            "catalog"
        );
        assert!(document["variables"]["form"].get("authorization").is_none());
        assert!(document["handlers"]["runTests"][0]
            .get("allowDestructive")
            .is_none());
    }

    #[test]
    fn parses_shipped_interactive_rpm_ftms_template() {
        let script = include_str!("../../../config/script/script-serial-rpm-example.lua");
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(document["ui"]["layout"]["preset"], "top-bottom");
        assert_eq!(document["ui"]["layout"]["minPrimaryPx"], 48);
        assert_eq!(document["ui"]["showHeaderInfo"], false);
        let toolbar = document["ui"]["toolbar"].as_array().unwrap();
        let control = |id: &str| toolbar.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(toolbar[0]["id"], "loop");
        assert_eq!(control("loop")["type"], "checkbox");
        assert_eq!(control("motor-channel")["type"], "select");
        assert_eq!(control("infrared-1-channel")["type"], "select");
        assert_eq!(control("infrared-2-channel")["type"], "select");
        let source_controls = document["ui"]["regions"]["source"]["controls"]
            .as_array()
            .unwrap();
        assert_eq!(document["ui"]["regions"]["source"]["controlsLayout"], "row");
        assert_eq!(source_controls[0]["id"], "torque-teeth");
        assert_eq!(source_controls[0]["type"], "select");
        assert_eq!(source_controls[0]["bind"], "form.torqueTeeth");
        assert_eq!(source_controls[0]["compact"], true);
        assert_eq!(source_controls[0]["options"][0]["value"], "1024");
        assert_eq!(source_controls[0]["options"][1]["value"], "60");
        assert_eq!(source_controls[1]["id"], "csv-file");
        let result_controls = document["ui"]["regions"]["result"]["controls"]
            .as_array()
            .unwrap();
        let log_viewer = result_controls
            .iter()
            .find(|control| control["type"] == "logViewer")
            .unwrap();
        assert_eq!(log_viewer["errorOnly"], true);
        assert_eq!(log_viewer["hideWhenEmpty"], true);
        assert_eq!(document["csvLog"]["rpmLoopLog"]["baseDir"], "executable");
        assert_eq!(document["csvLog"]["rpmLoopLog"]["bom"], true);
        assert_eq!(document["csvLog"]["rpmLoopLog"]["header"], false);
        let columns = document["csvLog"]["rpmLoopLog"]["columns"]
            .as_array()
            .unwrap();
        assert_eq!(columns[0], "time");
        assert_eq!(columns[1], "torqueTitle");
        assert_eq!(columns[2], "torqueValue");
        assert_eq!(document["helpers"]["bench"]["embedded"], true);
        assert!(document["helpers"]["bench"].get("luaPath").is_none());
        let row_group = &document["handlers"]["runCsv"][0]["steps"][0];
        assert_eq!(
            row_group["id"],
            "row-${csvPassIndex}-${csvIndex}-rpm-${row.rpm}-${row.mode}-${row.value}-delay-${row.delay}"
        );
        let row_steps = row_group["steps"].as_array().unwrap();
        let sample_steps = row_steps
            .iter()
            .find(|step| step["action"] == "repeat")
            .unwrap()["steps"]
            .as_array()
            .unwrap();
        let output_row = &sample_steps
            .iter()
            .find(|step| step["action"] == "logCsv")
            .unwrap()["row"];
        // Validate the exported schema against the row, so adding a measurement
        // cannot silently leave an empty CSV column or an unexported value.
        let column_names: std::collections::HashSet<&str> = columns
            .iter()
            .map(|column| column.as_str().expect("CSV column must be a string"))
            .collect();
        let row_keys: std::collections::HashSet<&str> = output_row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(column_names.len(), columns.len(), "duplicate CSV columns");
        assert_eq!(column_names, row_keys);
        let torque_request = sample_steps
            .iter()
            .find(|step| step["id"] == "read-torque-${csvIndex}-${index}")
            .unwrap();
        assert_eq!(torque_request["retry"]["times"], 4);
        assert_eq!(torque_request["retry"]["intervalMs"], 40);
        assert_eq!(output_row["torqueTitle"], "扭矩");
        assert_eq!(
            output_row["instantaneousPowerValue"],
            "${ftmsSample.instantaneousPowerW}"
        );
        assert_eq!(document["setup"][2]["channel"], "infrared1Uart");
        assert_eq!(
            document["setup"][2]["when"]["$ref"],
            "form.infrared1ChannelId"
        );
        assert_eq!(document["setup"][3]["channel"], "infrared2Uart");
        assert_eq!(
            document["handlers"]["runCsv"][0]["loop"]["$ref"],
            "form.loop"
        );
        let torque_decode = sample_steps
            .iter()
            .find(|step| step["func"] == "torqueMeasurement")
            .unwrap();
        assert_eq!(torque_decode["action"], "luaHelper");
        assert_eq!(torque_decode["helper"], "bench");
        assert_eq!(
            torque_decode["args"]["toothCount"]["$ref"],
            "form.torqueTeeth"
        );
        assert!(sample_steps
            .iter()
            .any(|step| step["action"] == "takeLatestPacket"));
    }

    #[test]
    fn parses_shipped_ftms_spin_down_template_with_external_helpers() {
        let script = include_str!("../../../config/script/script-ble-ftms-spin-down.lua");
        let document = parse_lua_script_document(script).unwrap();
        assert_eq!(
            document["helpers"]["bench"]["luaPath"],
            "../script-helper/script-helper-test-bench.lua"
        );
        let steps = document["steps"].as_array().unwrap();
        let target_decode = steps
            .iter()
            .find(|step| step["id"] == "decode-spin-down-target-range")
            .unwrap();
        assert_eq!(target_decode["action"], "luaHelper");
        assert_eq!(target_decode["func"], "spinDownTarget");
        let target_wait = steps
            .iter()
            .find(|step| step["id"] == "wait-target-speed")
            .unwrap();
        assert_eq!(
            target_wait["expect"]["luaHelper"]["func"],
            "indoorBikeSpeedInTarget"
        );
        let result_wait = steps
            .iter()
            .find(|step| step["id"] == "wait-spin-down-result")
            .unwrap();
        assert_eq!(
            result_wait["expect"]["luaHelper"]["func"],
            "spinDownResultReady"
        );
    }

    #[test]
    fn rejects_unimplemented_three_region_layouts() {
        let script = r#"
return {
  ui = {
    schemaVersion = 1,
    layout = { preset = "top-middle-bottom", regions = { "top", "middle" } },
    regions = {
      top = { controls = {} },
      middle = { controls = {} }
    }
  },
  handlers = { run = { { action = "log", message = "run" } } }
}
"#;
        let error = parse_lua_script_document(script).unwrap_err().to_string();
        assert!(error.contains("top-bottom or left-right"));
    }

    #[test]
    fn refuses_to_persist_password_controls() {
        let script = r#"
return {
  ui = {
    schemaVersion = 1,
    layout = { preset = "top-bottom", regions = { "top", "bottom" } },
    regions = {
      top = { controls = { { id = "secret", type = "password", bind = "form.secret", persist = true } } },
      bottom = { controls = {} }
    }
  },
  handlers = { run = { { action = "log", message = "run" } } }
}
"#;
        let error = parse_lua_script_document(script).unwrap_err().to_string();
        assert!(error.contains("persist cannot be true"));
    }

    #[test]
    fn parses_canvas_lifecycle_document() {
        let script = r#"
return {
  version = 1,
  name = "Lifecycle",
  onActivate = {
    { action = "send", channel = "canvas", data = { format = "hex", value = "01 02" } }
  },
  whileActive = {
    intervalMs = 1000,
    steps = {
      { action = "send", channel = "canvas", data = { format = "hex", value = "05 06" } }
    }
  },
  onDeactivate = {
    { action = "send", channel = "canvas", data = { format = "hex", value = "03 04" } }
  }
}
"#;
        let document = parse_lua_canvas_lifecycle_document(script).unwrap();
        assert_eq!(document["name"], "Lifecycle");
        assert_eq!(document["onActivate"][0]["channel"], "canvas");
        assert_eq!(
            document["whileActive"]["steps"][0]["data"]["value"],
            "05 06"
        );
        assert_eq!(document["onDeactivate"][0]["data"]["value"], "03 04");
    }

    #[test]
    fn accepts_canvas_lifecycle_with_while_active_only() {
        let script = r#"
return {
  version = 1,
  name = "Lifecycle",
  whileActive = {
    intervalMs = 1000,
    steps = {
      { action = "send", channel = "canvas", data = { format = "hex", value = "01 02" } }
    }
  }
}
"#;
        let document = parse_lua_canvas_lifecycle_document(script).unwrap();
        assert_eq!(document["whileActive"]["intervalMs"], 1000);
    }

    #[test]
    fn rejects_canvas_lifecycle_without_hooks() {
        let script =
            r#"return { version = 1, name = "Lifecycle", setup = { { action = "delay" } } }"#;
        let error = parse_lua_canvas_lifecycle_document(script)
            .unwrap_err()
            .to_string();
        assert!(error.contains("onActivate, onDeactivate, or whileActive"));
    }

    #[test]
    fn rejects_canvas_lifecycle_file_name_without_prefix() {
        let error = ensure_canvas_lifecycle_file_name("E:/test/script-init.lua")
            .unwrap_err()
            .to_string();
        assert!(error.contains("canvas-lifecycle-"));
    }
}
