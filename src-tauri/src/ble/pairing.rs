use crate::error::{AppError, AppResult};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlePairingStatus {
    pub device_id: String,
    pub supported: bool,
    pub is_paired: bool,
    pub can_pair: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BlePairingStatus {
    #[cfg(not(target_os = "windows"))]
    fn unsupported(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_string(),
            supported: false,
            is_paired: false,
            can_pair: false,
            error: None,
        }
    }

    #[cfg(target_os = "windows")]
    fn failed(device_id: &str, error: AppError) -> Self {
        Self {
            device_id: device_id.to_string(),
            supported: true,
            is_paired: false,
            can_pair: false,
            error: Some(error.to_string()),
        }
    }
}

pub async fn get_pairing_status(device_id: &str) -> BlePairingStatus {
    #[cfg(target_os = "windows")]
    {
        match windows_pairing::get_pairing_status(device_id).await {
            Ok(status) => status,
            Err(error) => BlePairingStatus::failed(device_id, error),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        BlePairingStatus::unsupported(device_id)
    }
}

#[cfg(target_os = "windows")]
pub(crate) async fn ensure_encrypted_pairing(device_id: &str) -> AppResult<()> {
    windows_pairing::ensure_encrypted_pairing(device_id).await
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn parse_bluetooth_address(device_id: &str) -> AppResult<u64> {
    let compact = device_id
        .chars()
        .filter(|character| *character != ':' && *character != '-')
        .collect::<String>();

    if compact.len() != 12
        || !compact
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(AppError::Ble(format!(
            "Invalid Bluetooth device address: {device_id}"
        )));
    }

    u64::from_str_radix(&compact, 16)
        .map_err(|_| AppError::Ble(format!("Invalid Bluetooth device address: {device_id}")))
}

#[cfg(target_os = "windows")]
mod windows_pairing {
    use super::{parse_bluetooth_address, BlePairingStatus};
    use crate::error::{AppError, AppResult};
    use std::sync::OnceLock;
    use tokio::sync::Mutex;
    use windows::core::Ref;
    use windows::Devices::Bluetooth::BluetoothLEDevice;
    use windows::Devices::Enumeration::{
        DeviceInformationCustomPairing, DeviceInformationPairing, DevicePairingKinds,
        DevicePairingProtectionLevel, DevicePairingRequestedEventArgs, DevicePairingResultStatus,
    };
    use windows::Foundation::TypedEventHandler;

    static ENCRYPTED_PAIRING_GATE: OnceLock<Mutex<()>> = OnceLock::new();

    pub async fn get_pairing_status(device_id: &str) -> AppResult<BlePairingStatus> {
        let pairing = pairing_for_device(device_id).await?;
        status_from_pairing(device_id, &pairing)
    }

    pub async fn ensure_encrypted_pairing(device_id: &str) -> AppResult<()> {
        let _pairing_lease = ENCRYPTED_PAIRING_GATE
            .get_or_init(|| Mutex::new(()))
            .lock()
            .await;
        let pairing = pairing_for_device(device_id).await?;
        let is_paired = pairing.IsPaired().map_err(winrt_error)?;
        let can_pair = pairing.CanPair().map_err(winrt_error)?;
        log::info!(
            "[BLE_SECURITY] pairing check: device={} is_paired={} can_pair={}",
            device_id,
            is_paired,
            can_pair,
        );
        if is_paired {
            log::info!(
                "[BLE_SECURITY] using existing Windows pairing without opening a new consent dialog: device={}",
                device_id,
            );
            return Ok(());
        }
        if !can_pair {
            return Err(AppError::Ble(format!(
                "Device is not ready or does not support encrypted pairing: {device_id}"
            )));
        }

        log::info!(
            "[BLE_SECURITY] starting Windows ConfirmOnly pairing with Encryption protection: device={}",
            device_id,
        );
        let custom_pairing = pairing.Custom().map_err(winrt_error)?;
        let handler_token = {
            let handler: TypedEventHandler<
                DeviceInformationCustomPairing,
                DevicePairingRequestedEventArgs,
            > = TypedEventHandler::new(|_sender, args: Ref<DevicePairingRequestedEventArgs>| {
                let args = args.ok()?;
                let pairing_kind = args.PairingKind()?;
                if pairing_kind == DevicePairingKinds::ConfirmOnly {
                    args.Accept()?;
                } else {
                    log::warn!(
                        "[BLE_SECURITY] Windows requested an unsupported pairing ceremony: {:?}",
                        pairing_kind,
                    );
                }
                Ok(())
            });
            custom_pairing
                .PairingRequested(&handler)
                .map_err(winrt_error)?
        };
        let pairing_result = async {
            custom_pairing
                .PairWithProtectionLevelAsync(
                    DevicePairingKinds::ConfirmOnly,
                    DevicePairingProtectionLevel::Encryption,
                )?
                .await
        }
        .await;
        let removal_result = custom_pairing.RemovePairingRequested(handler_token);
        let result = pairing_result.map_err(winrt_error)?;
        removal_result.map_err(winrt_error)?;

        let result_status = result.Status().map_err(winrt_error)?;
        let protection_level_used = result.ProtectionLevelUsed().ok();
        let is_paired_after = pairing.IsPaired().ok();
        log::info!(
            "[BLE_SECURITY] pairing completed: device={} status={:?} protection_level_used={:?} is_paired={:?}",
            device_id,
            result_status,
            protection_level_used,
            is_paired_after,
        );
        if result_status != DevicePairingResultStatus::Paired
            && result_status != DevicePairingResultStatus::AlreadyPaired
        {
            return Err(AppError::Ble(format!(
                "Encrypted pairing failed for {device_id}: {}",
                pairing_result_message(result_status)
            )));
        }

        Ok(())
    }

    async fn pairing_for_device(device_id: &str) -> AppResult<DeviceInformationPairing> {
        let address = parse_bluetooth_address(device_id)?;
        let device = BluetoothLEDevice::FromBluetoothAddressAsync(address)
            .map_err(winrt_error)?
            .await
            .map_err(winrt_error)?;
        let device_information = device.DeviceInformation().map_err(winrt_error)?;
        device_information.Pairing().map_err(winrt_error)
    }

    fn status_from_pairing(
        device_id: &str,
        pairing: &DeviceInformationPairing,
    ) -> AppResult<BlePairingStatus> {
        Ok(BlePairingStatus {
            device_id: device_id.to_string(),
            supported: true,
            is_paired: pairing.IsPaired().map_err(winrt_error)?,
            can_pair: pairing.CanPair().map_err(winrt_error)?,
            error: None,
        })
    }

    fn pairing_result_message(status: DevicePairingResultStatus) -> &'static str {
        match status {
            DevicePairingResultStatus::NotReadyToPair => "device is not ready to pair",
            DevicePairingResultStatus::NotPaired => "device was not paired",
            DevicePairingResultStatus::ConnectionRejected => "connection was rejected",
            DevicePairingResultStatus::TooManyConnections => "device has too many connections",
            DevicePairingResultStatus::HardwareFailure => "Bluetooth hardware failure",
            DevicePairingResultStatus::AuthenticationTimeout => "authentication timed out",
            DevicePairingResultStatus::AuthenticationNotAllowed => {
                "authentication method is not supported"
            }
            DevicePairingResultStatus::AuthenticationFailure => "authentication failed",
            DevicePairingResultStatus::NoSupportedProfiles => "no supported profiles",
            DevicePairingResultStatus::ProtectionLevelCouldNotBeMet => {
                "required protection level could not be met"
            }
            DevicePairingResultStatus::AccessDenied => "access denied",
            DevicePairingResultStatus::InvalidCeremonyData => "invalid pairing data",
            DevicePairingResultStatus::PairingCanceled => "pairing was canceled",
            DevicePairingResultStatus::OperationAlreadyInProgress => {
                "another pairing operation is already in progress"
            }
            DevicePairingResultStatus::RequiredHandlerNotRegistered => {
                "the device requires a pairing method that is not registered"
            }
            DevicePairingResultStatus::RejectedByHandler => "pairing was rejected",
            DevicePairingResultStatus::RemoteDeviceHasAssociation => {
                "remote device is already associated with another host"
            }
            DevicePairingResultStatus::Failed => "unknown Windows pairing failure",
            _ => "unexpected Windows pairing status",
        }
    }

    fn winrt_error(error: windows::core::Error) -> AppError {
        AppError::Ble(format!("Windows Bluetooth pairing error: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_bluetooth_address;

    #[test]
    fn parses_bluetooth_address_formats() {
        assert_eq!(
            parse_bluetooth_address("AA:BB:CC:DD:EE:FF").unwrap(),
            0xAABBCCDDEEFF
        );
        assert_eq!(
            parse_bluetooth_address("aa-bb-cc-dd-ee-ff").unwrap(),
            0xAABBCCDDEEFF
        );
    }

    #[test]
    fn rejects_invalid_bluetooth_addresses() {
        assert!(parse_bluetooth_address("not-a-device").is_err());
        assert!(parse_bluetooth_address("AA:BB:CC:DD:EE").is_err());
    }
}
