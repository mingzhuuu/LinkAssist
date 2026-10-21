use crate::{AppError, AppResult};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LuaScriptKind {
    McpTool,
    Protocol,
    Script,
    ScriptHelper,
    CanvasLifecycle,
}

impl LuaScriptKind {
    fn marker_value(self) -> &'static str {
        match self {
            Self::McpTool => "mcp",
            Self::Protocol => "protocol",
            Self::Script => "script",
            Self::ScriptHelper => "script-helper",
            Self::CanvasLifecycle => "canvas-lifecycle",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::McpTool => "MCP tool",
            Self::Protocol => "protocol",
            Self::Script => "automation script",
            Self::ScriptHelper => "script helper",
            Self::CanvasLifecycle => "canvas lifecycle",
        }
    }

    fn expected_marker(self) -> String {
        format!("-- linkassist:type = {}", self.marker_value())
    }
}

pub fn ensure_lua_script_kind(content: &str, expected: LuaScriptKind) -> AppResult<()> {
    let Some(found) = extract_lua_script_kind(content) else {
        return Err(AppError::Protocol(format!(
            "Lua {} file is missing required marker '{}'",
            expected.display_name(),
            expected.expected_marker()
        )));
    };

    if found == expected.marker_value() {
        return Ok(());
    }

    Err(AppError::Protocol(format!(
        "Expected Lua {} file marker '{}', but found '-- linkassist:type = {}'",
        expected.display_name(),
        expected.expected_marker(),
        found
    )))
}

pub fn ensure_lua_script_file_kind(path: &Path, expected: LuaScriptKind) -> AppResult<()> {
    let content = std::fs::read_to_string(path)?;
    ensure_lua_script_kind(&content, expected)
}

fn extract_lua_script_kind(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("--") else {
            continue;
        };

        let rest = rest.trim();
        let Some(rest) = rest.strip_prefix("linkassist:type") else {
            continue;
        };

        let rest = rest.trim_start();
        let rest = rest.strip_prefix('=').map(str::trim_start).unwrap_or(rest);
        let value = rest
            .split_whitespace()
            .next()
            .map(|part| part.trim().to_ascii_lowercase())
            .filter(|part| !part.is_empty());

        if value.is_some() {
            return value;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_expected_lua_script_marker() {
        let content = "-- linkassist:type = mcp\nfunction mcp_meta() end";
        assert!(ensure_lua_script_kind(content, LuaScriptKind::McpTool).is_ok());
    }

    #[test]
    fn rejects_missing_lua_script_marker() {
        let error = ensure_lua_script_kind("function schema() end", LuaScriptKind::Protocol)
            .expect_err("missing marker should fail")
            .to_string();

        assert!(error.contains("missing required marker"));
        assert!(error.contains("-- linkassist:type = protocol"));
    }

    #[test]
    fn rejects_wrong_lua_script_marker() {
        let error = ensure_lua_script_kind("-- linkassist:type = script", LuaScriptKind::McpTool)
            .expect_err("wrong marker should fail")
            .to_string();

        assert!(error.contains("Expected Lua MCP tool file marker"));
        assert!(error.contains("-- linkassist:type = script"));
    }

    #[test]
    fn detects_canvas_lifecycle_marker() {
        let content = "-- linkassist:type = canvas-lifecycle\nreturn { onActivate = {} }";
        assert!(ensure_lua_script_kind(content, LuaScriptKind::CanvasLifecycle).is_ok());
    }

    #[test]
    fn detects_script_helper_marker() {
        let content = "-- linkassist:type = script-helper\nfunction helpers() return {} end";
        assert!(ensure_lua_script_kind(content, LuaScriptKind::ScriptHelper).is_ok());
    }
}
