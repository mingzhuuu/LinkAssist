//! Windows USB hub queries only: never opens COM, sets configuration, or resets a device.
use super::{
    monitor::UsbCaptureConfig,
    usb_discovery::{data_interface, MonitorDiscovery},
};
use std::{
    mem::{offset_of, size_of},
    path::PathBuf,
};
use windows::{
    core::PCWSTR,
    Win32::{
        Devices::{DeviceAndDriverInstallation::*, Usb::*},
        Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE},
        Storage::FileSystem::*,
        System::{Registry::*, IO::DeviceIoControl},
    },
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn string(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|v| *v == 0).unwrap_or(value.len())])
}
fn utf16(bytes: &[u8]) -> String {
    string(
        &bytes
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    )
}
fn error(e: windows::core::Error) -> String {
    if e.code().0 as u32 == 0x80070005 {
        "Access denied. Run LinkAssist as administrator to query/capture USB devices; reinstalling USBPcap is not required.".into()
    } else {
        format!("USB query failed: {e}")
    }
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn open(path: &str, access: u32) -> Result<Handle, String> {
    let path = wide(path);
    unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .map(Handle)
        .map_err(error)
    }
}
fn query(
    handle: &Handle,
    code: u32,
    buffer: &mut [u8],
    input_size: usize,
) -> Result<usize, String> {
    let mut returned = 0;
    // The initialized byte buffer supports the variable-length USB IOCTL structs;
    // no typed references to unaligned/driver-provided data are constructed.
    unsafe {
        DeviceIoControl(
            handle.0,
            code,
            if input_size == 0 {
                None
            } else {
                Some(buffer.as_ptr().cast())
            },
            input_size as u32,
            Some(buffer.as_mut_ptr().cast()),
            buffer.len() as u32,
            Some(&mut returned),
            None,
        )
        .map_err(error)?;
    }
    if returned as usize > buffer.len() {
        return Err("Invalid USB query response length".into());
    }
    Ok(returned as usize)
}
fn reg_string(key: HKEY, subkey: &str, value: &str, view: REG_ROUTINE_FLAGS) -> Option<String> {
    let subkey = wide(subkey);
    let value = wide(value);
    let mut buffer = vec![0u16; 32768];
    let mut len = (buffer.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            key,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | view,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if result.is_ok() {
        Some(string(&buffer))
    } else {
        None
    }
}

pub(super) fn installed_executables() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for view in [RRF_SUBKEY_WOW6464KEY, RRF_SUBKEY_WOW6432KEY] {
        for product in ["USBPcap", "Wireshark"] {
            let key = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{product}");
            let mut directories = Vec::new();
            if let Some(value) = reg_string(HKEY_LOCAL_MACHINE, &key, "InstallLocation", view) {
                directories.push(PathBuf::from(value));
            }
            if let Some(value) = reg_string(HKEY_LOCAL_MACHINE, &key, "UninstallString", view) {
                // Parse a registered executable path, never execute the uninstall command.
                let value = value.trim();
                let executable = if let Some(rest) = value.strip_prefix('"') {
                    rest.split('"').next().unwrap_or("")
                } else {
                    value
                };
                let path = PathBuf::from(executable);
                if path
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
                {
                    if let Some(parent) = path.parent() {
                        directories.push(parent.to_path_buf());
                    }
                }
            }
            for directory in directories.into_iter().filter(|p| p.is_absolute()) {
                paths.push(directory.join(if product == "USBPcap" {
                    "USBPcapCMD.exe"
                } else {
                    "extcap/USBPcapCMD.exe"
                }));
            }
        }
    }
    paths
}

fn buses() -> Result<Vec<u16>, String> {
    // QueryDosDevice enumerates DOS symbolic links, including global USBPcapN links.
    let mut buffer = vec![0u16; 65536];
    let length = unsafe { QueryDosDeviceW(PCWSTR::null(), Some(&mut buffer)) } as usize;
    if length == 0 {
        return Err(error(windows::core::Error::from_thread()));
    }
    let mut result: Vec<_> = buffer[..length]
        .split(|c| *c == 0)
        .filter_map(|s| {
            let name = string(s);
            name.strip_prefix("USBPcap")
                .and_then(|n| n.parse::<u16>().ok())
                .filter(|n| *n > 0)
        })
        .collect();
    result.sort_unstable();
    result.dedup();
    Ok(result)
}

pub(super) fn available_capture_buses() -> Result<Vec<u16>, String> {
    let found = buses()?;
    if !found.is_empty() {
        return Ok(found);
    }
    let installed = reg_string(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Services\USBPcap",
        "ImagePath",
        REG_ROUTINE_FLAGS(0),
    )
    .is_some();
    Err(if installed {
        "USBPcap is installed, but no capture interface is active. Restart Windows to finish loading the USB filter driver, then retry detection. Reconnecting only the COM adapter or running as administrator does not load the filter onto existing USB hubs. If you already restarted after installation, repair the USBPcap driver."
    } else {
        "USBPcapCMD was found, but the USBPcap driver is missing. Repair USBPcap using its official installer, then restart Windows."
    }.into())
}

pub(super) fn check_capture_access(bus: u16) -> Result<(), String> {
    // Opening the control handle does not enable filtering or start a capture.
    drop(open(
        &format!(r"\\.\USBPcap{bus}"),
        GENERIC_READ.0 | GENERIC_WRITE.0,
    )?);
    Ok(())
}

impl std::io::Read for Handle {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let mut read = 0;
        unsafe { ReadFile(self.0, Some(buffer), Some(&mut read), None) }
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        Ok(read as usize)
    }
}

/// USBPcap.h control codes for snapshot length, buffer setup and device filtering.
pub(super) fn open_capture(cfg: &UsbCaptureConfig) -> Result<impl std::io::Read, String> {
    cfg.validate()?;
    let path = wide(&format!(r"\\.\USBPcap{}", cfg.bus));
    let handle = Handle(
        unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(error)?,
    );

    let ioctl = |code, input: &[u8]| {
        let mut returned = 0;
        unsafe {
            DeviceIoControl(
                handle.0,
                code,
                Some(input.as_ptr().cast()),
                input.len() as u32,
                None,
                0,
                Some(&mut returned),
                None,
            )
        }
        .map_err(error)
    };
    ioctl(0x0022_6010, &1_048_576u32.to_le_bytes())?;
    ioctl(0x0022_6000, &4_194_304u32.to_le_bytes())?;
    // USBPCAP_ADDRESS_FILTER is a 128-bit address bitmap plus a filterAll byte.
    let mut filter = [0u8; 17];
    let address = usize::from(cfg.address);
    filter[address / 8] = 1 << (address % 8);
    ioctl(0x0022_e004, &filter)?;
    Ok(handle)
}

struct Devices(HDEVINFO);
impl Drop for Devices {
    fn drop(&mut self) {
        unsafe {
            let _ = SetupDiDestroyDeviceInfoList(self.0);
        }
    }
}
fn property(node: u32, property: u32) -> String {
    let mut buffer = vec![0u16; 4096];
    let mut len = (buffer.len() * 2) as u32;
    let result = unsafe {
        CM_Get_DevNode_Registry_PropertyW(
            node,
            property,
            None,
            Some(buffer.as_mut_ptr().cast()),
            &mut len,
            0,
        )
    };
    if result == CR_SUCCESS {
        string(&buffer)
    } else {
        String::new()
    }
}
struct ComDevice {
    driver: String,
    interface: Option<u8>,
    service: String,
}
fn com_device(port: &str) -> Result<ComDevice, String> {
    let devices = Devices(unsafe {
        SetupDiGetClassDevsW(
            Some(&GUID_DEVCLASS_PORTS),
            PCWSTR::null(),
            None,
            DIGCF_PRESENT,
        )
        .map_err(error)?
    });
    for index in 0..4096 {
        let mut info = SP_DEVINFO_DATA {
            cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if unsafe { SetupDiEnumDeviceInfo(devices.0, index, &mut info) }.is_err() {
            break;
        }
        let key = match unsafe {
            SetupDiOpenDevRegKey(
                devices.0,
                &info,
                DICS_FLAG_GLOBAL.0,
                0,
                DIREG_DEV,
                KEY_QUERY_VALUE.0,
            )
        } {
            Ok(key) => key,
            Err(_) => continue,
        };
        let name = reg_string(key, "", "PortName", REG_ROUTINE_FLAGS(0));
        unsafe {
            let _ = RegCloseKey(key);
        }
        if !name.is_some_and(|n| n.eq_ignore_ascii_case(port)) {
            continue;
        }
        let mut node = info.DevInst;
        let service = property(node, CM_DRP_SERVICE).to_ascii_lowercase();
        let mut interface = None;
        for _ in 0..32 {
            let mut id = [0u16; 512];
            if unsafe { CM_Get_Device_IDW(node, &mut id, 0) } != CR_SUCCESS {
                break;
            }
            let id = string(&id).to_ascii_uppercase();
            if id.starts_with("USB\\VID_") {
                let hardware = id.split('\\').nth(1).unwrap_or("");
                if let Some((_, value)) = hardware.split_once("&MI_") {
                    interface = value.get(..2).and_then(|v| u8::from_str_radix(v, 16).ok());
                } else {
                    let driver = property(node, CM_DRP_DRIVER);
                    if !driver.is_empty() {
                        return Ok(ComDevice {
                            driver,
                            interface,
                            service,
                        });
                    }
                }
            }
            let mut parent = 0;
            if unsafe { CM_Get_Parent(&mut parent, node, 0) } != CR_SUCCESS {
                break;
            }
            node = parent;
        }
        return Err(format!("{port} has no USB device behind it (driver: {service}). USBPcap cannot monitor virtual, onboard or Bluetooth COM ports. To observe two external programs, use a serial monitoring driver that supports this port, or configure a mirrored port in the virtual-port software. Administrator access or manual USB settings will not enable USB capture for this port."));
    }
    Err(format!(
        "{port} is not present. Connect a USB serial adapter and select its COM port."
    ))
}

/// Manual USB parameters cannot make a non-USB COM port capturable.
pub(super) fn check_usb_port(port: &str) -> Result<(), String> {
    com_device(port).map(|_| ())
}

fn hub_path(name: &str) -> String {
    if let Some(rest) = name.strip_prefix(r"\??\") {
        format!(r"\\.\{rest}")
    } else if name.starts_with('\\') {
        name.into()
    } else {
        format!(r"\\.\{name}")
    }
}
fn connection_name(hub: &Handle, index: u32, code: u32) -> Result<String, String> {
    let mut b = vec![0u8; 8192];
    b[..4].copy_from_slice(&index.to_le_bytes());
    let len = b.len();
    let returned = query(hub, code, &mut b, len)?;
    if returned < 10 {
        return Err("Truncated USB device name".into());
    }
    let actual = u32::from_le_bytes(b[4..8].try_into().map_err(|_| "Invalid USB name")?) as usize;
    if actual > returned || actual < 10 {
        return Err("Invalid USB device name length".into());
    }
    Ok(utf16(&b[8..actual]))
}
fn configuration(hub: &Handle, port: u32, index: u8, length: usize) -> Result<Vec<u8>, String> {
    // USB_DESCRIPTOR_REQUEST: ConnectionIndex + USB setup packet (12 bytes).
    let mut b = vec![0u8; 12 + length];
    b[..4].copy_from_slice(&port.to_le_bytes());
    b[4] = 0x80;
    b[5] = 6;
    b[6] = index;
    b[7] = 2;
    b[10..12].copy_from_slice(&(length as u16).to_le_bytes());
    let len = b.len();
    let returned = query(
        hub,
        IOCTL_USB_GET_DESCRIPTOR_FROM_NODE_CONNECTION,
        &mut b,
        len,
    )?;
    if returned < 12 + length {
        return Err("USB configuration descriptor was truncated".into());
    }
    Ok(b[12..12 + length].to_vec())
}
fn find_in_hub(
    name: &str,
    target: &ComDevice,
    bus: u16,
    depth: usize,
) -> Result<Option<UsbCaptureConfig>, String> {
    if depth > 16 {
        return Err("USB hub nesting limit exceeded".into());
    }
    let hub = open(&hub_path(name), GENERIC_WRITE.0)?;
    let mut b = vec![0u8; size_of::<USB_NODE_INFORMATION>()];
    let len = b.len();
    let returned = query(&hub, IOCTL_USB_GET_NODE_INFORMATION, &mut b, len)?;
    if returned < 7 {
        return Err("Truncated USB hub information".into());
    }
    let ports = b[6]; // NodeType (4), descriptor length/type (2), bNumberOfPorts.
    let mut traversal_error = None;
    for port in 1..=u32::from(ports) {
        let mut info = vec![
            0u8;
            size_of::<USB_NODE_CONNECTION_INFORMATION_EX>()
                + 30 * size_of::<USB_PIPE_INFO>()
        ];
        info[..4].copy_from_slice(&port.to_le_bytes());
        let len = info.len();
        let returned = match query(
            &hub,
            IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX,
            &mut info,
            len,
        ) {
            Ok(n) => n,
            Err(e) => {
                traversal_error = Some(e);
                continue;
            }
        };
        let status = offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, ConnectionStatus);
        if returned < status + 4 || info[status..status + 4] != 1u32.to_le_bytes() {
            continue;
        }
        if info[offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, DeviceIsHub)] != 0 {
            let child = connection_name(&hub, port, IOCTL_USB_GET_NODE_CONNECTION_NAME)
                .and_then(|name| find_in_hub(&name, target, bus, depth + 1));
            match child {
                Ok(Some(found)) => return Ok(Some(found)),
                Err(e) => traversal_error = Some(e),
                Ok(None) => {}
            }
            continue;
        }
        // Unbound/disappearing devices elsewhere on the hub must not prevent
        // discovery of the selected COM device.
        let driver = match connection_name(&hub, port, IOCTL_USB_GET_NODE_CONNECTION_DRIVERKEY_NAME)
        {
            Ok(driver) => driver,
            Err(e) => {
                traversal_error = Some(e);
                continue;
            }
        };
        if !driver.eq_ignore_ascii_case(&target.driver) {
            continue;
        }
        let address_offset = offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, DeviceAddress);
        let address = u16::from_le_bytes([info[address_offset], info[address_offset + 1]]);
        let active = info[offset_of!(
            USB_NODE_CONNECTION_INFORMATION_EX,
            CurrentConfigurationValue
        )];
        let descriptor = offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, DeviceDescriptor);
        let configurations = info[descriptor + 17];
        for index in 0..configurations {
            let header = configuration(&hub, port, index, 9)?;
            if header[5] != active {
                continue;
            }
            let length = u16::from_le_bytes([header[2], header[3]]) as usize;
            if length < 9 {
                return Err("Invalid USB configuration length".into());
            }
            let bytes = configuration(&hub, port, index, length)?;
            let interface = data_interface(&bytes, target.interface)?;
            // Require the chosen endpoints to be present among the active pipes.
            let count_offset = offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, NumberOfOpenPipes);
            let count = u32::from_le_bytes(
                info[count_offset..count_offset + 4]
                    .try_into()
                    .map_err(|_| "Invalid pipe count")?,
            ) as usize;
            let pipe_offset = offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, PipeList);
            if count > 30 || pipe_offset + count * size_of::<USB_PIPE_INFO>() > returned {
                return Err("Invalid USB active pipe list".into());
            }
            let pipes = &info[pipe_offset..pipe_offset + count * size_of::<USB_PIPE_INFO>()];
            let has_pipe = |endpoint, packet_size: Option<usize>| {
                pipes.chunks_exact(size_of::<USB_PIPE_INFO>()).any(|p| {
                    p[2] == endpoint
                        && p[3] & 3 == 2
                        && packet_size.is_none_or(|size| {
                            (u16::from_le_bytes([p[4], p[5]]) & 0x7ff) as usize == size
                        })
                })
            };
            if !has_pipe(interface.input, Some(interface.packet_size))
                || !has_pipe(interface.output, None)
            {
                return Err("USB data interface is not active. Verify the device's alternate setting in Advanced USB settings.".into());
            }
            let vid = u16::from_le_bytes([info[descriptor + 8], info[descriptor + 9]]);
            let pid = u16::from_le_bytes([info[descriptor + 10], info[descriptor + 11]]);
            let profile = if target.service == "ftser2k"
                && vid == 0x0403
                && [0x6001, 0x6010, 0x6011, 0x6014, 0x6015].contains(&pid)
            {
                "ftdi"
            } else if target.service == "usbser" && interface.class == 10 {
                "serial"
            } else {
                "raw"
            };
            return Ok(Some(UsbCaptureConfig {
                bus,
                address,
                in_endpoint: interface.input,
                out_endpoint: interface.output,
                profile: profile.into(),
                packet_size: interface.packet_size,
            }));
        }
        return Err("No active USB configuration found for this COM port.".into());
    }
    match traversal_error {
        Some(e) => Err(e),
        None => Ok(None),
    }
}

pub(super) fn inspect(port: &str, directory: Option<&str>) -> MonitorDiscovery {
    let target = match com_device(port) {
        Ok(t) => t,
        Err(e) => return MonitorDiscovery::failure("unsupported", e),
    };
    if let Err(e) = super::monitor::executable(directory) {
        return MonitorDiscovery::failure("missing_tool", e);
    }
    inspect_device(port, &target)
}

pub(super) fn inspect_driver(port: &str) -> MonitorDiscovery {
    match com_device(port) {
        Ok(target) => inspect_device(port, &target),
        Err(e) => MonitorDiscovery::failure("unsupported", e),
    }
}

fn inspect_device(port: &str, target: &ComDevice) -> MonitorDiscovery {
    let buses = match available_capture_buses() {
        Ok(b) => b,
        Err(e) => {
            return MonitorDiscovery::failure(
                if e.contains("Access denied") {
                    "access_denied"
                } else {
                    "driver_not_ready"
                },
                e,
            )
        }
    };
    let mut last_error = None;
    for bus in buses {
        let result = (|| {
            let filter = open(&format!(r"\\.\USBPcap{bus}"), 0)?;
            let mut b = vec![0u8; 8192];
            let len = query(&filter, 0x0022_200c, &mut b, 0)?; // IOCTL_USBPCAP_GET_HUB_SYMLINK
            if len < 2 {
                return Err("USBPcap returned an empty root hub name".into());
            }
            drop(filter);
            find_in_hub(&utf16(&b[..len]), target, bus, 0)
        })();
        match result {
            Ok(Some(capture)) => {
                if let Err(e) = check_capture_access(bus) {
                    let status = if e.starts_with("Access denied") {
                        "access_denied"
                    } else {
                        "error"
                    };
                    return MonitorDiscovery::failure(status, e);
                }
                let message = if capture.profile == "raw" {
                    format!("{port} identified. Raw USB data; serial payload decoding is not verified for this adapter.")
                } else {
                    format!("{port} identified. USB settings will be refreshed before monitoring.")
                };
                return MonitorDiscovery {
                    status: "ready".into(),
                    message,
                    capture: Some(capture),
                };
            }
            Err(e) => last_error = Some(e),
            Ok(None) => {}
        }
    }
    let message = last_error.unwrap_or_else(|| "The USB device could not be matched to a USBPcap interface. Reconnect it and retry detection.".into());
    MonitorDiscovery::failure(
        if message.contains("Access denied") {
            "access_denied"
        } else {
            "unresolved"
        },
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_usb_layout_matches_wire_offsets() {
        assert_eq!(
            offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, DeviceAddress),
            25
        );
        assert_eq!(offset_of!(USB_NODE_CONNECTION_INFORMATION_EX, PipeList), 35);
        assert_eq!(size_of::<USB_PIPE_INFO>(), 11);
        assert_eq!(hub_path(r"\??\USB#ROOT_HUB30"), r"\\.\USB#ROOT_HUB30");
    }
    #[test]
    fn missing_com_is_not_auto_selected() {
        let report = inspect("COM999999", None);
        assert_eq!(report.status, "unsupported");
        assert!(report.capture.is_none());
        assert!(check_usb_port("COM999999").is_err());
    }

    #[test]
    #[ignore = "read-only diagnostics for ports named in LINKASSIST_MONITOR_PORTS"]
    fn inspect_local_monitor_ports() {
        let ports = std::env::var("LINKASSIST_MONITOR_PORTS")
            .expect("Set LINKASSIST_MONITOR_PORTS to comma-separated COM port names");
        let setup = super::super::usb_discovery::check_setup(None);
        println!("USBPcap setup: {setup:?}");
        for port in ports.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let report = inspect(port, None);
            println!("{port}: {}", serde_json::to_string(&report).unwrap());
            if report.status == "driver_not_ready" {
                assert!(
                    setup.is_err(),
                    "Setup must not succeed without a loaded driver"
                );
            }
            if report.status == "unsupported" {
                assert!(check_usb_port(port).is_err());
                assert!(report.capture.is_none());
            }
        }
    }
}
