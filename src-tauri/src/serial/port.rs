use serde::{Deserialize, Serialize};
use serialport::{SerialPortInfo, SerialPortType};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub path: String,
    pub port_type: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

// Configs arrive from untrusted sources (persisted files from older app
// versions, imported layouts, MCP/AI tool calls), so every field except the
// port path deserializes leniently: missing/null falls back to the default
// and numeric strings like "8" are coerced. Semantic validation (e.g. data
// bits must be 5-8) stays in build_serial_stream where it produces a clear
// error instead of a serde type mismatch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub path: String,
    #[serde(default = "default_baud_rate", deserialize_with = "flexible_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits", deserialize_with = "flexible_data_bits")]
    pub data_bits: u8,        // 5,6,7,8
    #[serde(default = "default_stop_bits", deserialize_with = "flexible_stop_bits")]
    pub stop_bits: u8,        // 1,2
    #[serde(default = "default_parity", deserialize_with = "flexible_parity")]
    pub parity: String,       // "none","odd","even"
    #[serde(default = "default_flow_control", deserialize_with = "flexible_flow_control")]
    pub flow_control: String, // "none","rts_cts","dtr_dsr","xon_xoff" (+legacy "hardware","software")
    #[serde(default = "default_receive_timeout_ms", deserialize_with = "flexible_receive_timeout_ms")]
    pub receive_timeout_ms: u64,
}

fn default_baud_rate() -> u32 {
    115_200
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

fn default_parity() -> String {
    "none".to_string()
}

fn default_flow_control() -> String {
    "none".to_string()
}

fn default_receive_timeout_ms() -> u64 {
    50
}

/// Accept a JSON number, a numeric string, or null (→ default).
fn flexible_number<'de, D>(deserializer: D, default: u64) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Flexible {
        Number(f64),
        Text(String),
        Null(()),
    }

    let value = match Flexible::deserialize(deserializer)? {
        Flexible::Number(number) => number,
        Flexible::Text(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(default);
            }
            trimmed
                .parse::<f64>()
                .map_err(|_| serde::de::Error::custom(format!("invalid number: {text:?}")))?
        }
        Flexible::Null(_) => return Ok(default),
    };

    if !value.is_finite() || value.fract() != 0.0 || !(0.0..=u64::MAX as f64).contains(&value) {
        return Err(serde::de::Error::custom(format!("invalid number: {value}")));
    }
    Ok(value as u64)
}

fn flexible_baud_rate<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = flexible_number(deserializer, u64::from(default_baud_rate()))?;
    u32::try_from(value).map_err(|_| serde::de::Error::custom(format!("baud rate out of range: {value}")))
}

fn flexible_data_bits<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = flexible_number(deserializer, u64::from(default_data_bits()))?;
    u8::try_from(value).map_err(|_| serde::de::Error::custom(format!("data bits out of range: {value}")))
}

fn flexible_stop_bits<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = flexible_number(deserializer, u64::from(default_stop_bits()))?;
    u8::try_from(value).map_err(|_| serde::de::Error::custom(format!("stop bits out of range: {value}")))
}

fn flexible_receive_timeout_ms<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    flexible_number(deserializer, default_receive_timeout_ms())
}

/// Accept a string (normalized to trimmed lowercase) or null/empty (→ default).
fn flexible_lower_string<'de, D>(deserializer: D, default: fn() -> String) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?
        .map(|text| text.trim().to_lowercase())
        .filter(|text| !text.is_empty());
    Ok(value.unwrap_or_else(default))
}

fn flexible_parity<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    flexible_lower_string(deserializer, default_parity)
}

fn flexible_flow_control<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    flexible_lower_string(deserializer, default_flow_control)
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            path: String::new(),
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".to_string(),
            flow_control: "none".to_string(),
            receive_timeout_ms: default_receive_timeout_ms(),
        }
    }
}

fn port_type_str(port_type: &SerialPortType) -> String {
    match port_type {
        SerialPortType::UsbPort(_) => "USB".to_string(),
        SerialPortType::PciPort => "PCI".to_string(),
        SerialPortType::BluetoothPort => "Bluetooth".to_string(),
        SerialPortType::Unknown => "Unknown".to_string(),
    }
}

fn extract_usb_info(
    port_type: &SerialPortType,
) -> (Option<String>, Option<String>, Option<u16>, Option<u16>) {
    if let SerialPortType::UsbPort(info) = port_type {
        (
            info.manufacturer.clone(),
            info.product.clone(),
            Some(info.vid),
            Some(info.pid),
        )
    } else {
        (None, None, None, None)
    }
}

pub fn list_ports() -> Vec<PortInfo> {
    match serialport::available_ports() {
        Ok(ports) => ports
            .iter()
            .map(|p: &SerialPortInfo| {
                let (manufacturer, product, vid, pid) = extract_usb_info(&p.port_type);
                PortInfo {
                    path: p.port_name.clone(),
                    port_type: port_type_str(&p.port_type),
                    manufacturer,
                    product,
                    vid,
                    pid,
                }
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::SerialConfig;

    fn parse(json: &str) -> Result<SerialConfig, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn full_valid_config_deserializes() {
        let config = parse(
            r#"{"path":"COM4","baudRate":9600,"dataBits":8,"stopBits":1,"parity":"none","flowControl":"none","receiveTimeoutMs":50}"#,
        )
        .unwrap();
        assert_eq!(config.baud_rate, 9600);
        assert_eq!(config.data_bits, 8);
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let config = parse(r#"{"path":"COM4"}"#).unwrap();
        assert_eq!(config.baud_rate, 115_200);
        assert_eq!(config.data_bits, 8);
        assert_eq!(config.stop_bits, 1);
        assert_eq!(config.parity, "none");
        assert_eq!(config.flow_control, "none");
        assert_eq!(config.receive_timeout_ms, 50);
    }

    #[test]
    fn numeric_strings_and_floats_are_coerced() {
        let config = parse(r#"{"path":"COM4","baudRate":"115200","dataBits":"8","stopBits":2.0}"#).unwrap();
        assert_eq!(config.baud_rate, 115_200);
        assert_eq!(config.data_bits, 8);
        assert_eq!(config.stop_bits, 2);
    }

    #[test]
    fn null_and_empty_values_fall_back_to_defaults() {
        let config = parse(r#"{"path":"COM4","dataBits":null,"parity":null,"flowControl":""}"#).unwrap();
        assert_eq!(config.data_bits, 8);
        assert_eq!(config.parity, "none");
        assert_eq!(config.flow_control, "none");
    }

    #[test]
    fn parity_and_flow_control_are_case_normalized() {
        let config = parse(r#"{"path":"COM4","parity":"Odd","flowControl":"RTS_CTS"}"#).unwrap();
        assert_eq!(config.parity, "odd");
        assert_eq!(config.flow_control, "rts_cts");
    }

    #[test]
    fn garbage_values_still_error() {
        assert!(parse(r#"{"path":"COM4","dataBits":"eight"}"#).is_err());
        assert!(parse(r#"{"path":"COM4","dataBits":300}"#).is_err());
        assert!(parse(r#"{"baudRate":9600}"#).is_err());
    }
}
