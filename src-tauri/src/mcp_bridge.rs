use crate::discovery::{self, CoreDiscovery};
use crate::{mcp_tools, persistence};
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::process::Child;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use uuid::Uuid;

const CORE_LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CORE_LEASE_RETRY_INTERVAL: Duration = Duration::from_secs(1);
const CORE_LEASE_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
// The server lease TTL is 20 seconds. Reserve the request timeout plus one
// second so an in-flight renewal cannot leave a briefly false-valid lease.
const CORE_LEASE_VALIDITY_WINDOW: Duration = Duration::from_secs(16);

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ToolsCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreToolResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreToolListResponse {
    tools: Vec<McpToolDefinition>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreLeaseResponse {
    active_leases: usize,
}

pub async fn run_stdio_bridge() -> AppResult<()> {
    if discovery::explicit_shutdown_in_progress() {
        return Ok(());
    }
    start_explicit_shutdown_watcher();
    let mut managed_core: Option<ManagedCore> = None;
    let result = run_stdio_loop(&mut managed_core).await;
    if let Some(core) = managed_core {
        release_managed_core(core).await;
    }
    result
}

fn start_explicit_shutdown_watcher() {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(50));
        if discovery::explicit_shutdown_in_progress() {
            std::process::exit(0);
        }
    });
}

async fn run_stdio_loop(managed_core: &mut Option<ManagedCore>) -> AppResult<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        let line = line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(line) {
            Ok(request) => handle_request(request, managed_core).await,
            Err(error) => JsonRpcResponse {
                jsonrpc: "2.0",
                id: None,
                result: None,
                error: Some(JsonRpcError {
                    code: -32700,
                    message: format!("Parse error: {}", error),
                }),
            },
        };
        if response.id.is_some() || response.error.is_some() || response.result.is_some() {
            let json = serde_json::to_string(&response)?;
            writeln!(stdout, "{}", json)?;
            stdout.flush()?;
        }
    }
    Ok(())
}

struct ManagedCore {
    discovery: CoreDiscovery,
    child: Option<Child>,
    lease_id: String,
    lease_valid: Arc<AtomicBool>,
    heartbeat: tokio::task::JoinHandle<()>,
}

async fn handle_request(
    request: JsonRpcRequest,
    managed_core: &mut Option<ManagedCore>,
) -> JsonRpcResponse {
    let mcp_access_error = match request.method.as_str() {
        "tools/list" | "tools/call" => bridge_mcp_access_error(),
        _ => None,
    };
    handle_request_with_access(request, managed_core, mcp_access_error).await
}

async fn handle_request_with_access(
    request: JsonRpcRequest,
    managed_core: &mut Option<ManagedCore>,
    mcp_access_error: Option<String>,
) -> JsonRpcResponse {
    let id = request.id.clone();
    if let Some(error) = mcp_access_error {
        if let Some(core) = managed_core.take() {
            release_managed_core(core).await;
        }
        return match request.method.as_str() {
            "tools/list" => ok(id, json!({ "tools": [], "error": error })),
            "tools/call" => ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": error }],
                    "isError": true
                }),
            ),
            _ => unreachable!("MCP access is checked only for MCP tool requests"),
        };
    }
    match request.method.as_str() {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "LinkAssist", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "notifications/initialized" => JsonRpcResponse {
            jsonrpc: "2.0",
            id: None,
            result: None,
            error: None,
        },
        "ping" => ok(id, json!({})),
        "tools/list" => match list_core_tools(managed_core).await {
            Ok(result) => ok(id, result),
            Err(error) => ok(
                id,
                json!({
                    "tools": [],
                    "error": error.to_string()
                }),
            ),
        },
        "tools/call" => match call_core_tool(request.params, managed_core).await {
            Ok(result) => ok(id, result),
            Err(error) => ok(
                id,
                json!({
                    "content": [{ "type": "text", "text": error.to_string() }],
                    "isError": true
                }),
            ),
        },
        _ => JsonRpcResponse {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Method not found: {}", request.method),
            }),
        },
    }
}

fn bridge_mcp_access_error() -> Option<String> {
    match persistence::load_config_for_bridge()
        .map_err(AppError::Protocol)
        .and_then(|config| mcp_tools::mcp_tools_enabled(&config))
    {
        Ok(true) => None,
        Ok(false) => Some("MCP tools are disabled in LinkAssist settings".to_string()),
        Err(error) => Some(format!(
            "MCP tools are disabled because their saved state could not be read: {error}"
        )),
    }
}

async fn call_core_tool(
    params: Option<Value>,
    managed_core: &mut Option<ManagedCore>,
) -> AppResult<Value> {
    let params: ToolsCallParams = serde_json::from_value(params.unwrap_or_else(|| json!({})))?;
    let discovery = ensure_managed_core(managed_core).await?;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/mcp/tools/{}/call",
            discovery.base_url(),
            params.name
        ))
        .bearer_auth(&discovery.token)
        .json(&json!({ "arguments": params.arguments }))
        .send()
        .await
        .map_err(|error| AppError::Tcp(format!("Core tool call failed: {}", error)))?;
    if !response.status().is_success() {
        return Err(AppError::Tcp(format!(
            "Core tool call returned HTTP {}",
            response.status()
        )));
    }
    let core_response: CoreToolResponse = response.json().await.map_err(|error| {
        AppError::Serde(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )))
    })?;
    if !core_response.ok {
        return Err(AppError::Protocol(
            core_response
                .error
                .unwrap_or_else(|| "Tool call failed".to_string()),
        ));
    }

    Ok(json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(&core_response.result.unwrap_or_else(|| json!({})))?
        }],
        "isError": false
    }))
}

async fn list_core_tools(managed_core: &mut Option<ManagedCore>) -> AppResult<Value> {
    let discovery = ensure_managed_core(managed_core).await?;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/mcp/tools/list", discovery.base_url()))
        .bearer_auth(&discovery.token)
        .send()
        .await
        .map_err(|error| AppError::Tcp(format!("Core tool list failed: {}", error)))?;
    if !response.status().is_success() {
        return Err(AppError::Tcp(format!(
            "Core tool list returned HTTP {}",
            response.status()
        )));
    }
    let core_response: CoreToolListResponse = response.json().await.map_err(|error| {
        AppError::Serde(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )))
    })?;

    Ok(json!({
        "tools": core_response
            .tools
            .into_iter()
            .map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema }))
            .collect::<Vec<Value>>()
    }))
}

async fn ensure_managed_core(managed_core: &mut Option<ManagedCore>) -> AppResult<CoreDiscovery> {
    if let Some(core) = managed_core.as_ref() {
        let lease_valid = core.lease_valid.load(Ordering::Acquire);
        let core_healthy = discovery::core_is_healthy(&core.discovery).await;
        if !lease_valid || !core_healthy {
            if let Some(mut stale_core) = managed_core.take() {
                stale_core.heartbeat.abort();
                let _ =
                    update_core_lease(&stale_core.discovery, &stale_core.lease_id, "release").await;
                if should_stop_owned_core(stale_core.child.is_some(), core_healthy) {
                    if let Some(child) = stale_core.child.as_mut() {
                        stop_and_reap_child(child);
                    }
                } else if let Some(child) = stale_core.child.as_mut() {
                    let _ = child.try_wait();
                }
            }
        }
    }

    if managed_core.is_none() {
        *managed_core = Some(create_managed_core().await?);
    }
    managed_core
        .as_ref()
        .map(|core| core.discovery.clone())
        .ok_or_else(|| AppError::Tcp("Core daemon was not initialized".to_string()))
}

async fn create_managed_core() -> AppResult<ManagedCore> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let (discovery, mut child) = discovery::ensure_core_running().await?;
        let lease_id = Uuid::new_v4().to_string();
        match update_core_lease(&discovery, &lease_id, "acquire").await {
            Ok(_) => {
                let lease_valid = Arc::new(AtomicBool::new(true));
                let heartbeat = start_core_lease_heartbeat(
                    discovery.clone(),
                    lease_id.clone(),
                    Arc::clone(&lease_valid),
                );
                return Ok(ManagedCore {
                    discovery,
                    child,
                    lease_id,
                    lease_valid,
                    heartbeat,
                });
            }
            Err(error) => {
                if let Some(child) = child.as_mut() {
                    let _ = child.try_wait();
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(error);
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
    }
}

fn start_core_lease_heartbeat(
    discovery: CoreDiscovery,
    lease_id: String,
    lease_valid: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last_success = tokio::time::Instant::now();
        let mut next_attempt = CORE_LEASE_HEARTBEAT_INTERVAL;
        loop {
            tokio::time::sleep(next_attempt).await;
            match update_core_lease(&discovery, &lease_id, "acquire").await {
                Ok(_) => {
                    last_success = tokio::time::Instant::now();
                    lease_valid.store(true, Ordering::Release);
                    next_attempt = CORE_LEASE_HEARTBEAT_INTERVAL;
                }
                Err(_) => {
                    let elapsed = last_success.elapsed();
                    match heartbeat_failure_action(elapsed) {
                        HeartbeatFailureAction::RetryAfter(delay) => {
                            next_attempt = delay;
                        }
                        HeartbeatFailureAction::MarkInvalid => {
                            lease_valid.store(false, Ordering::Release);
                            return;
                        }
                    }
                }
            }
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeartbeatFailureAction {
    RetryAfter(Duration),
    MarkInvalid,
}

fn heartbeat_failure_action(elapsed_since_success: Duration) -> HeartbeatFailureAction {
    if elapsed_since_success >= CORE_LEASE_VALIDITY_WINDOW {
        HeartbeatFailureAction::MarkInvalid
    } else {
        HeartbeatFailureAction::RetryAfter(
            CORE_LEASE_RETRY_INTERVAL.min(CORE_LEASE_VALIDITY_WINDOW - elapsed_since_success),
        )
    }
}

fn should_stop_owned_core(has_owned_child: bool, core_healthy: bool) -> bool {
    has_owned_child && !core_healthy
}

fn stop_and_reap_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

async fn release_managed_core(mut core: ManagedCore) {
    core.heartbeat.abort();
    let remaining_leases = update_core_lease(&core.discovery, &core.lease_id, "release")
        .await
        .ok();
    if remaining_leases == Some(0) {
        let shutdown_accepted = discovery::post_core_control(&core.discovery, "/core/shutdown")
            .await
            .is_ok();
        if shutdown_accepted {
            if let Some(child) = core.child.as_mut() {
                wait_for_child_exit(child).await;
            }
        }
    }
}

async fn update_core_lease(
    discovery: &CoreDiscovery,
    lease_id: &str,
    action: &str,
) -> AppResult<usize> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/core/leases/{}/{}",
            discovery.base_url(),
            lease_id,
            action
        ))
        .bearer_auth(&discovery.token)
        .timeout(CORE_LEASE_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|error| AppError::Tcp(format!("Core lease {action} failed: {error}")))?;
    if !response.status().is_success() {
        return Err(AppError::Tcp(format!(
            "Core lease {action} returned HTTP {}",
            response.status()
        )));
    }
    let lease: CoreLeaseResponse = response.json().await.map_err(|error| {
        AppError::Serde(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            error.to_string(),
        )))
    })?;
    Ok(lease.active_leases)
}

async fn wait_for_child_exit(child: &mut Child) {
    for _ in 0..50 {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn ok(id: Option<Value>, result: Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_heartbeat_failure_retries_before_lease_expiry() {
        assert_eq!(
            heartbeat_failure_action(Duration::from_secs(5)),
            HeartbeatFailureAction::RetryAfter(CORE_LEASE_RETRY_INTERVAL)
        );
    }

    #[test]
    fn heartbeat_marks_lease_invalid_before_server_ttl() {
        assert!(CORE_LEASE_REQUEST_TIMEOUT < CORE_LEASE_VALIDITY_WINDOW);
        assert_eq!(
            heartbeat_failure_action(CORE_LEASE_VALIDITY_WINDOW),
            HeartbeatFailureAction::MarkInvalid
        );
        assert_eq!(
            heartbeat_failure_action(CORE_LEASE_VALIDITY_WINDOW - Duration::from_millis(250)),
            HeartbeatFailureAction::RetryAfter(Duration::from_millis(250))
        );
    }

    #[test]
    fn only_an_unhealthy_owned_core_is_stopped() {
        assert!(should_stop_owned_core(true, false));
        assert!(!should_stop_owned_core(false, false));
        assert!(!should_stop_owned_core(true, true));
    }

    #[tokio::test]
    async fn disabled_mcp_requests_do_not_create_a_managed_core() {
        let mut managed_core = None;
        let response = handle_request_with_access(
            JsonRpcRequest {
                id: Some(json!(1)),
                method: "tools/list".to_string(),
                params: None,
            },
            &mut managed_core,
            Some("MCP tools are disabled".to_string()),
        )
        .await;

        assert!(managed_core.is_none());
        assert_eq!(response.result.unwrap()["tools"], json!([]));

        let response = handle_request_with_access(
            JsonRpcRequest {
                id: Some(json!(2)),
                method: "tools/call".to_string(),
                params: Some(json!({ "name": "greet", "arguments": {} })),
            },
            &mut managed_core,
            Some("MCP tools are disabled".to_string()),
        )
        .await;

        assert!(managed_core.is_none());
        assert_eq!(response.result.unwrap()["isError"], json!(true));
    }
}
