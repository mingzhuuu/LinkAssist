use crate::{AppError, AppResult};
use serde_json::{json, Value};

#[tauri::command]
pub async fn call_lua_script_helper_file(
    file_path: String,
    func: String,
    args: Option<Value>,
    base_file_path: Option<String>,
    embedded: Option<bool>,
) -> AppResult<Value> {
    let resolved_base = base_file_path.as_deref().map(crate::snapshot::resolve_path);
    let file_path = crate::snapshot::resolve_path_with_base(&file_path, resolved_base.as_deref());
    tokio::task::spawn_blocking(move || {
        let args = args.unwrap_or_else(|| json!({}));
        if embedded.unwrap_or(false) {
            crate::script_helper::call_lua_embedded_script_helper_file(
                &file_path,
                resolved_base.as_deref(),
                &func,
                args,
            )
        } else {
            crate::script_helper::call_lua_script_helper_file(
                &file_path,
                resolved_base.as_deref(),
                &func,
                args,
            )
        }
    })
    .await
    .map_err(|error| {
        AppError::Protocol(format!(
            "Lua script helper task failed to complete: {error}"
        ))
    })?
}
