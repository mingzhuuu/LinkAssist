use crate::channel_registry::ChannelBinding;
use crate::error::AppError;
use crate::AppState;
use tauri::State;

/// Frontend hooks mirror their connection bookkeeping here so headless
/// callers (MCP Lua tools) can resolve "the current channel" to a transport.
#[tauri::command]
pub async fn register_channel_connection(
    state: State<'_, AppState>,
    channel_id: String,
    channel_type: String,
    connection_id: String,
    target_addr: Option<String>,
) -> Result<(), AppError> {
    state
        .channel_registry
        .register(
            channel_id,
            ChannelBinding {
                channel_type,
                connection_id,
                target_addr,
            },
        )
        .await;
    Ok(())
}

#[tauri::command]
pub async fn unregister_channel_connection(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), AppError> {
    state.channel_registry.unregister(&channel_id).await;
    Ok(())
}
