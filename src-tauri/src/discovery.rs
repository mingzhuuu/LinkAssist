use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Instant};

pub const CORE_BIND_ADDR: &str = "127.0.0.1:0";
const CORE_START_TIMEOUT: Duration = Duration::from_secs(10);
const CORE_START_POLL_INTERVAL: Duration = Duration::from_millis(100);
const EXPLICIT_SHUTDOWN_GRACE_SECS: u64 = 5;

pub struct CoreInstanceLock {
    file: File,
}

impl Drop for CoreInstanceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreDiscovery {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    pub mode: String,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExplicitShutdownMarker {
    core_pid: u32,
    requested_at: u64,
}

impl CoreDiscovery {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub async fn write_discovery(port: u16, token: String, mode: &str) -> AppResult<CoreDiscovery> {
    let discovery = CoreDiscovery {
        pid: std::process::id(),
        port,
        token,
        mode: mode.to_string(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    write_discovery_file(&discovery).await?;
    Ok(discovery)
}

async fn write_discovery_file(discovery: &CoreDiscovery) -> AppResult<()> {
    let path = discovery_path()?;
    write_private_discovery(&path, serde_json::to_vec_pretty(discovery)?).await
}

async fn write_private_discovery(path: &Path, json: Vec<u8>) -> AppResult<()> {
    use tokio::io::AsyncWriteExt;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    // Permissions apply at creation, before the token is ever written.
    #[cfg(unix)]
    options.mode(0o600);
    let result = async {
        let mut file = options.open(&temporary).await?;
        file.write_all(&json).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result?;
    Ok(())
}

#[cfg(all(test, unix))]
mod private_discovery_tests {
    use super::write_private_discovery;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn discovery_token_is_owner_only_on_creation_and_replacement() {
        let root = std::env::temp_dir().join(format!("linkassist-private-{}", uuid::Uuid::new_v4()));
        let path = root.join("core-discovery.json");
        for contents in [b"first".to_vec(), b"second".to_vec()] {
            write_private_discovery(&path, contents.clone()).await.unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), contents);
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub async fn read_discovery() -> Option<CoreDiscovery> {
    let path = discovery_path().ok()?;
    let json = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&json).ok()
}

pub async fn update_discovery_mode(pid: u32, token: &str, mode: &str) -> AppResult<()> {
    let Some(mut discovery) = read_discovery().await else {
        return Ok(());
    };
    if discovery.pid != pid || discovery.token != token {
        return Ok(());
    }
    discovery.mode = mode.to_string();
    write_discovery_file(&discovery).await
}

pub async fn remove_discovery_if_owner(pid: u32, token: &str) -> AppResult<()> {
    let Some(discovery) = read_discovery().await else {
        return Ok(());
    };
    if discovery.pid != pid || discovery.token != token {
        return Ok(());
    }
    let path = discovery_path()?;
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

pub fn try_acquire_core_instance_lock() -> AppResult<Option<CoreInstanceLock>> {
    let directory = discovery_directory();
    std::fs::create_dir_all(&directory)?;
    try_acquire_core_instance_lock_at(&directory.join("core.lock"))
}

pub fn mark_explicit_shutdown_sync() -> AppResult<()> {
    let path = explicit_shutdown_marker_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let marker = ExplicitShutdownMarker {
        core_pid: std::process::id(),
        requested_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    std::fs::write(path, serde_json::to_vec(&marker)?)?;
    Ok(())
}

pub fn explicit_shutdown_in_progress() -> bool {
    explicit_shutdown_in_progress_at(&explicit_shutdown_marker_path(), process_is_running)
}

pub fn clear_explicit_shutdown_sync() -> AppResult<()> {
    match std::fs::remove_file(explicit_shutdown_marker_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

fn explicit_shutdown_in_progress_at<F>(path: &Path, is_running: F) -> bool
where
    F: FnOnce(u32) -> bool,
{
    let marker = std::fs::read(path)
        .ok()
        .and_then(|json| serde_json::from_slice::<ExplicitShutdownMarker>(&json).ok());
    let Some(marker) = marker else {
        let _ = std::fs::remove_file(path);
        return false;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if is_running(marker.core_pid)
        || marker.requested_at.abs_diff(now) <= EXPLICIT_SHUTDOWN_GRACE_SECS
    {
        return true;
    }
    let _ = std::fs::remove_file(path);
    false
}

fn try_acquire_core_instance_lock_at(path: &Path) -> AppResult<Option<CoreInstanceLock>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(CoreInstanceLock { file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(AppError::Io(error)),
    }
}

pub async fn core_is_healthy(discovery: &CoreDiscovery) -> bool {
    // A normal desktop shutdown can end the process before the HTTP task gets
    // a chance to remove the discovery file. On Windows, reject that stale PID
    // immediately instead of spending the full request timeout on a dead port
    // during the next application launch.
    if !process_is_running(discovery.pid) {
        return false;
    }

    let client = reqwest::Client::new();
    match client
        .get(format!("{}/health", discovery.base_url()))
        .bearer_auth(&discovery.token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

pub async fn post_core_control(discovery: &CoreDiscovery, path: &str) -> AppResult<()> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}{}", discovery.base_url(), path))
        .bearer_auth(&discovery.token)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| AppError::Tcp(format!("Core control request failed: {}", error)))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(AppError::Tcp(format!(
            "Core control request failed with status {}",
            response.status()
        )))
    }
}

pub async fn ensure_core_running() -> AppResult<(CoreDiscovery, Option<Child>)> {
    if explicit_shutdown_in_progress() {
        return Err(AppError::Protocol(
            "LinkAssist is closing after an explicit tray request".to_string(),
        ));
    }
    if let Some(discovery) = read_discovery().await {
        if core_is_healthy(&discovery).await {
            return Ok((discovery, None));
        }
    }

    let deadline = Instant::now() + CORE_START_TIMEOUT;
    let mut child = None;
    loop {
        if Instant::now() >= deadline {
            break;
        }

        if let Err(error) = refresh_core_candidate(
            &mut child,
            |child| {
                child
                    .try_wait()
                    .map(|status| status.is_some())
                    .map_err(AppError::Io)
            },
            spawn_headless_core,
        ) {
            if let Some(mut child) = child.take() {
                stop_and_reap_child(&mut child);
            }
            return Err(error);
        }

        if let Some(discovery) = read_discovery().await {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let is_healthy = !remaining.is_zero()
                && tokio::time::timeout(remaining, core_is_healthy(&discovery))
                    .await
                    .unwrap_or(false);
            if is_healthy {
                if child
                    .as_ref()
                    .is_some_and(|candidate| discovery.pid == candidate.id())
                {
                    return Ok((discovery, child.take()));
                }
                if let Some(mut child) = child.take() {
                    stop_and_reap_child(&mut child);
                }
                return Ok((discovery, None));
            }
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        sleep(CORE_START_POLL_INTERVAL.min(remaining)).await;
    }

    if let Some(mut child) = child {
        stop_and_reap_child(&mut child);
    }
    Err(AppError::Tcp(
        "Timed out waiting for Core daemon to become healthy".to_string(),
    ))
}

fn refresh_core_candidate<C, IsExited, Spawn>(
    candidate: &mut Option<C>,
    mut is_exited: IsExited,
    mut spawn: Spawn,
) -> AppResult<()>
where
    IsExited: FnMut(&mut C) -> AppResult<bool>,
    Spawn: FnMut() -> AppResult<C>,
{
    let needs_spawn = match candidate.as_mut() {
        Some(candidate) => is_exited(candidate)?,
        None => true,
    };
    if needs_spawn {
        candidate.take();
        *candidate = Some(spawn()?);
    }
    Ok(())
}

fn spawn_headless_core() -> AppResult<Child> {
    let exe = std::env::current_exe()?;
    Command::new(exe)
        .arg("--core-headless")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(AppError::Io)
}

fn stop_and_reap_child(child: &mut Child) {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn discovery_path() -> AppResult<PathBuf> {
    Ok(discovery_directory().join("core-discovery.json"))
}

fn explicit_shutdown_marker_path() -> PathBuf {
    discovery_directory().join("explicit-shutdown.json")
}

fn discovery_directory() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    let directory = base.join("LinkAssist");
    match crate::snapshot::instance_key() {
        Some(snapshot_id) => directory.join("Snapshots").join(snapshot_id).join("core"),
        None => directory,
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn process_is_running(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };

        let mut exit_code = 0;
        let is_running = GetExitCodeProcess(process, &mut exit_code).is_ok()
            && exit_code == STILL_ACTIVE.0 as u32;
        let _ = CloseHandle(process);
        is_running
    }
}

pub fn remove_discovery_for_current_process_sync() -> AppResult<()> {
    let path = discovery_path()?;
    let discovery = match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str::<CoreDiscovery>(&json)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::Io(error)),
    };
    if discovery.pid != std::process::id() {
        return Ok(());
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn process_is_running(_pid: u32) -> bool {
    // Other platforms retain the HTTP health check as the source of truth.
    true
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        explicit_shutdown_in_progress_at, process_is_running, refresh_core_candidate,
        try_acquire_core_instance_lock_at, ExplicitShutdownMarker,
    };
    use std::cell::Cell;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct FakeCandidate {
        id: u32,
        exited: bool,
    }

    #[test]
    fn detects_live_and_missing_processes() {
        assert!(process_is_running(std::process::id()));
        assert!(!process_is_running(u32::MAX));
    }

    #[test]
    fn core_instance_lock_is_exclusive_and_released_on_drop() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-core-lock-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("core.lock");

        let first = try_acquire_core_instance_lock_at(&path)
            .unwrap()
            .expect("first lock should be acquired");
        assert!(try_acquire_core_instance_lock_at(&path).unwrap().is_none());

        drop(first);
        let second = try_acquire_core_instance_lock_at(&path)
            .unwrap()
            .expect("lock should be released after the guard is dropped");
        drop(second);

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_shutdown_marker_covers_live_core_and_exit_grace() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-explicit-shutdown-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("explicit-shutdown.json");
        let marker = ExplicitShutdownMarker {
            core_pid: 42,
            requested_at: 1,
        };
        std::fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();

        assert!(explicit_shutdown_in_progress_at(&path, |pid| pid == 42));
        assert!(path.exists());
        assert!(!explicit_shutdown_in_progress_at(&path, |_| false));
        assert!(!path.exists());

        let marker = ExplicitShutdownMarker {
            core_pid: 42,
            requested_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        };
        std::fs::write(&path, serde_json::to_vec(&marker).unwrap()).unwrap();
        assert!(explicit_shutdown_in_progress_at(&path, |_| false));
        assert!(path.exists());

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn exited_core_candidate_is_retried_without_parallel_spawn() {
        let spawn_count = Cell::new(0_u32);
        let mut candidate = None;

        refresh_core_candidate(
            &mut candidate,
            |candidate: &mut FakeCandidate| Ok(candidate.exited),
            || {
                let id = spawn_count.get() + 1;
                spawn_count.set(id);
                Ok(FakeCandidate { id, exited: false })
            },
        )
        .unwrap();
        assert_eq!(candidate.as_ref().unwrap().id, 1);
        assert_eq!(spawn_count.get(), 1);

        // A still-running candidate is retained, so polling never creates
        // concurrent candidates.
        refresh_core_candidate(
            &mut candidate,
            |candidate: &mut FakeCandidate| Ok(candidate.exited),
            || {
                let id = spawn_count.get() + 1;
                spawn_count.set(id);
                Ok(FakeCandidate { id, exited: false })
            },
        )
        .unwrap();
        assert_eq!(candidate.as_ref().unwrap().id, 1);
        assert_eq!(spawn_count.get(), 1);

        // A lock-losing --core-headless child exits quickly. The next poll
        // replaces it, allowing a later attempt to acquire the released lock.
        candidate.as_mut().unwrap().exited = true;
        refresh_core_candidate(
            &mut candidate,
            |candidate: &mut FakeCandidate| Ok(candidate.exited),
            || {
                let id = spawn_count.get() + 1;
                spawn_count.set(id);
                Ok(FakeCandidate { id, exited: false })
            },
        )
        .unwrap();
        assert_eq!(candidate.as_ref().unwrap().id, 2);
        assert_eq!(spawn_count.get(), 2);
    }
}
