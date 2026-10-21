use crate::error::{is_closed_object_error_message, AppError, AppResult};
use btleplug::api::Peripheral as _;
use btleplug::platform::Peripheral;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct BleConnectionManager {
    connections: Arc<RwLock<HashMap<String, Peripheral>>>,
}

impl BleConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn connect(&self, peripheral: Peripheral) -> AppResult<()> {
        let id = peripheral.id().to_string();

        if let Some(existing) = self.take_connection(&id).await {
            let _ = self.disconnect_peripheral(existing).await;
        }

        peripheral
            .connect()
            .await
            .map_err(|e| AppError::BtleError(e.to_string()))?;
        let mut connections = self.connections.write().await;
        connections.insert(id, peripheral);
        Ok(())
    }

    pub async fn disconnect(&self, device_id: &str) -> AppResult<()> {
        let Some(peripheral) = self.take_connection(device_id).await else {
            return Ok(());
        };

        self.disconnect_peripheral(peripheral).await?;
        Ok(())
    }

    pub async fn get_peripheral(&self, device_id: &str) -> AppResult<Peripheral> {
        let connections = self.connections.read().await;
        connections
            .get(device_id)
            .cloned()
            .ok_or_else(|| AppError::Ble(format!("Device not connected: {}", device_id)))
    }

    pub async fn is_connected(&self, device_id: &str) -> bool {
        let connections = self.connections.read().await;
        if let Some(peripheral) = connections.get(device_id) {
            peripheral.is_connected().await.unwrap_or(false)
        } else {
            false
        }
    }

    pub async fn list_connected(&self) -> Vec<String> {
        let connections = self.connections.read().await;
        connections.keys().cloned().collect()
    }

    async fn take_connection(&self, device_id: &str) -> Option<Peripheral> {
        let mut connections = self.connections.write().await;
        connections.remove(device_id)
    }

    async fn disconnect_peripheral(&self, peripheral: Peripheral) -> AppResult<()> {
        match peripheral.disconnect().await {
            Ok(()) => Ok(()),
            Err(error) => {
                let message = error.to_string();
                if is_closed_object_error_message(&message) {
                    Ok(())
                } else {
                    Err(AppError::BtleError(message))
                }
            }
        }
    }
}

impl Default for BleConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}
