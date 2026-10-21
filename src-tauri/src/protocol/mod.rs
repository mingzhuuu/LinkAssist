pub mod lua_engine;
pub mod parser;
pub mod templates;
pub mod types;

pub use types::*;

use self::lua_engine::{
    encode_field_with_lua_protocol_file as encode_field_lua_protocol_file,
    encode_transaction_with_lua_protocol_file as encode_transaction_lua_protocol_file,
    match_transaction_response_with_lua_protocol_file as match_transaction_response_lua_protocol_file,
    parse_with_lua_protocol_file as parse_lua_protocol_file,
    summarize_lua_protocol_file as summarize_lua_protocol_file_impl,
};
pub use self::lua_engine::{
    LuaEncodeResult, LuaTransactionEncodeResult, LuaTransactionMatchResult,
};
use crate::error::AppError;
use crate::script_markers::{ensure_lua_script_file_kind, LuaScriptKind};
use std::path::PathBuf;

pub struct ProtocolManager {
    pub field_parser: parser::FieldParser,
    pub lua_engine: lua_engine::LuaEngine,
    pub current_mode: ParserMode,
    pub current_template: Option<String>,
}

impl ProtocolManager {
    pub fn new() -> Result<Self, AppError> {
        Ok(Self {
            field_parser: parser::FieldParser::new(vec![]),
            lua_engine: lua_engine::LuaEngine::new()?,
            current_mode: ParserMode::Passthrough,
            current_template: None,
        })
    }

    pub fn set_mode(&mut self, mode: ParserMode) {
        self.current_mode = mode;
    }

    pub fn set_field_definitions(&mut self, fields: Vec<FieldDefinition>) {
        self.field_parser.set_fields(fields);
    }

    pub fn get_field_definitions(&self) -> &[FieldDefinition] {
        self.field_parser.fields()
    }

    pub fn load_lua_script(&mut self, script: &str) -> Result<(), AppError> {
        self.lua_engine.load_script(script)
    }

    pub fn parse(&self, data: &[u8]) -> Result<ParseResult, AppError> {
        match self.current_mode {
            ParserMode::Passthrough => Ok(passthrough_parse(data)),
            ParserMode::FieldDefinition => self.field_parser.parse(data),
            ParserMode::LuaScript => self.lua_engine.execute(data),
        }
    }

    pub fn get_templates() -> Vec<ProtocolTemplate> {
        templates::get_builtin_templates()
    }

    pub fn apply_template(&mut self, template_id: &str) -> Result<(), AppError> {
        let all = templates::get_builtin_templates();
        let tmpl = all
            .into_iter()
            .find(|t| t.id == template_id)
            .ok_or_else(|| AppError::Protocol(format!("template '{}' not found", template_id)))?;
        self.field_parser.set_fields(tmpl.fields);
        self.current_template = Some(template_id.to_string());
        self.current_mode = ParserMode::FieldDefinition;
        Ok(())
    }

    pub fn get_lua_protocol_file_summary(
        path: PathBuf,
        resource_root: Option<PathBuf>,
    ) -> Result<ProtocolFileSummary, AppError> {
        ensure_lua_script_file_kind(&path, LuaScriptKind::Protocol)?;
        summarize_lua_protocol_file_impl(path, resource_root)
    }

    pub fn parse_data_with_lua_file(
        path: PathBuf,
        resource_root: Option<PathBuf>,
        data: &[u8],
    ) -> Result<ParseResult, AppError> {
        ensure_lua_script_file_kind(&path, LuaScriptKind::Protocol)?;
        parse_lua_protocol_file(path, resource_root, data)
    }

    pub fn encode_field_with_lua_file(
        path: PathBuf,
        resource_root: Option<PathBuf>,
        field_id: &str,
        value: &str,
    ) -> Result<LuaEncodeResult, AppError> {
        ensure_lua_script_file_kind(&path, LuaScriptKind::Protocol)?;
        encode_field_lua_protocol_file(path, resource_root, field_id, value)
    }

    pub fn encode_transaction_with_lua_file(
        path: PathBuf,
        resource_root: Option<PathBuf>,
        transaction_id: &str,
        values_json: &str,
    ) -> Result<LuaTransactionEncodeResult, AppError> {
        ensure_lua_script_file_kind(&path, LuaScriptKind::Protocol)?;
        encode_transaction_lua_protocol_file(path, resource_root, transaction_id, values_json)
    }

    pub fn match_transaction_response_with_lua_file(
        path: PathBuf,
        resource_root: Option<PathBuf>,
        transaction_id: &str,
        data: &[u8],
    ) -> Result<LuaTransactionMatchResult, AppError> {
        ensure_lua_script_file_kind(&path, LuaScriptKind::Protocol)?;
        match_transaction_response_lua_protocol_file(path, resource_root, transaction_id, data)
    }
}

fn passthrough_parse(data: &[u8]) -> ParseResult {
    let hex_display = parser::bytes_to_hex(data);
    ParseResult {
        fields: vec![ParsedField {
            id: Some("raw_data".to_string()),
            alias: Some("Raw Data".to_string()),
            name: "Raw Data".to_string(),
            raw_bytes: data.to_vec(),
            value: FieldValue::Bytes(data.to_vec()),
            display: hex_display,
        }],
        remaining_bytes: vec![],
        data_groups: vec![],
    }
}
