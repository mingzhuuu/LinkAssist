use crate::error::{AppError, AppResult};
use btleplug::api::{CharPropFlags, Characteristic, Peripheral as _, WriteType};
use btleplug::platform::Peripheral;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GattService {
    pub uuid: String,
    pub characteristics: Vec<GattCharacteristic>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GattCharacteristic {
    pub uuid: String,
    pub service_uuid: String,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BleWriteType {
    Auto,
    WithResponse,
    WithoutResponse,
}

impl Default for BleWriteType {
    fn default() -> Self {
        Self::WithResponse
    }
}

impl BleWriteType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::WithResponse => "withResponse",
            Self::WithoutResponse => "withoutResponse",
        }
    }
}

pub async fn discover_services(peripheral: &Peripheral) -> AppResult<Vec<GattService>> {
    peripheral
        .discover_services()
        .await
        .map_err(|e| AppError::BtleError(e.to_string()))?;

    let services = peripheral.services();
    let mut result = Vec::new();

    for service in services {
        let chars: Vec<GattCharacteristic> = service
            .characteristics
            .iter()
            .map(|c| GattCharacteristic {
                uuid: c.uuid.to_string(),
                service_uuid: service.uuid.to_string(),
                properties: char_props_to_strings(c.properties),
            })
            .collect();

        result.push(GattService {
            uuid: service.uuid.to_string(),
            characteristics: chars,
        });
    }

    Ok(result)
}

pub async fn read_characteristic(
    peripheral: &Peripheral,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
) -> AppResult<Vec<u8>> {
    let characteristic =
        find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "Characteristic {} not found in service {}",
                char_uuid, service_uuid
            ))
        })?;

    ensure_read_supported(service_uuid, char_uuid, characteristic.properties)?;

    #[cfg(target_os = "windows")]
    {
        return windows_gatt::read_characteristic_with_security(
            peripheral,
            device_id,
            service_uuid,
            char_uuid,
        )
        .await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = device_id;
        let data = peripheral
            .read(&characteristic)
            .await
            .map_err(|e| AppError::BtleError(e.to_string()))?;

        Ok(data)
    }
}

const ATT_ERROR_INSUFFICIENT_AUTHENTICATION: u8 = 0x05;
const ATT_ERROR_INSUFFICIENT_ENCRYPTION_KEY_SIZE: u8 = 0x0c;
const ATT_ERROR_INSUFFICIENT_ENCRYPTION: u8 = 0x0f;
const WINDOWS_BLUETOOTH_ATT_HRESULT_PREFIX: u32 = 0x8065_0000;

fn is_att_security_error(code: u8) -> bool {
    matches!(
        code,
        ATT_ERROR_INSUFFICIENT_AUTHENTICATION
            | ATT_ERROR_INSUFFICIENT_ENCRYPTION_KEY_SIZE
            | ATT_ERROR_INSUFFICIENT_ENCRYPTION
    )
}

fn att_protocol_error_name(code: u8) -> &'static str {
    match code {
        ATT_ERROR_INSUFFICIENT_AUTHENTICATION => "insufficient authentication",
        ATT_ERROR_INSUFFICIENT_ENCRYPTION_KEY_SIZE => "insufficient encryption key size",
        ATT_ERROR_INSUFFICIENT_ENCRYPTION => "insufficient encryption",
        _ => "GATT protocol error",
    }
}

fn att_error_from_windows_hresult(raw: u32) -> Option<u8> {
    (raw & 0xffff_ff00 == WINDOWS_BLUETOOTH_ATT_HRESULT_PREFIX).then_some(raw as u8)
}

fn att_security_error_from_text(message: &str) -> Option<u8> {
    let message = message.to_ascii_uppercase();
    [
        ATT_ERROR_INSUFFICIENT_AUTHENTICATION,
        ATT_ERROR_INSUFFICIENT_ENCRYPTION_KEY_SIZE,
        ATT_ERROR_INSUFFICIENT_ENCRYPTION,
    ]
    .into_iter()
    .find(|code| message.contains(&format!("0X806500{code:02X}")))
}

#[cfg(target_os = "windows")]
mod windows_gatt {
    use super::{att_error_from_windows_hresult, att_protocol_error_name, is_att_security_error};
    use crate::error::{AppError, AppResult};
    use btleplug::api::Peripheral as _;
    use btleplug::platform::Peripheral;
    use uuid::Uuid;
    use windows::core::GUID;
    use windows::Devices::Bluetooth::GenericAttributeProfile::{
        GattCharacteristic, GattCommunicationStatus, GattReadResult,
    };
    use windows::Devices::Bluetooth::{BluetoothCacheMode, BluetoothLEDevice};
    use windows::Storage::Streams::DataReader;

    const GATT_METADATA_CACHE_MODE: BluetoothCacheMode = BluetoothCacheMode::Cached;
    const GATT_VALUE_CACHE_MODE: BluetoothCacheMode = BluetoothCacheMode::Uncached;

    #[derive(Debug)]
    enum SecurityFailure {
        Att(u8),
    }

    enum ReadFailure {
        Security(SecurityFailure),
        Protocol(u8),
        Other(AppError),
    }

    pub async fn read_characteristic_with_security(
        peripheral: &Peripheral,
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
    ) -> AppResult<Vec<u8>> {
        let characteristic = super::find_characteristic(peripheral, service_uuid, char_uuid)
            .ok_or_else(|| {
                AppError::Ble(format!(
                    "Characteristic {} not found in service {}",
                    char_uuid, service_uuid
                ))
            })?;

        // Keep ordinary reads on the already-connected btleplug object. Only
        // create a second WinRT view when the normal read fails and Windows
        // protocol details are needed to decide whether pairing is appropriate.
        let first_error = match peripheral.read(&characteristic).await {
            Ok(data) => return Ok(data),
            Err(error) => error,
        };
        log::debug!(
            "BLE read through existing connection failed; checking Windows GATT status: device={} service={} characteristic={} error={}",
            device_id,
            service_uuid,
            char_uuid,
            first_error,
        );

        match read_once(device_id, service_uuid, char_uuid).await {
            Ok(data) => Ok(data),
            Err(ReadFailure::Security(failure)) => {
                log::info!(
                    "[BLE_SECURITY] read requires a security upgrade: device={} service={} characteristic={} reason={}",
                    device_id,
                    service_uuid,
                    char_uuid,
                    security_failure_description(&failure),
                );
                crate::ble::pairing::ensure_encrypted_pairing(device_id).await?;
                let retry_characteristic =
                    super::find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(
                        || {
                            AppError::Ble(format!(
                                "Characteristic {} not found in service {} after security upgrade",
                                char_uuid, service_uuid
                            ))
                        },
                    )?;
                let data = peripheral
                    .read(&retry_characteristic)
                    .await
                    .map_err(|error| {
                        AppError::BtleError(format!(
                            "Read after security upgrade through existing connection failed: {error}"
                        ))
                    })?;
                log::info!(
                    "[BLE_SECURITY] read succeeded after security upgrade through existing connection: device={} service={} characteristic={}",
                    device_id,
                    service_uuid,
                    char_uuid,
                );
                Ok(data)
            }
            Err(ReadFailure::Protocol(code)) => Err(protocol_error("read", code)),
            Err(ReadFailure::Other(error)) => Err(error),
        }
    }

    async fn read_once(
        device_id: &str,
        service_uuid: &str,
        char_uuid: &str,
    ) -> Result<Vec<u8>, ReadFailure> {
        let address =
            crate::ble::pairing::parse_bluetooth_address(device_id).map_err(ReadFailure::Other)?;
        let service_guid = parse_guid("service", service_uuid).map_err(ReadFailure::Other)?;
        let char_guid = parse_guid("characteristic", char_uuid).map_err(ReadFailure::Other)?;
        let device = BluetoothLEDevice::FromBluetoothAddressAsync(address)
            .map_err(|error| winrt_failure("open device", error))?
            .await
            .map_err(|error| winrt_failure("open device", error))?;

        // Service and characteristic metadata were already discovered by
        // btleplug. Reuse the Windows cache so a protected metadata rediscovery
        // cannot fail before ProtectionLevel is applied to the characteristic.
        let services_result = device
            .GetGattServicesForUuidWithCacheModeAsync(service_guid, GATT_METADATA_CACHE_MODE)
            .map_err(|error| winrt_failure("discover service", error))?
            .await
            .map_err(|error| winrt_failure("discover service", error))?;
        ensure_status(
            "discover service",
            services_result
                .Status()
                .map_err(|error| winrt_failure("read service discovery status", error))?,
            services_result
                .ProtocolError()
                .ok()
                .and_then(|error| error.Value().ok()),
        )?;
        let service = services_result
            .Services()
            .map_err(|error| winrt_failure("get discovered services", error))?
            .into_iter()
            .next()
            .ok_or_else(|| {
                ReadFailure::Other(AppError::Ble(format!(
                    "GATT service {service_uuid} was not found in the Windows cache for {device_id}"
                )))
            })?;

        let characteristics_result = service
            .GetCharacteristicsForUuidWithCacheModeAsync(char_guid, GATT_METADATA_CACHE_MODE)
            .map_err(|error| winrt_failure("discover characteristic", error))?
            .await
            .map_err(|error| winrt_failure("discover characteristic", error))?;
        ensure_status(
            "discover characteristic",
            characteristics_result
                .Status()
                .map_err(|error| winrt_failure("read characteristic discovery status", error))?,
            characteristics_result
                .ProtocolError()
                .ok()
                .and_then(|error| error.Value().ok()),
        )?;
        let characteristic: GattCharacteristic = characteristics_result
            .Characteristics()
            .map_err(|error| winrt_failure("get discovered characteristics", error))?
            .into_iter()
            .next()
            .ok_or_else(|| {
                ReadFailure::Other(AppError::Ble(format!(
                    "GATT characteristic {char_uuid} was not found in the Windows cache for service {service_uuid}"
                )))
            })?;

        let read_result = characteristic
            .ReadValueWithCacheModeAsync(GATT_VALUE_CACHE_MODE)
            .map_err(|error| winrt_failure("start characteristic read", error))?
            .await
            .map_err(|error| winrt_failure("read characteristic", error))?;
        let status = read_result
            .Status()
            .map_err(|error| winrt_failure("read characteristic status", error))?;
        let protocol_code = read_result
            .ProtocolError()
            .ok()
            .and_then(|error| error.Value().ok());
        ensure_status("read", status, protocol_code)?;
        read_bytes(&read_result)
    }

    fn parse_guid(kind: &str, value: &str) -> AppResult<GUID> {
        let uuid = value
            .parse::<Uuid>()
            .map_err(|_| AppError::Ble(format!("Invalid GATT {kind} UUID: {value}")))?;
        let (data1, data2, data3, data4) = uuid.as_fields();
        Ok(GUID::from_values(data1, data2, data3, *data4))
    }

    fn read_bytes(result: &GattReadResult) -> Result<Vec<u8>, ReadFailure> {
        let value = result
            .Value()
            .map_err(|error| winrt_failure("get characteristic value", error))?;
        let reader = DataReader::FromBuffer(&value)
            .map_err(|error| winrt_failure("open characteristic value", error))?;
        let length = reader
            .UnconsumedBufferLength()
            .map_err(|error| winrt_failure("get characteristic value length", error))?
            as usize;
        let mut data = vec![0; length];
        reader
            .ReadBytes(&mut data)
            .map_err(|error| winrt_failure("copy characteristic value", error))?;
        Ok(data)
    }

    fn ensure_status(
        stage: &str,
        status: GattCommunicationStatus,
        protocol_code: Option<u8>,
    ) -> Result<(), ReadFailure> {
        if status == GattCommunicationStatus::Success {
            return Ok(());
        }
        if status == GattCommunicationStatus::ProtocolError {
            if let Some(code) = protocol_code {
                if is_att_security_error(code) {
                    return Err(ReadFailure::Security(SecurityFailure::Att(code)));
                }
                return Err(ReadFailure::Protocol(code));
            }
        }
        if status == GattCommunicationStatus::AccessDenied {
            return Err(ReadFailure::Other(status_error(
                stage,
                status,
                protocol_code,
            )));
        }
        Err(ReadFailure::Other(status_error(
            stage,
            status,
            protocol_code,
        )))
    }

    fn protocol_error(stage: &str, code: u8) -> AppError {
        AppError::Ble(format!(
            "Windows GATT {stage} failed: ATT protocol error 0x{code:02X} ({})",
            att_protocol_error_name(code)
        ))
    }

    fn security_failure_description(failure: &SecurityFailure) -> String {
        match failure {
            SecurityFailure::Att(code) => format!(
                "ATT protocol error 0x{code:02X} ({})",
                att_protocol_error_name(*code)
            ),
        }
    }

    fn status_error(
        stage: &str,
        status: GattCommunicationStatus,
        protocol_code: Option<u8>,
    ) -> AppError {
        let protocol = protocol_code
            .map(|code| {
                format!(
                    ", ATT protocol error 0x{code:02X} ({})",
                    att_protocol_error_name(code)
                )
            })
            .unwrap_or_default();
        AppError::Ble(format!(
            "Windows GATT {stage} failed: status={status:?}{protocol}"
        ))
    }

    fn winrt_failure(stage: &str, error: windows::core::Error) -> ReadFailure {
        if let Some(code) = att_error_from_windows_hresult(error.code().0 as u32) {
            if is_att_security_error(code) {
                return ReadFailure::Security(SecurityFailure::Att(code));
            }
            return ReadFailure::Protocol(code);
        }
        ReadFailure::Other(AppError::Ble(format!(
            "Windows GATT {stage} error: {error}"
        )))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::ble::gatt::ATT_ERROR_INSUFFICIENT_AUTHENTICATION;

        #[test]
        fn access_denied_does_not_request_pairing() {
            let failure = ensure_status(
                "discover characteristic",
                GattCommunicationStatus::AccessDenied,
                None,
            )
            .expect_err("AccessDenied should remain a normal GATT error");

            match failure {
                ReadFailure::Other(error) => {
                    let message = error.to_string();
                    assert!(message.contains("Windows GATT discover characteristic failed"));
                }
                _ => panic!("AccessDenied must not trigger the pairing path"),
            }
        }

        #[test]
        fn protocol_security_errors_are_separate_from_other_att_errors() {
            assert!(matches!(
                ensure_status(
                    "read",
                    GattCommunicationStatus::ProtocolError,
                    Some(ATT_ERROR_INSUFFICIENT_AUTHENTICATION),
                ),
                Err(ReadFailure::Security(SecurityFailure::Att(
                    ATT_ERROR_INSUFFICIENT_AUTHENTICATION
                )))
            ));
            assert!(matches!(
                ensure_status("read", GattCommunicationStatus::ProtocolError, Some(0x08),),
                Err(ReadFailure::Protocol(0x08))
            ));
        }

        #[test]
        fn reads_cached_metadata_but_fetches_the_value_from_the_device() {
            assert_eq!(GATT_METADATA_CACHE_MODE, BluetoothCacheMode::Cached);
            assert_eq!(GATT_VALUE_CACHE_MODE, BluetoothCacheMode::Uncached);
        }
    }
}

fn ensure_read_supported(
    service_uuid: &str,
    char_uuid: &str,
    properties: CharPropFlags,
) -> AppResult<()> {
    if properties.contains(CharPropFlags::READ) {
        return Ok(());
    }

    let advertised_properties = char_props_to_strings(properties);
    let advertised_properties = if advertised_properties.is_empty() {
        "none".to_string()
    } else {
        advertised_properties.join(", ")
    };
    let suggestion = if properties.intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE) {
        " Use subscribe_ble_notifications instead."
    } else {
        ""
    };

    Err(AppError::Ble(format!(
        "Characteristic {} in service {} does not support read; advertised properties: {}.{}",
        char_uuid, service_uuid, advertised_properties, suggestion
    )))
}

pub async fn write_characteristic(
    peripheral: &Peripheral,
    service_uuid: &str,
    char_uuid: &str,
    data: &[u8],
    write_type: WriteType,
) -> AppResult<()> {
    let characteristic =
        find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "Characteristic {} not found in service {}",
                char_uuid, service_uuid
            ))
        })?;

    peripheral
        .write(&characteristic, data, write_type)
        .await
        .map_err(|e| AppError::BtleError(e.to_string()))?;

    Ok(())
}

pub async fn write_characteristic_resolved(
    peripheral: &Peripheral,
    service_uuid: &str,
    char_uuid: &str,
    data: &[u8],
    requested_write_type: BleWriteType,
) -> AppResult<BleWriteType> {
    let characteristic =
        find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "Characteristic {} not found in service {}",
                char_uuid, service_uuid
            ))
        })?;
    let resolved = resolve_write_type(
        service_uuid,
        char_uuid,
        characteristic.properties,
        requested_write_type,
    )?;
    let btle_write_type = match resolved {
        BleWriteType::WithResponse => WriteType::WithResponse,
        BleWriteType::WithoutResponse => WriteType::WithoutResponse,
        BleWriteType::Auto => unreachable!("auto write type is resolved before writing"),
    };

    peripheral
        .write(&characteristic, data, btle_write_type)
        .await
        .map_err(|e| AppError::BtleError(e.to_string()))?;
    Ok(resolved)
}

fn resolve_write_type(
    service_uuid: &str,
    char_uuid: &str,
    properties: CharPropFlags,
    requested: BleWriteType,
) -> AppResult<BleWriteType> {
    let supports_with_response = properties.contains(CharPropFlags::WRITE);
    let supports_without_response = properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE);

    let resolved = match requested {
        BleWriteType::Auto if supports_with_response => BleWriteType::WithResponse,
        BleWriteType::Auto if supports_without_response => BleWriteType::WithoutResponse,
        BleWriteType::WithResponse if supports_with_response => BleWriteType::WithResponse,
        BleWriteType::WithoutResponse if supports_without_response => BleWriteType::WithoutResponse,
        _ => {
            let advertised = char_props_to_strings(properties);
            let advertised = if advertised.is_empty() {
                "none".to_string()
            } else {
                advertised.join(", ")
            };
            return Err(AppError::Ble(format!(
                "Characteristic {} in service {} does not support writeType '{}'; advertised properties: {}",
                char_uuid,
                service_uuid,
                requested.as_str(),
                advertised,
            )));
        }
    };

    Ok(resolved)
}

pub async fn subscribe_notifications(
    peripheral: &Peripheral,
    device_id: &str,
    service_uuid: &str,
    char_uuid: &str,
) -> AppResult<()> {
    #[cfg(not(target_os = "windows"))]
    let _ = device_id;

    let characteristic =
        find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "Characteristic {} not found in service {}",
                char_uuid, service_uuid
            ))
        })?;

    let first_error = match peripheral.subscribe(&characteristic).await {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let first_error_message = first_error.to_string();

    #[cfg(target_os = "windows")]
    if let Some(code) = att_security_error_from_text(&first_error_message) {
        log::info!(
            "[BLE_SECURITY] subscribe requires a security upgrade: device={} service={} characteristic={} ATT=0x{:02X} ({})",
            device_id,
            service_uuid,
            char_uuid,
            code,
            att_protocol_error_name(code),
        );

        // The pinned btleplug revision registers ValueChanged before writing the
        // CCCD. Its unsubscribe path removes that handler before attempting the
        // CCCD write, so call it even though the write can still fail pre-pairing.
        if let Err(error) = peripheral.unsubscribe(&characteristic).await {
            log::debug!(
                "[BLE_SECURITY] cleanup after failed subscribe returned an expected error: device={} service={} characteristic={} error={}",
                device_id,
                service_uuid,
                char_uuid,
                error,
            );
        }

        crate::ble::pairing::ensure_encrypted_pairing(device_id).await?;
        let retry_characteristic = find_characteristic(peripheral, service_uuid, char_uuid)
            .ok_or_else(|| {
                AppError::Ble(format!(
                    "Characteristic {} not found in service {} after pairing",
                    char_uuid, service_uuid
                ))
            })?;
        peripheral
            .subscribe(&retry_characteristic)
            .await
            .map_err(|error| {
                AppError::BtleError(format!("Subscribe after encrypted pairing failed: {error}"))
            })?;
        log::info!(
            "[BLE_SECURITY] subscribe succeeded after pairing retry: device={} service={} characteristic={}",
            device_id,
            service_uuid,
            char_uuid,
        );
        return Ok(());
    }

    Err(AppError::BtleError(first_error_message))
}

pub async fn unsubscribe_notifications(
    peripheral: &Peripheral,
    service_uuid: &str,
    char_uuid: &str,
) -> AppResult<()> {
    let characteristic =
        find_characteristic(peripheral, service_uuid, char_uuid).ok_or_else(|| {
            AppError::Ble(format!(
                "Characteristic {} not found in service {}",
                char_uuid, service_uuid
            ))
        })?;

    peripheral
        .unsubscribe(&characteristic)
        .await
        .map_err(|e| AppError::BtleError(e.to_string()))?;

    Ok(())
}

pub fn find_characteristic(
    peripheral: &Peripheral,
    service_uuid: &str,
    char_uuid: &str,
) -> Option<Characteristic> {
    let service_uuid_parsed = service_uuid.parse::<Uuid>().ok()?;
    let char_uuid_parsed = char_uuid.parse::<Uuid>().ok()?;

    peripheral.services().into_iter().find_map(|s| {
        if s.uuid == service_uuid_parsed {
            s.characteristics
                .into_iter()
                .find(|c| c.uuid == char_uuid_parsed)
        } else {
            None
        }
    })
}

fn char_props_to_strings(flags: CharPropFlags) -> Vec<String> {
    let mut props = Vec::new();
    if flags.contains(CharPropFlags::READ) {
        props.push("read".to_string());
    }
    if flags.contains(CharPropFlags::WRITE) {
        props.push("write".to_string());
    }
    if flags.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE) {
        props.push("write_without_response".to_string());
    }
    if flags.contains(CharPropFlags::NOTIFY) {
        props.push("notify".to_string());
    }
    if flags.contains(CharPropFlags::INDICATE) {
        props.push("indicate".to_string());
    }
    if flags.contains(CharPropFlags::BROADCAST) {
        props.push("broadcast".to_string());
    }
    if flags.contains(CharPropFlags::AUTHENTICATED_SIGNED_WRITES) {
        props.push("authenticated_signed_writes".to_string());
    }
    props
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_only_att_security_errors_for_automatic_pairing() {
        assert!(is_att_security_error(0x05));
        assert!(is_att_security_error(0x0c));
        assert!(is_att_security_error(0x0f));
        assert!(!is_att_security_error(0x02));
        assert!(!is_att_security_error(0x08));
        assert!(!is_att_security_error(0x0e));
    }

    #[test]
    fn describes_att_security_errors() {
        assert_eq!(att_protocol_error_name(0x05), "insufficient authentication");
        assert_eq!(
            att_protocol_error_name(0x0c),
            "insufficient encryption key size"
        );
        assert_eq!(att_protocol_error_name(0x0f), "insufficient encryption");
        assert_eq!(att_protocol_error_name(0xff), "GATT protocol error");
    }

    #[test]
    fn extracts_att_errors_from_windows_hresult_values() {
        assert_eq!(
            att_error_from_windows_hresult(0x8065_0005),
            Some(ATT_ERROR_INSUFFICIENT_AUTHENTICATION)
        );
        assert_eq!(
            att_error_from_windows_hresult(0x8065_000c),
            Some(ATT_ERROR_INSUFFICIENT_ENCRYPTION_KEY_SIZE)
        );
        assert_eq!(att_error_from_windows_hresult(0x8007_0005), None);
    }

    #[test]
    fn extracts_security_hresult_from_btleplug_error_text() {
        assert_eq!(
            att_security_error_from_text(
                "Error { code: HRESULT(0x80650005), message: authentication required }"
            ),
            Some(ATT_ERROR_INSUFFICIENT_AUTHENTICATION)
        );
        assert_eq!(
            att_security_error_from_text("HRESULT(0x8065000f)"),
            Some(ATT_ERROR_INSUFFICIENT_ENCRYPTION)
        );
        assert_eq!(att_security_error_from_text("permission denied"), None);
    }

    #[test]
    fn read_validation_accepts_readable_characteristics() {
        assert!(ensure_read_supported(
            "service",
            "char",
            CharPropFlags::READ | CharPropFlags::NOTIFY,
        )
        .is_ok());
    }

    #[test]
    fn read_validation_rejects_notify_only_characteristics() {
        let error = ensure_read_supported("service", "char", CharPropFlags::NOTIFY)
            .expect_err("notify-only characteristics should be rejected");

        let message = error.to_string();
        assert!(message.contains("does not support read"));
        assert!(message.contains("subscribe_ble_notifications"));
    }

    #[test]
    fn auto_write_type_prefers_legacy_with_response_when_both_are_supported() {
        let resolved = resolve_write_type(
            "service",
            "char",
            CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE,
            BleWriteType::Auto,
        )
        .expect("auto should resolve");
        assert_eq!(resolved, BleWriteType::WithResponse);
    }

    #[test]
    fn default_write_type_preserves_with_response_compatibility() {
        assert_eq!(BleWriteType::default(), BleWriteType::WithResponse);
    }

    #[test]
    fn auto_write_type_uses_without_response_when_it_is_the_only_option() {
        let resolved = resolve_write_type(
            "service",
            "char",
            CharPropFlags::WRITE_WITHOUT_RESPONSE,
            BleWriteType::Auto,
        )
        .expect("auto should resolve");
        assert_eq!(resolved, BleWriteType::WithoutResponse);
    }

    #[test]
    fn explicit_unsupported_write_type_is_rejected() {
        let error = resolve_write_type(
            "service",
            "char",
            CharPropFlags::WRITE_WITHOUT_RESPONSE,
            BleWriteType::WithResponse,
        )
        .expect_err("unsupported write type should fail");
        assert!(error.to_string().contains("withResponse"));
        assert!(error.to_string().contains("write_without_response"));
    }
}
