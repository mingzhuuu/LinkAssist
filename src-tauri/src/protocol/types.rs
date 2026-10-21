use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FieldType {
    UInt8,
    UInt16LE,
    UInt16BE,
    UInt32LE,
    UInt32BE,
    Int8,
    Int16LE,
    Int16BE,
    Int32LE,
    Int32BE,
    Float32LE,
    Float32BE,
    Float64LE,
    Float64BE,
    Bool,
    ByteArray(usize),  // fixed-length byte array
    Utf8String(usize), // fixed-length UTF-8 string
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldDefinition {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    pub name: String,
    pub field_type: FieldType,
    pub offset: usize,
    pub description: String,
    pub display_format: DisplayFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DisplayFormat {
    Decimal,
    Hex,
    Binary,
    Ascii,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedField {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    pub name: String,
    pub raw_bytes: Vec<u8>,
    pub value: FieldValue,
    pub display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFieldSummary {
    pub id: String,
    pub name: String,
    pub field_type: String,
    pub description: String,
    pub display_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolFileSummary {
    pub file_path: String,
    pub name: String,
    pub fields: Vec<ProtocolFieldSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    Integer(i64),
    Float(f64),
    Bool(bool),
    String(String),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    pub fields: Vec<ParsedField>,
    pub remaining_bytes: Vec<u8>,
    pub data_groups: Vec<DataGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataGroup {
    pub name: String,
    pub fields: Vec<ParsedField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub fields: Vec<FieldDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ParserMode {
    Passthrough,
    FieldDefinition,
    LuaScript,
}
