//! Read-only COM-to-USB discovery. Descriptor parsing is independent of Windows.
use super::monitor::UsbCaptureConfig;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorDiscovery {
    pub status: String,
    pub message: String,
    pub capture: Option<UsbCaptureConfig>,
}

impl MonitorDiscovery {
    pub fn failure(status: &str, message: impl Into<String>) -> Self {
        Self {
            status: status.into(),
            message: message.into(),
            capture: None,
        }
    }
}

pub fn inspect(path: &str, directory: Option<&str>) -> MonitorDiscovery {
    #[cfg(windows)]
    {
        super::usb_windows::inspect(path, directory)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, directory);
        MonitorDiscovery::failure("unsupported", "USBPcap monitoring requires Windows.")
    }
}

/// Check both the installed tool and loaded capture interfaces without opening COM.
pub fn check_setup(directory: Option<&str>) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("USBPcap monitoring requires Windows.".into());
    }
    let executable = super::monitor::executable(directory)?;
    #[cfg(windows)]
    super::usb_windows::available_capture_buses()
        .map_err(|error| format!("Tool found: {}. {error}", executable.display()))?;
    Ok(executable.to_string_lossy().into_owned())
}

#[derive(Debug, PartialEq)]
pub(super) struct DataInterface {
    pub number: u8,
    pub class: u8,
    pub input: u8,
    pub output: u8,
    pub packet_size: usize,
}

/// Select only a unique data interface. A CDC union associates the COM control
/// interface with its data interface. Never fall back to another interface.
pub(super) fn data_interface(
    bytes: &[u8],
    com_interface: Option<u8>,
) -> Result<DataInterface, String> {
    if bytes.len() < 9 || bytes[0] != 9 || bytes[1] != 2 {
        return Err("Invalid USB configuration descriptor".into());
    }
    let total = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
    if total != bytes.len() {
        return Err("Truncated USB configuration descriptor".into());
    }
    let mut interfaces: Vec<(u8, u8, Vec<(u8, usize)>)> = Vec::new();
    let mut current = None;
    let mut slaves = Vec::new();
    let mut offset = 9;
    while offset < total {
        let len = bytes[offset] as usize;
        if len < 2 || offset + len > total {
            return Err("Malformed USB descriptor length".into());
        }
        let d = &bytes[offset..offset + len];
        match d[1] {
            4 => {
                if len < 9 {
                    return Err("Truncated USB interface descriptor".into());
                }
                // Nonzero alternate settings need an explicit user choice; do
                // not silently assume an alternate setting is currently active.
                current = if d[3] == 0 {
                    interfaces.push((d[2], d[5], Vec::new()));
                    Some(interfaces.len() - 1)
                } else {
                    None
                };
            }
            5 => {
                if len < 7 {
                    return Err("Truncated USB endpoint descriptor".into());
                }
                if let Some(i) = current {
                    if d[3] & 3 == 2 {
                        if d[2] & 0x70 != 0 || d[2] & 15 == 0 {
                            return Err("Invalid bulk endpoint".into());
                        }
                        interfaces[i]
                            .2
                            .push((d[2], (u16::from_le_bytes([d[4], d[5]]) & 0x7ff) as usize));
                    }
                }
            }
            0x24 if len >= 5 && d[2] == 6 && Some(d[3]) == com_interface => {
                slaves.extend_from_slice(&d[4..])
            }
            _ => {}
        }
        offset += len;
    }
    if com_interface.is_none()
        && interfaces
            .iter()
            .filter(|(_, _, endpoints)| !endpoints.is_empty())
            .count()
            > 1
    {
        return Err("Multiple USB data interfaces found; the COM interface cannot be identified uniquely. Verify it in Advanced USB settings.".into());
    }
    let mut matches = Vec::new();
    for (number, class, endpoints) in interfaces {
        if let Some(wanted) = com_interface {
            if number != wanted && !slaves.contains(&number) {
                continue;
            }
        }
        let inputs: Vec<_> = endpoints.iter().filter(|e| e.0 & 0x80 != 0).collect();
        let outputs: Vec<_> = endpoints.iter().filter(|e| e.0 & 0x80 == 0).collect();
        if inputs.len() == 1
            && outputs.len() == 1
            && [8, 16, 32, 64, 512, 1024].contains(&inputs[0].1)
        {
            matches.push(DataInterface {
                number,
                class,
                input: inputs[0].0,
                output: outputs[0].0,
                packet_size: inputs[0].1,
            });
        }
    }
    if matches.len() != 1 {
        return Err("Cannot uniquely identify this COM port's bulk IN/OUT interface. Use Advanced USB settings after verifying the interface in USBPcap/Wireshark.".into());
    }
    Ok(matches.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(parts: &[&[u8]]) -> Vec<u8> {
        let mut b = vec![9, 2, 0, 0, 2, 1, 0, 128, 50];
        for p in parts {
            b.extend_from_slice(p);
        }
        let len = b.len() as u16;
        b[2..4].copy_from_slice(&len.to_le_bytes());
        b
    }
    const A: &[u8] = &[
        9, 4, 0, 0, 2, 255, 0, 0, 0, 7, 5, 129, 2, 64, 0, 0, 7, 5, 2, 2, 64, 0, 0,
    ];
    const B: &[u8] = &[
        9, 4, 1, 0, 2, 10, 0, 0, 0, 7, 5, 131, 2, 0, 2, 0, 7, 5, 4, 2, 0, 2, 0,
    ];
    #[test]
    fn single_and_composite_interfaces() {
        assert_eq!(data_interface(&config(&[A]), None).unwrap().input, 129);
        assert!(data_interface(&config(&[A, B]), None).is_err());
        let selected = data_interface(&config(&[A, B]), Some(1)).unwrap();
        assert_eq!(
            (selected.input, selected.output, selected.packet_size),
            (131, 4, 512)
        );
        assert!(data_interface(&config(&[A]), Some(1)).is_err());
    }
    #[test]
    fn cdc_union_selects_data_interface() {
        let control = &[
            9, 4, 0, 0, 1, 2, 2, 1, 0, 5, 0x24, 6, 0, 1, 7, 5, 129, 3, 16, 0, 1,
        ];
        assert_eq!(
            data_interface(&config(&[control, B]), Some(0))
                .unwrap()
                .number,
            1
        );
    }
    #[test]
    fn rejects_malformed_and_ambiguous_descriptors() {
        for size in 0..A.len() {
            assert!(data_interface(&config(&[&A[..size]]), None).is_err());
        }
        assert!(data_interface(&config(&[A, &[0, 5]]), None).is_err());
        assert!(data_interface(&config(&[A, &[7, 5, 130, 2, 64, 0, 0]]), None).is_err());
        let mut alternate = A.to_vec();
        alternate[3] = 1;
        assert!(data_interface(&config(&[&alternate]), None).is_err());
    }
}
