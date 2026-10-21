use crate::error::AppError;
use crate::protocol::{
    lua_engine::LuaEngine, FieldDefinition, LuaEncodeResult, LuaTransactionEncodeResult,
    LuaTransactionMatchResult, ParseResult, ParserMode, ProtocolFileSummary, ProtocolTemplate,
};
use crate::AppState;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

fn resolve_protocol_paths(
    file_path: String,
    resource_root: Option<String>,
) -> (PathBuf, Option<PathBuf>) {
    (
        PathBuf::from(crate::snapshot::resolve_path(&file_path)),
        resource_root.map(|path| PathBuf::from(crate::snapshot::resolve_path(&path))),
    )
}

#[tauri::command]
pub async fn parse_data(
    state: State<'_, AppState>,
    data: Vec<u8>,
) -> Result<ParseResult, AppError> {
    let manager = state.protocol_manager.lock().await;
    manager.parse(&data)
}

#[tauri::command]
pub async fn set_parser_mode(state: State<'_, AppState>, mode: ParserMode) -> Result<(), AppError> {
    let mut manager = state.protocol_manager.lock().await;
    manager.set_mode(mode);
    Ok(())
}

#[tauri::command]
pub async fn get_parser_mode(state: State<'_, AppState>) -> Result<ParserMode, AppError> {
    let manager = state.protocol_manager.lock().await;
    Ok(manager.current_mode.clone())
}

#[tauri::command]
pub async fn set_field_definitions(
    state: State<'_, AppState>,
    fields: Vec<FieldDefinition>,
) -> Result<(), AppError> {
    let mut manager = state.protocol_manager.lock().await;
    manager.set_field_definitions(fields);
    Ok(())
}

#[tauri::command]
pub async fn get_field_definitions(
    state: State<'_, AppState>,
) -> Result<Vec<FieldDefinition>, AppError> {
    let manager = state.protocol_manager.lock().await;
    Ok(manager.get_field_definitions().to_vec())
}

#[tauri::command]
pub async fn load_lua_script(state: State<'_, AppState>, script: String) -> Result<(), AppError> {
    let mut manager = state.protocol_manager.lock().await;
    manager.load_lua_script(&script)
}

#[tauri::command]
pub fn validate_lua_script(script: String) -> Result<(), AppError> {
    LuaEngine::validate_script(&script)
}

#[tauri::command]
pub fn get_protocol_templates() -> Result<Vec<ProtocolTemplate>, AppError> {
    Ok(crate::protocol::ProtocolManager::get_templates())
}

#[tauri::command]
pub async fn apply_protocol_template(
    state: State<'_, AppState>,
    template_id: String,
) -> Result<(), AppError> {
    let mut manager = state.protocol_manager.lock().await;
    manager.apply_template(&template_id)
}

#[tauri::command]
pub fn get_lua_protocol_file_summary(
    file_path: String,
    resource_root: Option<String>,
) -> Result<ProtocolFileSummary, AppError> {
    let (file_path, resource_root) = resolve_protocol_paths(file_path, resource_root);
    crate::protocol::ProtocolManager::get_lua_protocol_file_summary(file_path, resource_root)
}

#[tauri::command]
pub fn parse_data_with_lua_file(
    file_path: String,
    resource_root: Option<String>,
    data: Vec<u8>,
) -> Result<ParseResult, AppError> {
    let (file_path, resource_root) = resolve_protocol_paths(file_path, resource_root);
    crate::protocol::ProtocolManager::parse_data_with_lua_file(file_path, resource_root, &data)
}

#[tauri::command]
pub fn encode_field_with_lua_file(
    file_path: String,
    resource_root: Option<String>,
    field_id: String,
    value: String,
) -> Result<LuaEncodeResult, AppError> {
    let (file_path, resource_root) = resolve_protocol_paths(file_path, resource_root);
    crate::protocol::ProtocolManager::encode_field_with_lua_file(
        file_path,
        resource_root,
        &field_id,
        &value,
    )
}

#[tauri::command]
pub fn encode_transaction_with_lua_file(
    file_path: String,
    resource_root: Option<String>,
    transaction_id: String,
    values: Option<Value>,
) -> Result<LuaTransactionEncodeResult, AppError> {
    let (file_path, resource_root) = resolve_protocol_paths(file_path, resource_root);
    let values_json = match values {
        Some(value) if !value.is_null() => {
            serde_json::to_string(&value).map_err(AppError::Serde)?
        }
        _ => "{}".to_string(),
    };
    crate::protocol::ProtocolManager::encode_transaction_with_lua_file(
        file_path,
        resource_root,
        &transaction_id,
        &values_json,
    )
}

#[tauri::command]
pub fn match_transaction_response_with_lua_file(
    file_path: String,
    resource_root: Option<String>,
    transaction_id: String,
    data: Vec<u8>,
) -> Result<LuaTransactionMatchResult, AppError> {
    let (file_path, resource_root) = resolve_protocol_paths(file_path, resource_root);
    crate::protocol::ProtocolManager::match_transaction_response_with_lua_file(
        file_path,
        resource_root,
        &transaction_id,
        &data,
    )
}
