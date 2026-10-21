use crate::protocol::types::{DisplayFormat, FieldDefinition, FieldType, ProtocolTemplate};

pub fn get_builtin_templates() -> Vec<ProtocolTemplate> {
    vec![
        simple_sensor_template(),
        ble_gatt_notify_template(),
        modbus_rtu_template(),
    ]
}

fn simple_sensor_template() -> ProtocolTemplate {
    ProtocolTemplate {
        id: "simple_sensor".to_string(),
        name: "Simple Sensor".to_string(),
        description: "Temperature (f32 LE) + Humidity (f32 LE) + Battery (u8)".to_string(),
        fields: vec![
            FieldDefinition {
                id: None,
                alias: None,
                name: "temperature".to_string(),
                field_type: FieldType::Float32LE,
                offset: 0,
                description: "Temperature in Celsius".to_string(),
                display_format: DisplayFormat::Decimal,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "humidity".to_string(),
                field_type: FieldType::Float32LE,
                offset: 4,
                description: "Relative humidity percentage".to_string(),
                display_format: DisplayFormat::Decimal,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "battery".to_string(),
                field_type: FieldType::UInt8,
                offset: 8,
                description: "Battery level 0-100".to_string(),
                display_format: DisplayFormat::Decimal,
            },
        ],
    }
}

fn ble_gatt_notify_template() -> ProtocolTemplate {
    ProtocolTemplate {
        id: "ble_gatt_notify".to_string(),
        name: "BLE GATT Notify".to_string(),
        description: "Handle (u16 LE) + Length (u8) + Payload (16 bytes)".to_string(),
        fields: vec![
            FieldDefinition {
                id: None,
                alias: None,
                name: "handle".to_string(),
                field_type: FieldType::UInt16LE,
                offset: 0,
                description: "GATT attribute handle".to_string(),
                display_format: DisplayFormat::Hex,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "length".to_string(),
                field_type: FieldType::UInt8,
                offset: 2,
                description: "Payload length in bytes".to_string(),
                display_format: DisplayFormat::Decimal,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "payload".to_string(),
                field_type: FieldType::ByteArray(16),
                offset: 3,
                description: "Notification payload data".to_string(),
                display_format: DisplayFormat::Hex,
            },
        ],
    }
}

fn modbus_rtu_template() -> ProtocolTemplate {
    ProtocolTemplate {
        id: "modbus_rtu".to_string(),
        name: "Modbus RTU".to_string(),
        description: "Device Addr (u8) + Function Code (u8) + Data Length (u8) + Data (8 bytes) + CRC (u16 LE)".to_string(),
        fields: vec![
            FieldDefinition {
                id: None,
                alias: None,
                name: "device_addr".to_string(),
                field_type: FieldType::UInt8,
                offset: 0,
                description: "Modbus device address (1-247)".to_string(),
                display_format: DisplayFormat::Decimal,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "function_code".to_string(),
                field_type: FieldType::UInt8,
                offset: 1,
                description: "Modbus function code".to_string(),
                display_format: DisplayFormat::Hex,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "data_length".to_string(),
                field_type: FieldType::UInt8,
                offset: 2,
                description: "Number of data bytes following".to_string(),
                display_format: DisplayFormat::Decimal,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "data".to_string(),
                field_type: FieldType::ByteArray(8),
                offset: 3,
                description: "PDU data bytes".to_string(),
                display_format: DisplayFormat::Hex,
            },
            FieldDefinition {
                id: None,
                alias: None,
                name: "crc".to_string(),
                field_type: FieldType::UInt16LE,
                offset: 11,
                description: "CRC-16 checksum".to_string(),
                display_format: DisplayFormat::Hex,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::types::FieldType;

    #[test]
    fn test_builtin_templates_count() {
        let templates = get_builtin_templates();
        assert_eq!(templates.len(), 3);
    }

    #[test]
    fn test_template_sensor() {
        let templates = get_builtin_templates();
        let sensor = templates.iter().find(|t| t.id == "simple_sensor").unwrap();
        assert_eq!(sensor.name, "Simple Sensor");
        assert_eq!(sensor.fields.len(), 3);
        assert_eq!(sensor.fields[0].name, "temperature");
        assert!(matches!(sensor.fields[0].field_type, FieldType::Float32LE));
        assert_eq!(sensor.fields[1].name, "humidity");
        assert!(matches!(sensor.fields[1].field_type, FieldType::Float32LE));
        assert_eq!(sensor.fields[2].name, "battery");
        assert!(matches!(sensor.fields[2].field_type, FieldType::UInt8));
    }

    #[test]
    fn test_template_ble_gatt_notify() {
        let templates = get_builtin_templates();
        let tmpl = templates
            .iter()
            .find(|t| t.id == "ble_gatt_notify")
            .unwrap();
        assert_eq!(tmpl.fields.len(), 3);
        assert!(matches!(tmpl.fields[0].field_type, FieldType::UInt16LE));
        assert!(matches!(tmpl.fields[1].field_type, FieldType::UInt8));
        assert!(matches!(
            tmpl.fields[2].field_type,
            FieldType::ByteArray(16)
        ));
    }

    #[test]
    fn test_template_modbus_rtu() {
        let templates = get_builtin_templates();
        let tmpl = templates.iter().find(|t| t.id == "modbus_rtu").unwrap();
        assert_eq!(tmpl.fields.len(), 5);
        assert_eq!(tmpl.fields[4].name, "crc");
        assert!(matches!(tmpl.fields[4].field_type, FieldType::UInt16LE));
    }

    #[test]
    fn test_template_ids_unique() {
        let templates = get_builtin_templates();
        let ids: std::collections::HashSet<_> = templates.iter().map(|t| &t.id).collect();
        assert_eq!(ids.len(), templates.len(), "template IDs must be unique");
    }
}
