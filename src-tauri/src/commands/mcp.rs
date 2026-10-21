use crate::mcp_tools::{
    load_mcp_tool_meta_from_path, McpResolvedScriptTool, McpToolScript, McpToolScriptPreview,
    McpToolScriptSourceType,
};
use crate::{AppError, AppResult, AppState};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn get_mcp_tool_meta(file_path: String) -> AppResult<McpToolScriptPreview> {
    let file_path = crate::snapshot::resolve_path(&file_path);
    load_mcp_tool_meta_from_path(&file_path)
}

/// Run one tool from a Lua MCP tool script identified by file path, without it being registered
/// in the app config.
///
/// Registration exists so a script's tools appear on the MCP surface for outside callers. An
/// automation script running inside the app already names the file it wants, so requiring a
/// registration step first would only add a setup ritual that can drift out of date. The script
/// still loads through the same marker check, sandbox and limits as a registered one.
#[tauri::command]
pub async fn run_mcp_tool_script_file(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    file_path: String,
    tool: String,
    args: Option<Value>,
    channel_id: Option<String>,
) -> AppResult<Value> {
    let file_path = crate::snapshot::resolve_path(&file_path);
    let preview = load_mcp_tool_meta_from_path(&file_path)?;
    let meta = preview
        .tools
        .into_iter()
        .find(|candidate| candidate.name == tool)
        .ok_or_else(|| {
            AppError::Protocol(format!(
                "Lua MCP tool script '{}' does not define a tool named '{}'",
                file_path, tool
            ))
        })?;

    let resolved = McpResolvedScriptTool {
        script: McpToolScript {
            id: format!("file:{}", file_path),
            name: meta.name.clone(),
            description: meta.description.clone(),
            expose_to_mcp: false,
            source_type: McpToolScriptSourceType::File,
            inline_lua: String::new(),
            lua_path: Some(file_path),
            input_schema: meta.input_schema.clone(),
            use_current_channel: channel_id.is_some(),
            target_channel_id: channel_id.clone(),
            protocol_file: meta.protocol_file.clone(),
            protocol_resource_root: None,
        },
        meta,
    };

    crate::mcp_tool_script::execute_mcp_tool_script(
        &state,
        Some(app_handle),
        &resolved,
        args.unwrap_or_else(|| json!({})),
        channel_id,
    )
    .await
}
