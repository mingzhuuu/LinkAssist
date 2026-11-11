//! One elevated capture per request. The helper only maps COM and reads USBPcap.
use super::{monitor::UsbCaptureConfig, usb_windows};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    os::windows::ffi::OsStrExt,
    time::{Duration, Instant},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, ERROR_CANCELLED, WAIT_TIMEOUT},
        System::Threading::WaitForSingleObject,
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
                SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
};

pub(crate) const CANCELLED: &str = "Monitor permission request canceled.";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);

pub(super) fn start(
    port: &str,
    manual: Option<&UsbCaptureConfig>,
) -> Result<(UsbCaptureConfig, BufReader<TcpStream>), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let socket_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let helper_token = uuid::Uuid::new_v4().simple().to_string();
    let parent_token = uuid::Uuid::new_v4().simple().to_string();
    let mut args =
        format!("--serial-monitor-helper {socket_port} {helper_token}{parent_token} {port}");
    if let Some(cfg) = manual {
        args.push_str(&format!(
            " {} {} {} {} {} {}",
            cfg.bus, cfg.address, cfg.in_endpoint, cfg.out_endpoint, cfg.profile, cfg.packet_size
        ));
    }
    let args: Vec<u16> = args.encode_utf16().chain(Some(0)).collect();
    let executable: Vec<u16> = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut launch = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut launch) }.map_err(|e| {
        if e.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
            CANCELLED.into()
        } else {
            format!("Could not request USB capture permission: {e}")
        }
    })?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let connection = loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                // Winsock accepted sockets inherit the listener's nonblocking mode.
                if let Err(e) = stream.set_nonblocking(false) {
                    break Err(e.to_string());
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break Err("The USB capture helper did not connect in time.".into());
                }
                let mut received = [0u8; 32];
                if stream.set_read_timeout(Some(remaining)).is_ok()
                    && stream.read_exact(&mut received).is_ok()
                    && received == helper_token.as_bytes()
                {
                    if let Err(e) = stream.write_all(parent_token.as_bytes()) {
                        break Err(e.to_string());
                    }
                    break Ok(stream);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !launch.hProcess.is_invalid()
                    && unsafe { WaitForSingleObject(launch.hProcess, 0) } != WAIT_TIMEOUT
                {
                    break Err("The USB capture helper exited before connecting.".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => break Err(e.to_string()),
        }
        if Instant::now() >= deadline {
            break Err("The USB capture helper did not connect in time.".into());
        }
    };
    if !launch.hProcess.is_invalid() {
        let _ = unsafe { CloseHandle(launch.hProcess) };
    }
    let stream = connection?;
    stream
        .set_read_timeout(Some(STARTUP_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let mut response = Vec::new();
    (&mut reader)
        .take(8192)
        .read_until(b'\n', &mut response)
        .map_err(|e| format!("USB capture setup did not complete: {e}"))?;
    let capture: Result<UsbCaptureConfig, String> = serde_json::from_slice(&response)
        .map_err(|_| "The USB capture helper returned an invalid startup response.")?;
    let capture = capture?;
    capture.validate()?;
    reader
        .get_ref()
        .set_read_timeout(None)
        .map_err(|e| e.to_string())?;
    Ok((capture, reader))
}

pub fn run_serial_monitor_helper(args: &[String]) -> Result<(), String> {
    let [socket_port, token, port, manual @ ..] = args else {
        return Err("Invalid USB capture helper arguments.".into());
    };
    let socket_port = socket_port.parse::<u16>().map_err(|e| e.to_string())?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid USB capture session token.".into());
    }
    super::monitor::validate_com_name(port)?;
    let mut stream =
        TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, socket_port).into(), STARTUP_TIMEOUT)
            .map_err(|e| e.to_string())?;
    let (helper_token, parent_token) = token.split_at(32);
    stream
        .set_read_timeout(Some(STARTUP_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .write_all(helper_token.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut received = [0; 32];
    stream
        .read_exact(&mut received)
        .map_err(|e| e.to_string())?;
    if received != parent_token.as_bytes() {
        return Err("The USB capture parent could not be verified.".into());
    }
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;

    // Closing the parent socket stops even an idle capture blocked in ReadFile.
    let mut parent = stream.try_clone().map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("usbpcap-parent".into())
        .spawn(move || {
            let _ = parent.read(&mut [0]);
            std::process::exit(0);
        })
        .map_err(|e| e.to_string())?;

    let capture: Result<_, String> = (|| {
        let cfg = match manual {
            [] => {
                let report = usb_windows::inspect_driver(port);
                report.capture.ok_or(report.message)?
            }
            [bus, address, input, output, profile, packet_size] => {
                usb_windows::check_usb_port(port)?;
                UsbCaptureConfig {
                    bus: bus.parse().map_err(|_| "Invalid USBPcap bus")?,
                    address: address.parse().map_err(|_| "Invalid USB device address")?,
                    in_endpoint: input.parse().map_err(|_| "Invalid USB IN endpoint")?,
                    out_endpoint: output.parse().map_err(|_| "Invalid USB OUT endpoint")?,
                    profile: profile.clone(),
                    packet_size: packet_size.parse().map_err(|_| "Invalid USB packet size")?,
                }
            }
            _ => return Err("Invalid USB capture parameters.".into()),
        };
        cfg.validate()?;
        let reader = usb_windows::open_capture(&cfg)?;
        Ok((cfg, reader))
    })();
    let response = capture.as_ref().map(|(cfg, _)| cfg);
    serde_json::to_writer(&mut stream, &response).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())?;
    let (_, mut reader) = capture?;
    std::io::copy(&mut reader, &mut stream).map_err(|e| e.to_string())?;
    Ok(())
}
