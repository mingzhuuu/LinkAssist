use crate::error::AppError;
use crate::protocol::types::{
    DisplayFormat, FieldDefinition, FieldType, FieldValue, ParseResult, ParsedField,
};

pub struct FieldParser {
    fields: Vec<FieldDefinition>,
}

impl FieldParser {
    pub fn new(fields: Vec<FieldDefinition>) -> Self {
        Self { fields }
    }

    pub fn set_fields(&mut self, fields: Vec<FieldDefinition>) {
        self.fields = fields;
    }

    pub fn fields(&self) -> &[FieldDefinition] {
        &self.fields
    }

    pub fn parse(&self, data: &[u8]) -> Result<ParseResult, AppError> {
        let mut parsed_fields = Vec::with_capacity(self.fields.len());
        let mut last_end = 0;

        for field_def in &self.fields {
            let size = field_size(&field_def.field_type);
            let end = field_def
                .offset
                .checked_add(size)
                .ok_or_else(|| AppError::Protocol("field offset overflow".to_string()))?;

            if end > data.len() {
                return Err(AppError::Protocol(format!(
                    "field '{}' at offset {} with size {} exceeds data length {}",
                    field_def.name,
                    field_def.offset,
                    size,
                    data.len()
                )));
            }

            let raw_bytes = data[field_def.offset..end].to_vec();
            let value = decode_field(&field_def.field_type, &raw_bytes)?;
            let display = format_value(&value, &field_def.display_format, &raw_bytes);

            parsed_fields.push(ParsedField {
                id: field_def.id.clone(),
                alias: field_def.alias.clone(),
                name: field_def.name.clone(),
                raw_bytes,
                value,
                display,
            });

            if end > last_end {
                last_end = end;
            }
        }

        let remaining_bytes = if last_end < data.len() {
            data[last_end..].to_vec()
        } else {
            vec![]
        };

        Ok(ParseResult {
            fields: parsed_fields,
            remaining_bytes,
            data_groups: vec![],
        })
    }
}

pub fn field_size(field_type: &FieldType) -> usize {
    match field_type {
        FieldType::UInt8 | FieldType::Int8 | FieldType::Bool => 1,
        FieldType::UInt16LE | FieldType::UInt16BE | FieldType::Int16LE | FieldType::Int16BE => 2,
        FieldType::UInt32LE
        | FieldType::UInt32BE
        | FieldType::Int32LE
        | FieldType::Int32BE
        | FieldType::Float32LE
        | FieldType::Float32BE => 4,
        FieldType::Float64LE | FieldType::Float64BE => 8,
        FieldType::ByteArray(n) | FieldType::Utf8String(n) => *n,
    }
}

fn decode_field(field_type: &FieldType, raw: &[u8]) -> Result<FieldValue, AppError> {
    match field_type {
        FieldType::UInt8 => Ok(FieldValue::Integer(raw[0] as i64)),
        FieldType::Int8 => Ok(FieldValue::Integer(raw[0] as i8 as i64)),
        FieldType::Bool => Ok(FieldValue::Bool(raw[0] != 0)),
        FieldType::UInt16LE => Ok(FieldValue::Integer(
            u16::from_le_bytes([raw[0], raw[1]]) as i64
        )),
        FieldType::UInt16BE => Ok(FieldValue::Integer(
            u16::from_be_bytes([raw[0], raw[1]]) as i64
        )),
        FieldType::Int16LE => Ok(FieldValue::Integer(
            i16::from_le_bytes([raw[0], raw[1]]) as i64
        )),
        FieldType::Int16BE => Ok(FieldValue::Integer(
            i16::from_be_bytes([raw[0], raw[1]]) as i64
        )),
        FieldType::UInt32LE => {
            Ok(FieldValue::Integer(
                u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as i64,
            ))
        }
        FieldType::UInt32BE => {
            Ok(FieldValue::Integer(
                u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as i64,
            ))
        }
        FieldType::Int32LE => {
            Ok(FieldValue::Integer(
                i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as i64,
            ))
        }
        FieldType::Int32BE => {
            Ok(FieldValue::Integer(
                i32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as i64,
            ))
        }
        FieldType::Float32LE => {
            Ok(FieldValue::Float(
                f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64,
            ))
        }
        FieldType::Float32BE => {
            Ok(FieldValue::Float(
                f32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as f64,
            ))
        }
        FieldType::Float64LE => Ok(FieldValue::Float(f64::from_le_bytes([
            raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
        ]))),
        FieldType::Float64BE => Ok(FieldValue::Float(f64::from_be_bytes([
            raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
        ]))),
        FieldType::ByteArray(_) => Ok(FieldValue::Bytes(raw.to_vec())),
        FieldType::Utf8String(_) => {
            let trimmed = raw
                .iter()
                .position(|&b| b == 0)
                .map_or(raw, |pos| &raw[..pos]);
            let s = std::str::from_utf8(trimmed)
                .map_err(|e| AppError::Protocol(format!("invalid UTF-8 in string field: {}", e)))?;
            Ok(FieldValue::String(s.to_string()))
        }
    }
}

fn format_value(value: &FieldValue, format: &DisplayFormat, raw: &[u8]) -> String {
    match (value, format) {
        (_, DisplayFormat::Hex) => bytes_to_hex(raw),
        (_, DisplayFormat::Binary) => raw
            .iter()
            .map(|b| format!("{:08b}", b))
            .collect::<Vec<_>>()
            .join(" "),
        (FieldValue::Bytes(b), DisplayFormat::Ascii) => b
            .iter()
            .map(|&c| {
                if c.is_ascii_graphic() || c == b' ' {
                    c as char
                } else {
                    '.'
                }
            })
            .collect(),
        (FieldValue::String(s), _) => s.clone(),
        (FieldValue::Bytes(b), DisplayFormat::Auto) => bytes_to_hex(b),
        (FieldValue::Bytes(b), DisplayFormat::Decimal) => bytes_to_hex(b),
        (FieldValue::Integer(n), _) => n.to_string(),
        (FieldValue::Float(f), _) => format!("{:.6}", f),
        (FieldValue::Bool(b), _) => b.to_string(),
    }
}

pub fn bytes_to_hex(data: &[u8]) -> String {
    data.iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::types::{DisplayFormat, FieldDefinition, FieldType};

    fn make_field(name: &str, field_type: FieldType, offset: usize) -> FieldDefinition {
        FieldDefinition {
            id: None,
            alias: None,
            name: name.to_string(),
            field_type,
            offset,
            description: String::new(),
            display_format: DisplayFormat::Auto,
        }
    }

    #[test]
    fn test_parse_uint8() {
        let parser = FieldParser::new(vec![make_field("status", FieldType::UInt8, 0)]);
        let data = [0x42u8];
        let result = parser.parse(&data).unwrap();
        assert_eq!(result.fields.len(), 1);
        assert_eq!(result.fields[0].name, "status");
        if let FieldValue::Integer(v) = result.fields[0].value {
            assert_eq!(v, 0x42);
        } else {
            panic!("expected Integer");
        }
    }

    #[test]
    fn test_parse_multi_field() {
        let fields = vec![
            make_field("temperature", FieldType::Float32LE, 0),
            make_field("humidity", FieldType::Float32LE, 4),
            make_field("battery", FieldType::UInt8, 8),
        ];
        let parser = FieldParser::new(fields);

        let temp: f32 = 23.5;
        let hum: f32 = 60.0;
        let mut data = Vec::new();
        data.extend_from_slice(&temp.to_le_bytes());
        data.extend_from_slice(&hum.to_le_bytes());
        data.push(85u8);

        let result = parser.parse(&data).unwrap();
        assert_eq!(result.fields.len(), 3);

        if let FieldValue::Float(v) = result.fields[0].value {
            assert!((v - 23.5f64).abs() < 1e-4, "temperature mismatch: {}", v);
        } else {
            panic!("expected Float for temperature");
        }
        if let FieldValue::Float(v) = result.fields[1].value {
            assert!((v - 60.0f64).abs() < 1e-4, "humidity mismatch: {}", v);
        } else {
            panic!("expected Float for humidity");
        }
        if let FieldValue::Integer(v) = result.fields[2].value {
            assert_eq!(v, 85);
        } else {
            panic!("expected Integer for battery");
        }
    }

    #[test]
    fn test_parse_out_of_bounds() {
        let parser = FieldParser::new(vec![make_field("big_field", FieldType::UInt32LE, 0)]);
        let data = [0x01u8, 0x02u8];
        let result = parser.parse(&data);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("exceeds data length"), "error was: {}", err);
    }

    #[test]
    fn test_parse_string_field() {
        let fields = vec![make_field("label", FieldType::Utf8String(5), 0)];
        let parser = FieldParser::new(fields);
        let data = b"Hello";
        let result = parser.parse(data).unwrap();
        assert_eq!(result.fields.len(), 1);
        if let FieldValue::String(s) = &result.fields[0].value {
            assert_eq!(s, "Hello");
        } else {
            panic!("expected String");
        }
    }

    #[test]
    fn test_parse_string_null_terminated() {
        let fields = vec![make_field("label", FieldType::Utf8String(8), 0)];
        let parser = FieldParser::new(fields);
        let data = b"Hi\x00\x00\x00\x00\x00\x00";
        let result = parser.parse(data).unwrap();
        if let FieldValue::String(s) = &result.fields[0].value {
            assert_eq!(s, "Hi");
        } else {
            panic!("expected String");
        }
    }

    #[test]
    fn test_remaining_bytes() {
        let parser = FieldParser::new(vec![make_field("byte", FieldType::UInt8, 0)]);
        let data = [0x01u8, 0x02u8, 0x03u8];
        let result = parser.parse(&data).unwrap();
        assert_eq!(result.remaining_bytes, vec![0x02, 0x03]);
    }
}
