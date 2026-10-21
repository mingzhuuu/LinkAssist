use crate::recent_events::current_timestamp_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

pub const CHANNEL_ACTIVITY_EVENT: &str = "channel-activity";

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInvocationContext {
    pub source: Option<String>,
    pub run_id: Option<String>,
    pub case_id: Option<String>,
}

impl ToolInvocationContext {
    fn source_label(&self) -> String {
        match self.source.as_deref().map(str::trim) {
            Some("test") => "test".to_string(),
            Some("script") => "script".to_string(),
            Some("ui") => "ui".to_string(),
            _ => "mcp".to_string(),
        }
    }

    fn bounded(value: &Option<String>) -> Option<String> {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(256).collect())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelActivityEvent {
    pub activity_id: String,
    pub timestamp: u64,
    pub kind: &'static str,
    pub source: String,
    pub transport: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
}

impl ChannelActivityEvent {
    pub fn new(
        context: Option<&ToolInvocationContext>,
        kind: &'static str,
        transport: &'static str,
    ) -> Self {
        let context = context.cloned().unwrap_or_default();
        Self {
            activity_id: uuid::Uuid::new_v4().to_string(),
            timestamp: current_timestamp_ms(),
            kind,
            source: context.source_label(),
            transport,
            channel_id: None,
            connection_id: None,
            endpoint: None,
            data: None,
            text: None,
            protocol: None,
            run_id: ToolInvocationContext::bounded(&context.run_id),
            case_id: ToolInvocationContext::bounded(&context.case_id),
        }
    }

    pub fn endpoint(mut self, endpoint: Value) -> Self {
        self.endpoint = Some(endpoint);
        self
    }

    pub fn channel(mut self, channel_id: impl Into<String>) -> Self {
        self.channel_id = Some(channel_id.into());
        self
    }

    pub fn connection(mut self, connection_id: impl Into<String>) -> Self {
        self.connection_id = Some(connection_id.into());
        self
    }

    pub fn data(mut self, data: &[u8]) -> Self {
        self.data = Some(data.to_vec());
        self
    }

    pub fn text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn protocol(mut self, protocol: Value) -> Self {
        self.protocol = Some(protocol);
        self
    }
}

pub fn emit_channel_activity(app_handle: &AppHandle, event: ChannelActivityEvent) {
    if let Err(error) = app_handle.emit(CHANNEL_ACTIVITY_EVENT, event) {
        eprintln!("failed to emit {CHANNEL_ACTIVITY_EVENT}: {error}");
    }
}

fn tool_transport(tool_name: &str) -> Option<&'static str> {
    if tool_name == "protocol_execute_transaction_with_lua_file" || tool_name.starts_with("ble_") {
        Some("ble")
    } else if tool_name.starts_with("serial_") {
        Some("serial")
    } else if tool_name.starts_with("tcp_server_") {
        Some("tcp-server")
    } else if tool_name.starts_with("tcp_") {
        Some("tcp-client")
    } else if tool_name.starts_with("udp_") {
        Some("udp")
    } else {
        None
    }
}

pub fn capture_tool_error_arguments(tool_name: &str, arguments: &Value) -> Option<Value> {
    tool_transport(tool_name)?;
    let mut captured = serde_json::Map::new();
    for key in [
        "deviceId",
        "serviceUuid",
        "charUuid",
        "addr",
        "channelId",
        "connectionId",
        "transactionId",
    ] {
        if let Some(value) = arguments.get(key).and_then(Value::as_str) {
            captured.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(path) = arguments
        .get("config")
        .and_then(|config| config.get("path"))
        .and_then(Value::as_str)
    {
        captured.insert("config".to_string(), serde_json::json!({ "path": path }));
    }
    Some(Value::Object(captured))
}

pub fn emit_tool_error(
    app_handle: &AppHandle,
    context: Option<&ToolInvocationContext>,
    tool_name: &str,
    arguments: &Value,
    error: &str,
) {
    let Some(transport) = tool_transport(tool_name) else {
        return;
    };

    let mut endpoint = serde_json::Map::new();
    for key in ["deviceId", "serviceUuid", "charUuid"] {
        if let Some(value) = arguments.get(key).and_then(Value::as_str) {
            endpoint.insert(key.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(path) = arguments
        .get("config")
        .and_then(|config| config.get("path"))
        .and_then(Value::as_str)
    {
        endpoint.insert("serialPath".to_string(), Value::String(path.to_string()));
    }
    if let Some(address) = arguments.get("addr").and_then(Value::as_str) {
        endpoint.insert("address".to_string(), Value::String(address.to_string()));
    }

    let mut event = ChannelActivityEvent::new(context, "error", transport)
        .text(format!("{tool_name}: {error}"));
    if !endpoint.is_empty() {
        event = event.endpoint(Value::Object(endpoint));
    }
    if let Some(channel_id) = arguments.get("channelId").and_then(Value::as_str) {
        event = event.channel(channel_id);
    }
    if let Some(connection_id) = arguments.get("connectionId").and_then(Value::as_str) {
        event = event.connection(connection_id);
    }
    if let Some(transaction_id) = arguments.get("transactionId").and_then(Value::as_str) {
        event = event.protocol(serde_json::json!({
            "transactionId": transaction_id,
            "status": "failed",
            "error": error,
        }));
    }
    emit_channel_activity(app_handle, event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invocation_context_is_bounded_and_unknown_sources_are_neutral() {
        let context = ToolInvocationContext {
            source: Some("untrusted".to_string()),
            run_id: Some(" r1 ".to_string()),
            case_id: Some("x".repeat(300)),
        };
        let value = serde_json::to_value(ChannelActivityEvent::new(
            Some(&context),
            "connected",
            "ble",
        ))
        .unwrap();
        assert_eq!(value["source"], "mcp");
        assert_eq!(value["runId"], "r1");
        assert_eq!(value["caseId"].as_str().unwrap().chars().count(), 256);
    }

    #[test]
    fn error_capture_keeps_only_small_transport_identity_fields() {
        let captured = capture_tool_error_arguments(
            "ble_write_characteristic",
            &serde_json::json!({
                "deviceId": "device-1",
                "serviceUuid": "service",
                "charUuid": "char",
                "data": vec![0_u8; 4096],
            }),
        )
        .unwrap();
        assert_eq!(captured["deviceId"], "device-1");
        assert!(captured.get("data").is_none());
        assert!(capture_tool_error_arguments("export_to_file", &serde_json::json!({})).is_none());
    }
}
