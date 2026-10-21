use crate::channel_activity::{
    capture_tool_error_arguments, emit_tool_error, ToolInvocationContext,
};
use crate::discovery::{self, CORE_BIND_ADDR};
use crate::mcp_tools;
use crate::persistence::load_config;
use crate::{reveal_main_window, AppError, AppState, McpToolAccess, UiLifecycle};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use uuid::Uuid;

const BRIDGE_LEASE_TTL: Duration = Duration::from_secs(20);
const BRIDGE_LEASE_MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const SHUTDOWN_HOOK_TIMEOUT: Duration = Duration::from_secs(4);
const TOOL_EXECUTION_RETENTION: Duration = Duration::from_secs(60 * 60);
const MAX_TOOL_EXECUTIONS: usize = 128;

#[derive(Clone, Default)]
struct BridgeLeaseRegistry {
    leases: Arc<Mutex<HashMap<String, Instant>>>,
    ever_acquired: Arc<AtomicBool>,
}

impl BridgeLeaseRegistry {
    async fn renew(&self, lease_id: String, ui_lifecycle: &UiLifecycle) -> Result<usize, ()> {
        let mut leases = self.leases.lock().await;
        Self::remove_expired(&mut leases);
        if ui_lifecycle.is_shutting_down() {
            return Err(());
        }
        leases.insert(lease_id, Instant::now() + BRIDGE_LEASE_TTL);
        self.ever_acquired.store(true, Ordering::SeqCst);
        Ok(leases.len())
    }

    async fn release(&self, lease_id: &str) -> usize {
        let mut leases = self.leases.lock().await;
        leases.remove(lease_id);
        Self::remove_expired(&mut leases);
        leases.len()
    }

    async fn begin_shutdown_if_idle(&self, ui_lifecycle: &UiLifecycle) -> bool {
        let mut leases = self.leases.lock().await;
        Self::remove_expired(&mut leases);
        leases.is_empty() && ui_lifecycle.begin_shutdown()
    }

    fn has_ever_acquired(&self) -> bool {
        self.ever_acquired.load(Ordering::SeqCst)
    }

    fn remove_expired(leases: &mut HashMap<String, Instant>) {
        let now = Instant::now();
        leases.retain(|_, expires_at| *expires_at > now);
    }
}

#[derive(Clone)]
struct ToolExecutionRecord {
    tool_name: String,
    response: Option<ToolCallResponse>,
    finished_at: Option<Instant>,
}

#[derive(Clone, Default)]
struct ToolExecutionRegistry {
    executions: Arc<Mutex<HashMap<String, ToolExecutionRecord>>>,
}

impl ToolExecutionRegistry {
    async fn start(&self, tool_name: String) -> Result<ToolExecutionSnapshot, ()> {
        let mut executions = self.executions.lock().await;
        Self::remove_expired(&mut executions);
        while executions.len() >= MAX_TOOL_EXECUTIONS {
            let oldest_completed = executions
                .iter()
                .filter_map(|(execution_id, execution)| {
                    execution
                        .finished_at
                        .map(|finished_at| (execution_id.clone(), finished_at))
                })
                .min_by_key(|(_, finished_at)| *finished_at)
                .map(|(execution_id, _)| execution_id);
            let Some(execution_id) = oldest_completed else {
                return Err(());
            };
            executions.remove(&execution_id);
        }
        let execution_id = Uuid::new_v4().to_string();
        executions.insert(
            execution_id.clone(),
            ToolExecutionRecord {
                tool_name: tool_name.clone(),
                response: None,
                finished_at: None,
            },
        );
        Ok(ToolExecutionSnapshot::running(execution_id, tool_name))
    }

    async fn finish(&self, execution_id: &str, response: ToolCallResponse) {
        let mut executions = self.executions.lock().await;
        if let Some(execution) = executions.get_mut(execution_id) {
            execution.response = Some(response);
            execution.finished_at = Some(Instant::now());
        }
    }

    async fn get(&self, execution_id: &str) -> Option<ToolExecutionSnapshot> {
        let mut executions = self.executions.lock().await;
        Self::remove_expired(&mut executions);
        let execution = executions.get(execution_id)?;
        Some(match &execution.response {
            Some(response) => ToolExecutionSnapshot::completed(
                execution_id.to_string(),
                execution.tool_name.clone(),
                response.clone(),
            ),
            None => ToolExecutionSnapshot::running(
                execution_id.to_string(),
                execution.tool_name.clone(),
            ),
        })
    }

    async fn has_running(&self) -> bool {
        let mut executions = self.executions.lock().await;
        Self::remove_expired(&mut executions);
        executions
            .values()
            .any(|execution| execution.response.is_none())
    }

    fn remove_expired(executions: &mut HashMap<String, ToolExecutionRecord>) {
        let now = Instant::now();
        executions.retain(|_, execution| {
            execution.finished_at.is_none_or(|finished_at| {
                now.duration_since(finished_at) < TOOL_EXECUTION_RETENTION
            })
        });
    }
}

#[derive(Clone)]
struct HttpState {
    app_state: AppState,
    app_handle: AppHandle,
    token: Arc<String>,
    ui_lifecycle: UiLifecycle,
    mcp_tool_access: McpToolAccess,
    bridge_leases: BridgeLeaseRegistry,
    tool_executions: ToolExecutionRegistry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRequest {
    pub arguments: Option<Value>,
    #[serde(default)]
    pub context: Option<ToolInvocationContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolExecutionSnapshot {
    execution_id: String,
    tool_name: String,
    status: &'static str,
    ok: Option<bool>,
    result: Option<Value>,
    error: Option<String>,
}

impl ToolExecutionSnapshot {
    fn running(execution_id: String, tool_name: String) -> Self {
        Self {
            execution_id,
            tool_name,
            status: "running",
            ok: None,
            result: None,
            error: None,
        }
    }

    fn completed(execution_id: String, tool_name: String, response: ToolCallResponse) -> Self {
        Self {
            execution_id,
            tool_name,
            status: "completed",
            ok: Some(response.ok),
            result: response.result,
            error: response.error,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolListResponse {
    tools: Vec<mcp_tools::McpToolDefinition>,
}

pub async fn serve_core_http(
    app_state: AppState,
    app_handle: AppHandle,
    ui_lifecycle: UiLifecycle,
    mcp_tool_access: McpToolAccess,
) {
    if let Err(error) =
        serve_core_http_inner(app_state, app_handle, ui_lifecycle, mcp_tool_access).await
    {
        eprintln!("Core HTTP server failed: {}", error);
    }
}

async fn serve_core_http_inner(
    app_state: AppState,
    app_handle: AppHandle,
    ui_lifecycle: UiLifecycle,
    mcp_tool_access: McpToolAccess,
) -> Result<(), AppError> {
    let token = Uuid::new_v4().to_string();
    let listener = TcpListener::bind(CORE_BIND_ADDR).await?;
    let port = listener.local_addr()?.port();
    let core_discovery =
        discovery::write_discovery(port, token.clone(), ui_lifecycle.mode()).await?;

    let state = HttpState {
        app_state,
        app_handle,
        token: Arc::new(token),
        ui_lifecycle,
        mcp_tool_access,
        bridge_leases: BridgeLeaseRegistry::default(),
        tool_executions: ToolExecutionRegistry::default(),
    };
    tokio::spawn(monitor_bridge_leases(state.clone()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/ui/show", post(show_ui))
        .route("/core/shutdown", post(shutdown_core))
        .route(
            "/core/leases/{lease_id}/acquire",
            post(acquire_bridge_lease),
        )
        .route(
            "/core/leases/{lease_id}/release",
            post(release_bridge_lease),
        )
        .route("/mcp/tools/list", get(list_tools))
        .route("/mcp/tools/{name}/call", post(call_tool))
        .route("/mcp/tools/{name}/start", post(start_tool))
        .route(
            "/mcp/tool-executions/{execution_id}",
            get(get_tool_execution),
        )
        .with_state(state);

    let result = axum::serve(listener, app).await;
    let _ = discovery::remove_discovery_if_owner(core_discovery.pid, core_discovery.token.as_str())
        .await;
    result.map_err(AppError::Io)
}

async fn health(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    Ok(Json(json!({ "ok": true, "addr": addr.ip().to_string() })))
}

async fn show_ui(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    let frontend_ready = state
        .ui_lifecycle
        .request_ui()
        .map_err(|_| StatusCode::CONFLICT)?;
    let _ = discovery::update_discovery_mode(
        std::process::id(),
        state.token.as_str(),
        state.ui_lifecycle.mode(),
    )
    .await;
    // A WebView created for a headless Core may suspend its frontend while the
    // native window is hidden. The explicit /ui/show request is the user action
    // that permits revealing it; once visible, the frontend can finish loading
    // and main_window_ready will focus it again after hydration.
    reveal_main_window(&state.app_handle).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(
        json!({ "ok": true, "shown": true, "frontendReady": frontend_ready }),
    ))
}

async fn acquire_bridge_lease(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(lease_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    let active_leases = state
        .bridge_leases
        .renew(lease_id, &state.ui_lifecycle)
        .await
        .map_err(|_| StatusCode::CONFLICT)?;
    Ok(Json(json!({ "ok": true, "activeLeases": active_leases })))
}

async fn release_bridge_lease(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(lease_id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    let active_leases = state.bridge_leases.release(&lease_id).await;
    Ok(Json(json!({ "ok": true, "activeLeases": active_leases })))
}

async fn shutdown_core(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    authorize(&state, &headers)?;
    // Once a user explicitly requests the UI, ownership has moved beyond the
    // MCP bridge that originally spawned this Core. Keep that UI session alive.
    let window_visible = state
        .app_handle
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if window_visible
        || state.ui_lifecycle.is_ui_requested()
        || state.tool_executions.has_running().await
        || !state
            .bridge_leases
            .begin_shutdown_if_idle(&state.ui_lifecycle)
            .await
    {
        return Err(StatusCode::CONFLICT);
    }
    Ok(Json(
        json!({ "ok": true, "shutdownHookErrors": finish_shutdown(&state).await }),
    ))
}

async fn monitor_bridge_leases(state: HttpState) {
    loop {
        tokio::time::sleep(BRIDGE_LEASE_MONITOR_INTERVAL).await;
        if state.ui_lifecycle.is_ui_requested() || state.ui_lifecycle.is_shutting_down() {
            return;
        }
        if !state.bridge_leases.has_ever_acquired() {
            continue;
        }
        if state.tool_executions.has_running().await {
            continue;
        }
        if state
            .bridge_leases
            .begin_shutdown_if_idle(&state.ui_lifecycle)
            .await
        {
            let _ = finish_shutdown(&state).await;
            return;
        }
    }
}

async fn finish_shutdown(state: &HttpState) -> Vec<String> {
    run_shutdown_hooks_and_exit(&state.app_state, state.app_handle.clone()).await
}

/// Best-effort MCP shutdown hooks with a wall-clock timeout, then Core exit.
/// Shared by the `/core/shutdown` HTTP endpoint and the tray quit action.
pub(crate) async fn run_shutdown_hooks_and_exit(
    app_state: &AppState,
    app_handle: AppHandle,
) -> Vec<String> {
    let hook_errors = shutdown_hook_errors_with_timeout(
        mcp_tools::run_configured_shutdown_hooks(app_state, app_handle.clone()),
        SHUTDOWN_HOOK_TIMEOUT,
    )
    .await;
    for error in &hook_errors {
        eprintln!("MCP shutdown hook failed: {}", error);
    }
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        app_handle.exit(0);
    });
    hook_errors
}

async fn shutdown_hook_errors_with_timeout<F>(hooks: F, timeout: Duration) -> Vec<String>
where
    F: std::future::Future<Output = Vec<String>>,
{
    match tokio::time::timeout(timeout, hooks).await {
        Ok(errors) => errors,
        Err(_) => vec![format!(
            "MCP shutdown hooks exceeded {} ms; forcing Core exit",
            timeout.as_millis()
        )],
    }
}

async fn call_tool(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(request): Json<ToolCallRequest>,
) -> Result<Json<ToolCallResponse>, StatusCode> {
    authorize(&state, &headers)?;
    if !state.mcp_tool_access.is_enabled() {
        return Ok(Json(ToolCallResponse {
            ok: false,
            result: None,
            error: Some("MCP tools are disabled in LinkAssist settings".to_string()),
        }));
    }
    let arguments = request.arguments.unwrap_or_else(|| json!({}));
    let response = execute_tool(&state, &name, arguments, request.context).await;
    Ok(Json(response))
}

async fn start_tool(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(request): Json<ToolCallRequest>,
) -> Result<Json<ToolExecutionSnapshot>, StatusCode> {
    authorize(&state, &headers)?;
    if !state.mcp_tool_access.is_enabled() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let arguments = request.arguments.unwrap_or_else(|| json!({}));
    let context = request.context;
    let started = state
        .tool_executions
        .start(name.clone())
        .await
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let execution_id = started.execution_id.clone();
    let background_state = state.clone();
    tokio::spawn(async move {
        let response = execute_tool(&background_state, &name, arguments, context).await;
        background_state
            .tool_executions
            .finish(&execution_id, response)
            .await;
    });
    Ok(Json(started))
}

async fn get_tool_execution(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Path(execution_id): Path<String>,
) -> Result<Json<ToolExecutionSnapshot>, StatusCode> {
    authorize(&state, &headers)?;
    state
        .tool_executions
        .get(&execution_id)
        .await
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

async fn execute_tool(
    state: &HttpState,
    name: &str,
    arguments: Value,
    context: Option<ToolInvocationContext>,
) -> ToolCallResponse {
    let activity_arguments = capture_tool_error_arguments(name, &arguments);
    let activity_context = context.clone();
    match mcp_tools::call_tool(
        &state.app_state,
        state.app_handle.clone(),
        name,
        arguments,
        context,
    )
    .await
    {
        Ok(result) => ToolCallResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => {
            if let Some(activity_arguments) = &activity_arguments {
                emit_tool_error(
                    &state.app_handle,
                    activity_context.as_ref(),
                    name,
                    activity_arguments,
                    &error.to_string(),
                );
            }
            ToolCallResponse {
                ok: false,
                result: None,
                error: Some(error.to_string()),
            }
        }
    }
}

async fn list_tools(
    State(state): State<HttpState>,
    headers: HeaderMap,
) -> Result<Json<ToolListResponse>, StatusCode> {
    authorize(&state, &headers)?;
    if !state.mcp_tool_access.is_enabled() {
        return Ok(Json(ToolListResponse { tools: Vec::new() }));
    }
    let config = load_config(&state.app_handle).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(ToolListResponse {
        tools: mcp_tools::tool_definitions_with_config(&config),
    }))
}

fn authorize(state: &HttpState, headers: &HeaderMap) -> Result<(), StatusCode> {
    let Some(value) = headers.get("authorization") else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let Ok(value) = value.to_str() else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let expected = format!("Bearer {}", state.token.as_str());
    if value == expected {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        shutdown_hook_errors_with_timeout, BridgeLeaseRegistry, ToolCallResponse,
        ToolExecutionRegistry, MAX_TOOL_EXECUTIONS,
    };
    use crate::UiLifecycle;
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn active_bridge_lease_blocks_shutdown_until_release() {
        let leases = BridgeLeaseRegistry::default();
        let lifecycle = UiLifecycle::new(true);

        assert_eq!(
            leases.renew("bridge-a".to_string(), &lifecycle).await,
            Ok(1)
        );
        assert!(!leases.begin_shutdown_if_idle(&lifecycle).await);
        assert_eq!(leases.release("bridge-a").await, 0);
        assert!(leases.begin_shutdown_if_idle(&lifecycle).await);
        assert!(lifecycle.is_shutting_down());
    }

    #[tokio::test]
    async fn ui_request_wins_over_idle_shutdown() {
        let leases = BridgeLeaseRegistry::default();
        let lifecycle = UiLifecycle::new(true);

        assert_eq!(lifecycle.request_ui(), Ok(false));
        assert!(!leases.begin_shutdown_if_idle(&lifecycle).await);
    }

    #[tokio::test]
    async fn shutdown_hooks_have_a_wall_clock_timeout() {
        let errors = shutdown_hook_errors_with_timeout(
            std::future::pending::<Vec<String>>(),
            Duration::from_millis(10),
        )
        .await;

        assert_eq!(
            errors,
            vec!["MCP shutdown hooks exceeded 10 ms; forcing Core exit"]
        );
    }

    #[tokio::test]
    async fn tool_execution_registry_reports_running_then_completed() {
        let executions = ToolExecutionRegistry::default();
        let started = executions
            .start("slow_fixture".to_string())
            .await
            .expect("fixture execution should start");
        assert_eq!(started.status, "running");
        assert_eq!(started.ok, None);
        assert!(executions.has_running().await);

        executions
            .finish(
                &started.execution_id,
                ToolCallResponse {
                    ok: true,
                    result: Some(json!({ "answer": 42 })),
                    error: None,
                },
            )
            .await;

        let completed = executions
            .get(&started.execution_id)
            .await
            .expect("completed execution remains queryable");
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.ok, Some(true));
        assert_eq!(completed.result, Some(json!({ "answer": 42 })));
        assert!(!executions.has_running().await);
    }

    #[tokio::test]
    async fn tool_execution_registry_evicts_completed_entries_at_capacity() {
        let executions = ToolExecutionRegistry::default();
        for index in 0..MAX_TOOL_EXECUTIONS {
            let started = executions
                .start(format!("fixture_{index}"))
                .await
                .expect("fixture execution should start");
            executions
                .finish(
                    &started.execution_id,
                    ToolCallResponse {
                        ok: true,
                        result: None,
                        error: None,
                    },
                )
                .await;
        }

        let extra = executions
            .start("extra_fixture".to_string())
            .await
            .expect("a completed entry should be evicted instead of rejecting new work");
        assert_eq!(extra.status, "running");
        assert_eq!(
            executions.executions.lock().await.len(),
            MAX_TOOL_EXECUTIONS
        );
    }
}
