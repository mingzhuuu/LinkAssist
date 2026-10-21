use crate::error::{is_closed_object_error_message, AppError, AppResult};
use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager, Peripheral};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleDevice {
    pub id: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
    pub service_uuids: Vec<String>,
    pub is_connected: bool,
    pub manufacturer_data: std::collections::HashMap<u16, Vec<u8>>,
    pub is_connectable: bool,
    pub service_data: std::collections::HashMap<String, Vec<u8>>,
    pub tx_power_level: Option<i16>,
    pub address_type: Option<String>,
    pub class: Option<u32>,
    pub appearance: Option<u16>,
    pub advertisement_name: Option<String>,
}

pub struct BleScanner {
    adapter: Option<Adapter>,
    discovered_devices: Arc<RwLock<Vec<BleDevice>>>,
    scanning: Arc<RwLock<bool>>,
    /// In-flight internal rediscovery scans (connect flow). The OS watcher is
    /// shared between the user scan and rescans; it may only be stopped once
    /// neither needs it.
    rescan_count: u32,
}

impl BleScanner {
    pub fn new() -> Self {
        Self {
            adapter: None,
            discovered_devices: Arc::new(RwLock::new(Vec::new())),
            scanning: Arc::new(RwLock::new(false)),
            rescan_count: 0,
        }
    }

    async fn ensure_adapter(&mut self) -> AppResult<&Adapter> {
        if self.adapter.is_none() {
            self.adapter = Some(Self::create_adapter().await?);
        }
        Ok(self.adapter.as_ref().unwrap())
    }

    async fn create_adapter() -> AppResult<Adapter> {
        let manager = Manager::new()
            .await
            .map_err(|e| AppError::BtleError(e.to_string()))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| AppError::BtleError(e.to_string()))?;
        adapters
            .into_iter()
            .next()
            .ok_or_else(|| AppError::Ble("No BLE adapter found".to_string()))
    }

    async fn refresh_adapter(&mut self) -> AppResult<&Adapter> {
        self.adapter = Some(Self::create_adapter().await?);
        Ok(self.adapter.as_ref().unwrap())
    }

    /// Recreate the adapter after a closed-object error and, when a scan is
    /// supposed to be running, restart it on the new adapter. A recovered
    /// adapter starts with an empty peripheral map and a stopped watcher, so
    /// skipping the restart would leave the device list empty until the user
    /// manually restarts the scan.
    async fn refresh_adapter_preserving_scan(&mut self) -> AppResult<&Adapter> {
        self.refresh_adapter().await?;
        let scan_active = *self.scanning.read().await || self.rescan_count > 0;
        let adapter = self.adapter.as_ref().unwrap();
        if scan_active {
            adapter
                .start_scan(ScanFilter::default())
                .await
                .map_err(|e| AppError::BtleError(e.to_string()))?;
        }
        Ok(adapter)
    }

    async fn recover_adapter_if_closed(&mut self, message: &str) -> bool {
        if is_closed_object_error_message(message) {
            self.adapter = None;
            true
        } else {
            false
        }
    }

    pub async fn start_scan(&mut self) -> AppResult<()> {
        self.ensure_adapter().await?;
        let start_result = self
            .adapter
            .as_ref()
            .unwrap()
            .start_scan(ScanFilter::default())
            .await;

        if let Err(error) = start_result {
            let message = error.to_string();
            if self.recover_adapter_if_closed(&message).await {
                self.refresh_adapter()
                    .await?
                    .start_scan(ScanFilter::default())
                    .await
                    .map_err(|e| AppError::BtleError(e.to_string()))?;
            } else {
                return Err(AppError::BtleError(message));
            }
        }

        let mut scanning = self.scanning.write().await;
        *scanning = true;
        Ok(())
    }

    pub async fn stop_scan(&mut self) -> AppResult<()> {
        *self.scanning.write().await = false;
        // Internal rediscovery scans share the watcher; the last rescan_stop
        // shuts it down.
        if self.rescan_count > 0 {
            return Ok(());
        }
        if let Some(adapter) = &self.adapter {
            if let Err(error) = adapter.stop_scan().await {
                let message = error.to_string();
                if !self.recover_adapter_if_closed(&message).await {
                    return Err(AppError::BtleError(message));
                }
            }
        }
        Ok(())
    }

    pub async fn get_devices(&self) -> AppResult<Vec<BleDevice>> {
        let devices = self.discovered_devices.read().await;
        Ok(devices.clone())
    }

    pub async fn is_scanning(&self) -> bool {
        *self.scanning.read().await || self.rescan_count > 0
    }

    /// Refresh and return the current list of discovered peripherals from the adapter.
    pub async fn refresh_devices(&mut self) -> AppResult<Vec<BleDevice>> {
        self.ensure_adapter().await?;
        let peripherals = match self.adapter.as_ref().unwrap().peripherals().await {
            Ok(peripherals) => peripherals,
            Err(error) => {
                let message = error.to_string();
                if self.recover_adapter_if_closed(&message).await {
                    self.refresh_adapter_preserving_scan()
                        .await?
                        .peripherals()
                        .await
                        .map_err(|e| AppError::BtleError(e.to_string()))?
                } else {
                    return Err(AppError::BtleError(message));
                }
            }
        };

        let mut devices = Vec::new();
        for peripheral in peripherals {
            if let Ok(device) = peripheral_to_ble_device(&peripheral).await {
                devices.push(device);
            }
        }

        let mut discovered = self.discovered_devices.write().await;
        *discovered = devices.clone();
        Ok(devices)
    }

    pub async fn get_adapter(&mut self) -> AppResult<&Adapter> {
        self.ensure_adapter().await
    }

    /// Look up a device among the adapter's already-known peripherals without
    /// scanning. Recovers a closed adapter once before failing.
    pub async fn known_peripheral(&mut self, device_id: &str) -> AppResult<Option<Peripheral>> {
        self.ensure_adapter().await?;
        let peripherals = match self.adapter.as_ref().unwrap().peripherals().await {
            Ok(peripherals) => peripherals,
            Err(error) => {
                let message = error.to_string();
                if self.recover_adapter_if_closed(&message).await {
                    self.refresh_adapter_preserving_scan()
                        .await?
                        .peripherals()
                        .await
                        .map_err(|e| AppError::BtleError(e.to_string()))?
                } else {
                    return Err(AppError::BtleError(message));
                }
            }
        };
        Ok(peripherals
            .into_iter()
            .find(|peripheral| peripheral.id().to_string() == device_id))
    }

    /// Start a raw rediscovery scan without touching the user-facing
    /// `scanning` flag. Callers must not hold the manager lock while waiting.
    pub async fn rescan_start(&mut self) -> AppResult<()> {
        self.ensure_adapter().await?;
        if let Err(error) = self
            .adapter
            .as_ref()
            .unwrap()
            .start_scan(ScanFilter::default())
            .await
        {
            let message = error.to_string();
            if self.recover_adapter_if_closed(&message).await {
                self.refresh_adapter()
                    .await?
                    .start_scan(ScanFilter::default())
                    .await
                    .map_err(|e| AppError::BtleError(e.to_string()))?;
            } else {
                return Err(AppError::BtleError(message));
            }
        }
        self.rescan_count += 1;
        Ok(())
    }

    /// Stop a rediscovery scan started by [`Self::rescan_start`]. The OS
    /// watcher stays running while the user-facing scan or another rescan
    /// still needs it — stopping it unconditionally would silently kill an
    /// active scan whose UI flag stays true.
    pub async fn rescan_stop(&mut self) -> AppResult<()> {
        self.rescan_count = self.rescan_count.saturating_sub(1);
        if self.rescan_count > 0 || *self.scanning.read().await {
            return Ok(());
        }
        if let Some(adapter) = &self.adapter {
            if let Err(error) = adapter.stop_scan().await {
                let message = error.to_string();
                if !self.recover_adapter_if_closed(&message).await {
                    return Err(AppError::BtleError(message));
                }
            }
        }
        Ok(())
    }
}

impl Default for BleScanner {
    fn default() -> Self {
        Self::new()
    }
}

async fn peripheral_to_ble_device(peripheral: &Peripheral) -> AppResult<BleDevice> {
    let id = peripheral.id().to_string();
    let is_connected = peripheral.is_connected().await.unwrap_or(false);

    let (
        name,
        rssi,
        service_uuids,
        manufacturer_data,
        service_data,
        tx_power_level,
        address_type,
        class,
        appearance,
        advertisement_name,
    ) = match peripheral.properties().await {
        Ok(Some(props)) => {
            let name = props.local_name;
            let rssi = props.rssi;
            let service_uuids = props
                .services
                .into_iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>();
            let manufacturer_data = props.manufacturer_data;
            let service_data: std::collections::HashMap<String, Vec<u8>> = props
                .service_data
                .into_iter()
                .map(|(uuid, data)| (uuid.to_string(), data))
                .collect();
            let tx_power_level = props.tx_power_level;
            let address_type = props
                .address_type
                .map(|at| format!("{:?}", at).to_lowercase());
            let class = props.class;
            let appearance = props.appearance;
            let advertisement_name = props.advertisement_name;
            (
                name,
                rssi,
                service_uuids,
                manufacturer_data,
                service_data,
                tx_power_level,
                address_type,
                class,
                appearance,
                advertisement_name,
            )
        }
        _ => (
            None,
            None,
            Vec::new(),
            std::collections::HashMap::new(),
            std::collections::HashMap::new(),
            None,
            None,
            None,
            None,
            None,
        ),
    };

    // Heuristic for is_connectable since btleplug 0.12 doesn't expose it
    let is_connectable = name.is_some() || !service_uuids.is_empty();

    Ok(BleDevice {
        id,
        name,
        rssi,
        service_uuids,
        is_connected,
        manufacturer_data,
        is_connectable,
        service_data,
        tx_power_level,
        address_type,
        class,
        appearance,
        advertisement_name,
    })
}

#[cfg(test)]
mod tests {
    use super::BleDevice;

    #[test]
    fn ble_device_serializes_reported_appearance() {
        let device = BleDevice {
            id: "device".to_string(),
            name: None,
            rssi: None,
            service_uuids: Vec::new(),
            is_connected: false,
            manufacturer_data: std::collections::HashMap::new(),
            is_connectable: false,
            service_data: std::collections::HashMap::new(),
            tx_power_level: None,
            address_type: None,
            class: None,
            appearance: Some(0x0340),
            advertisement_name: None,
        };

        let value = serde_json::to_value(device).expect("BLE device should serialize");
        assert_eq!(value["appearance"], 0x0340);
    }
}
