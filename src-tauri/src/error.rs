use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("BLE error: {0}")]
    Ble(String),
    #[error("BLE adapter error: {0}")]
    BtleError(String),
    #[error("Serial error: {0}")]
    Serial(String),
    #[error("TCP error: {0}")]
    Tcp(String),
    #[error("Protocol error: {0}")]
    Protocol(String),
    #[error("Test runner error: {0}")]
    TestRunner(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

impl From<btleplug::Error> for AppError {
    fn from(e: btleplug::Error) -> Self {
        AppError::BtleError(e.to_string())
    }
}

impl From<mlua::Error> for AppError {
    fn from(e: mlua::Error) -> Self {
        AppError::Protocol(e.to_string())
    }
}

// Make AppError compatible with Tauri command returns
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn is_closed_object_error_message(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("0x80000013")
        || normalized.contains("object has been closed")
        || message.contains("该对象已关闭")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display() {
        let e = AppError::Ble("adapter not found".into());
        assert_eq!(e.to_string(), "BLE error: adapter not found");
    }

    #[test]
    fn error_serialization() {
        let e = AppError::Serial("port busy".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, "\"Serial error: port busy\"");
    }

    #[test]
    fn io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let app_err: AppError = io_err.into();
        assert!(app_err.to_string().contains("file not found"));
    }

    #[test]
    fn closed_object_error_detection_matches_windows_messages() {
        assert!(is_closed_object_error_message(
            "Error { code: HRESULT(0x80000013), message: \"该对象已关闭。\" }"
        ));
        assert!(is_closed_object_error_message("The object has been closed"));
        assert!(!is_closed_object_error_message("adapter not found"));
    }
}
