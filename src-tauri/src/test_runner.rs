use crate::mcp_tool_script::ScriptExecutionRegistry;
use crate::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, RwLock, Semaphore};
use uuid::Uuid;

const MAX_LOG_EVENTS: usize = 2_000;
const MAX_PENDING_PROCESS_LINES: usize = 256;
const MAX_LOG_LINE_CHARS: usize = 65_536;
const MAX_RUN_HISTORY: usize = 50;
// Until profiles declare explicit build/device resources, one global slot is the only safe
// default: two projects can still point at the same Core, BLE adapter, device, or build tree.
const MAX_CONCURRENT_RUNS: usize = 1;
const CATALOG_TIMEOUT_MS: u64 = 30_000;
const MAX_CATALOG_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const BUSINESS_CANCEL_GRACE_MS: u64 = 3_000;
const PROCESS_CANCEL_WAIT_MS: u64 = 5_000;
const CORE_CANCEL_TOKEN_LINGER_MS: u64 = 30_000;
const TEST_RUN_EVENT_NAME: &str = "test-run-event";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerLocationRequest {
    pub project_root: String,
    #[serde(default)]
    pub python_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTestRunRequest {
    pub project_root: String,
    #[serde(default)]
    pub python_path: Option<String>,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub node_ids: Vec<String>,
    #[serde(default)]
    pub inputs: HashMap<String, String>,
    #[serde(default)]
    pub allow_destructive: bool,
    #[serde(default)]
    pub catalog_revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunIdRequest {
    pub run_id: String,
    #[serde(default)]
    pub after_seq: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerProfile {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub marker_expression: Option<String>,
    #[serde(default = "default_safe_danger")]
    pub danger: TestDanger,
    #[serde(default)]
    pub required_inputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestInputType {
    Text,
    Password,
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestInputDefinition {
    #[serde(rename = "type")]
    pub input_type: TestInputType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist: Option<bool>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub extensions: Vec<String>,
}

fn default_safe_danger() -> TestDanger {
    TestDanger::Safe
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestDanger {
    Safe,
    Read,
    Write,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TestRequirement {
    Name(String),
    Detail(TestRequirementDetail),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestRequirementDetail {
    pub name: String,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerCase {
    pub node_id: String,
    pub id: String,
    pub title: String,
    pub kind: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub requires: Vec<TestRequirement>,
    #[serde(default)]
    pub required_inputs: Vec<String>,
    pub file: String,
    #[serde(default = "default_safe_danger")]
    pub danger: TestDanger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunnerCatalog {
    pub schema_version: u32,
    pub runner_id: String,
    pub title: String,
    #[serde(default)]
    pub catalog_revision: Option<String>,
    #[serde(default)]
    pub package_revision: Option<String>,
    #[serde(default)]
    pub project_root: Option<String>,
    #[serde(default)]
    pub input_definitions: HashMap<String, TestInputDefinition>,
    #[serde(default)]
    pub profiles: Vec<TestRunnerProfile>,
    #[serde(default)]
    pub tests: Vec<TestRunnerCase>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestRunStatus {
    Queued,
    Running,
    Passed,
    Failed,
    Blocked,
    Cancelled,
    Error,
}

impl TestRunStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Passed | Self::Failed | Self::Blocked | Self::Cancelled | Self::Error
        )
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "passed" => Some(Self::Passed),
            "failed" => Some(Self::Failed),
            "blocked" => Some(Self::Blocked),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            "error" | "errored" => Some(Self::Error),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunLogEvent {
    pub run_id: String,
    pub seq: u64,
    pub event_type: String,
    pub timestamp: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSnapshot {
    pub run_id: String,
    pub status: TestRunStatus,
    pub project_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    pub node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Value>,
    pub logs: VecDeque<TestRunLogEvent>,
}

#[derive(Debug)]
struct ManagedRun {
    snapshot: TestRunSnapshot,
    process_id: Option<u32>,
    cancel_requested: bool,
    termination_succeeded: bool,
    next_sequence: u64,
    saw_finish_event: bool,
}

#[derive(Debug, Default)]
struct TestRunState {
    runs: HashMap<String, ManagedRun>,
}

#[derive(Clone)]
pub struct TestRunManager {
    state: Arc<RwLock<TestRunState>>,
    active_slots: Arc<Semaphore>,
    active_projects: Arc<Mutex<HashSet<PathBuf>>>,
    script_executions: ScriptExecutionRegistry,
}

impl Default for TestRunManager {
    fn default() -> Self {
        Self {
            state: Arc::new(RwLock::new(TestRunState::default())),
            active_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_RUNS)),
            active_projects: Arc::new(Mutex::new(HashSet::new())),
            script_executions: ScriptExecutionRegistry::default(),
        }
    }
}

struct ProjectRunPermit {
    project_root: PathBuf,
    active_projects: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Drop for ProjectRunPermit {
    fn drop(&mut self) {
        if let Ok(mut active_projects) = self.active_projects.lock() {
            active_projects.remove(&self.project_root);
        }
    }
}

#[derive(Debug)]
struct ResolvedRunner {
    project_root: PathBuf,
    python_path: PathBuf,
    bridge_path: PathBuf,
}

#[derive(Debug)]
struct ProcessLine {
    stream: &'static str,
    line: String,
}

impl TestRunManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_script_execution_registry(
        script_executions: ScriptExecutionRegistry,
    ) -> Self {
        Self {
            script_executions,
            ..Self::default()
        }
    }

    pub async fn load_catalog(
        &self,
        request: TestRunnerLocationRequest,
    ) -> AppResult<TestRunnerCatalog> {
        let runner = resolve_runner(&request.project_root, request.python_path.as_deref())?;
        let mut command = runner_command(&runner);
        command.arg("catalog").arg("--json").kill_on_drop(true);
        configure_process_group(&mut command);
        let output = tokio::time::timeout(
            std::time::Duration::from_millis(CATALOG_TIMEOUT_MS),
            command.output(),
        )
        .await
        .map_err(|_| {
            AppError::TestRunner(format!(
                "Test catalog exceeded the {CATALOG_TIMEOUT_MS} ms timeout"
            ))
        })?
        .map_err(|error| {
            AppError::TestRunner(format!(
                "Failed to start pytest catalog bridge '{}': {error}",
                runner.python_path.display()
            ))
        })?;
        if output.stdout.len() > MAX_CATALOG_OUTPUT_BYTES
            || output.stderr.len() > MAX_CATALOG_OUTPUT_BYTES
        {
            return Err(AppError::TestRunner(format!(
                "Test catalog output exceeded the {} byte limit",
                MAX_CATALOG_OUTPUT_BYTES
            )));
        }
        if !output.status.success() {
            return Err(AppError::TestRunner(format!(
                "Test catalog failed with exit code {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut catalog: TestRunnerCatalog =
            serde_json::from_str(stdout.trim()).map_err(|error| {
                AppError::TestRunner(format!("Test catalog returned invalid JSON: {error}"))
            })?;
        if catalog.schema_version != 1 {
            return Err(AppError::TestRunner(format!(
                "Unsupported test catalog schema version {}",
                catalog.schema_version
            )));
        }
        validate_catalog(&catalog)?;
        catalog.project_root = Some(path_for_frontend(&runner.project_root));
        Ok(catalog)
    }

    pub async fn start_run(
        &self,
        app_handle: Option<AppHandle>,
        request: StartTestRunRequest,
    ) -> AppResult<TestRunSnapshot> {
        validate_start_request(&request)?;
        let active_slot = self.active_slots.clone().try_acquire_owned().map_err(|_| {
            AppError::TestRunner(format!(
                "At most {MAX_CONCURRENT_RUNS} test runs can execute concurrently"
            ))
        })?;
        let runner = resolve_runner(&request.project_root, request.python_path.as_deref())?;
        let project_permit = self.reserve_project(&runner.project_root)?;
        let run_id = Uuid::new_v4().to_string();
        let execution_token = self.script_executions.reserve(&run_id)?;
        let started_at = now_ms();
        let project_root = path_for_frontend(&runner.project_root);

        let mut command = runner_command(&runner);
        command
            .arg("run")
            .arg("--run-id")
            .arg(&run_id)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(profile) = request.profile.as_deref() {
            command.arg("--profile").arg(profile);
        }
        for node_id in &request.node_ids {
            command.arg("--node-id").arg(node_id);
        }
        let mut inputs = request.inputs.iter().collect::<Vec<_>>();
        inputs.sort_by(|left, right| left.0.cmp(right.0));
        for (name, value) in inputs {
            command.arg("--input").arg(format!("{name}={value}"));
        }
        if request.allow_destructive {
            command.arg("--allow-destructive");
        }
        if let Some(revision) = request.catalog_revision.as_deref() {
            command.arg("--catalog-revision").arg(revision);
        }

        configure_process_group(&mut command);
        let mut child = command.spawn().map_err(|error| {
            AppError::TestRunner(format!(
                "Failed to start pytest bridge '{}': {error}",
                runner.python_path.display()
            ))
        })?;
        let process_id = child.id();
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::TestRunner("Failed to capture pytest bridge stdout".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AppError::TestRunner("Failed to capture pytest bridge stderr".to_string())
        })?;

        let snapshot = TestRunSnapshot {
            run_id: run_id.clone(),
            status: TestRunStatus::Running,
            project_root,
            profile: request.profile,
            node_ids: request.node_ids,
            started_at: Some(started_at),
            finished_at: None,
            exit_code: None,
            summary: None,
            logs: VecDeque::new(),
        };
        {
            let mut state = self.state.write().await;
            trim_run_history(&mut state);
            state.runs.insert(
                run_id.clone(),
                ManagedRun {
                    snapshot: snapshot.clone(),
                    process_id,
                    cancel_requested: false,
                    termination_succeeded: false,
                    next_sequence: 0,
                    saw_finish_event: false,
                },
            );
        }

        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager
                .monitor_process(app_handle, run_id, child, stdout, stderr)
                .await;
            drop(active_slot);
            drop(project_permit);
            // A killed HTTP client does not cancel an already-dispatched Core task. Keep a
            // cancelled token alive briefly so a Lua task still loading its script attaches to
            // the same asserted token instead of creating a fresh one.
            if execution_token.is_cancelled() {
                tokio::time::sleep(std::time::Duration::from_millis(
                    CORE_CANCEL_TOKEN_LINGER_MS,
                ))
                .await;
            }
        });
        Ok(snapshot)
    }

    fn reserve_project(&self, project_root: &Path) -> AppResult<ProjectRunPermit> {
        let mut active_projects = self.active_projects.lock().map_err(|_| {
            AppError::TestRunner("The test runner project lock is unavailable".to_string())
        })?;
        let project_root = project_root.to_path_buf();
        if !active_projects.insert(project_root.clone()) {
            return Err(AppError::TestRunner(format!(
                "Another test run is already active for project '{}'",
                project_root.display()
            )));
        }
        drop(active_projects);
        Ok(ProjectRunPermit {
            project_root,
            active_projects: self.active_projects.clone(),
        })
    }

    pub async fn get_run(&self, run_id: &str) -> AppResult<TestRunSnapshot> {
        let state = self.state.read().await;
        state
            .runs
            .get(run_id)
            .map(|run| run.snapshot.clone())
            .ok_or_else(|| AppError::TestRunner(format!("Unknown test run '{run_id}'")))
    }

    pub async fn get_run_since(
        &self,
        run_id: &str,
        after_seq: Option<u64>,
        limit: Option<usize>,
    ) -> AppResult<TestRunSnapshot> {
        let mut snapshot = self.get_run(run_id).await?;
        if let Some(after_seq) = after_seq {
            snapshot.logs.retain(|event| event.seq > after_seq);
        }
        if let Some(limit) = limit {
            let limit = limit.clamp(1, MAX_LOG_EVENTS);
            snapshot.logs.truncate(limit);
        }
        Ok(snapshot)
    }

    pub async fn list_runs(&self) -> Vec<TestRunSnapshot> {
        let state = self.state.read().await;
        let mut runs = state
            .runs
            .values()
            .map(|run| {
                let mut snapshot = run.snapshot.clone();
                snapshot.logs.clear();
                snapshot
            })
            .collect::<Vec<_>>();
        runs.sort_by_key(|run| std::cmp::Reverse(run.started_at.unwrap_or_default()));
        runs
    }

    pub async fn cancel_run(&self, run_id: &str) -> AppResult<TestRunSnapshot> {
        let process_id = {
            let mut state = self.state.write().await;
            let run = state
                .runs
                .get_mut(run_id)
                .ok_or_else(|| AppError::TestRunner(format!("Unknown test run '{run_id}'")))?;
            if run.snapshot.status.is_terminal() {
                return Ok(run.snapshot.clone());
            }
            run.cancel_requested = true;
            run.process_id
        };
        self.script_executions.cancel(run_id)?;

        if let Some(snapshot) = self
            .wait_for_terminal(run_id, BUSINESS_CANCEL_GRACE_MS)
            .await?
        {
            return Ok(snapshot);
        }

        if let Some(process_id) = process_id {
            let termination_succeeded = terminate_process_tree(process_id).await;
            let mut state = self.state.write().await;
            if let Some(run) = state.runs.get_mut(run_id) {
                run.termination_succeeded = termination_succeeded;
            }
        }
        if let Some(snapshot) = self
            .wait_for_terminal(run_id, PROCESS_CANCEL_WAIT_MS)
            .await?
        {
            return Ok(snapshot);
        }
        self.get_run(run_id).await
    }

    async fn wait_for_terminal(
        &self,
        run_id: &str,
        timeout_ms: u64,
    ) -> AppResult<Option<TestRunSnapshot>> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
        loop {
            let snapshot = self.get_run(run_id).await?;
            if snapshot.status.is_terminal() {
                return Ok(Some(snapshot));
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    async fn monitor_process(
        &self,
        app_handle: Option<AppHandle>,
        run_id: String,
        mut child: tokio::process::Child,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
    ) {
        let (line_tx, mut line_rx) = mpsc::channel::<ProcessLine>(MAX_PENDING_PROCESS_LINES);
        spawn_line_reader(stdout, "stdout", line_tx.clone());
        spawn_line_reader(stderr, "stderr", line_tx.clone());
        drop(line_tx);

        let mut wait = Box::pin(child.wait());
        let mut exit_status: Option<std::io::Result<std::process::ExitStatus>> = None;
        let mut streams_closed = false;
        while exit_status.is_none() || !streams_closed {
            tokio::select! {
                status = &mut wait, if exit_status.is_none() => {
                    exit_status = Some(status);
                }
                line = line_rx.recv(), if !streams_closed => {
                    match line {
                        Some(line) => self.accept_line(app_handle.as_ref(), &run_id, line).await,
                        None => streams_closed = true,
                    }
                }
            }
        }

        let exit_code = match exit_status {
            Some(Ok(status)) => status.code(),
            Some(Err(error)) => {
                self.append_synthetic_log(
                    app_handle.as_ref(),
                    &run_id,
                    "stderr",
                    format!("Failed while waiting for pytest bridge: {error}"),
                )
                .await;
                None
            }
            None => None,
        };
        self.finish_run(app_handle.as_ref(), &run_id, exit_code)
            .await;
    }

    async fn accept_line(&self, app_handle: Option<&AppHandle>, run_id: &str, line: ProcessLine) {
        if line.line.is_empty() {
            return;
        }
        let event = {
            let mut state = self.state.write().await;
            let Some(run) = state.runs.get_mut(run_id) else {
                return;
            };
            run.next_sequence = run.next_sequence.saturating_add(1);
            event_from_line(run_id, run.next_sequence, line.stream, &line.line)
        };
        self.record_event(app_handle, event).await;
    }

    async fn append_synthetic_log(
        &self,
        app_handle: Option<&AppHandle>,
        run_id: &str,
        stream: &str,
        message: String,
    ) {
        let event = {
            let mut state = self.state.write().await;
            let Some(run) = state.runs.get_mut(run_id) else {
                return;
            };
            run.next_sequence = run.next_sequence.saturating_add(1);
            TestRunLogEvent {
                run_id: run_id.to_string(),
                seq: run.next_sequence,
                event_type: "log".to_string(),
                timestamp: now_ms(),
                message: Some(message),
                stream: Some(stream.to_string()),
                case_id: None,
                node_id: None,
                outcome: None,
                data: None,
            }
        };
        self.record_event(app_handle, event).await;
    }

    async fn record_event(&self, app_handle: Option<&AppHandle>, event: TestRunLogEvent) {
        {
            let mut state = self.state.write().await;
            let Some(run) = state.runs.get_mut(&event.run_id) else {
                return;
            };
            if event.event_type == "run-finish" {
                run.saw_finish_event = true;
                if let Some(data) = event.data.as_ref() {
                    if let Some(summary) = data.get("summary") {
                        run.snapshot.summary = Some(summary.clone());
                    }
                    if let Some(exit_code) = data.get("exitCode").and_then(Value::as_i64) {
                        run.snapshot.exit_code = i32::try_from(exit_code).ok();
                    }
                    if let Some(status) = data
                        .get("status")
                        .and_then(Value::as_str)
                        .and_then(TestRunStatus::parse)
                    {
                        run.snapshot.status = status;
                    }
                }
                if let Some(status) = event.outcome.as_deref().and_then(TestRunStatus::parse) {
                    run.snapshot.status = status;
                }
            }
            run.snapshot.logs.push_back(event.clone());
            while run.snapshot.logs.len() > MAX_LOG_EVENTS {
                run.snapshot.logs.pop_front();
            }
        }
        if let Some(app_handle) = app_handle {
            let _ = app_handle.emit(TEST_RUN_EVENT_NAME, &event);
        }
    }

    async fn finish_run(
        &self,
        app_handle: Option<&AppHandle>,
        run_id: &str,
        exit_code: Option<i32>,
    ) {
        let synthetic = {
            let mut state = self.state.write().await;
            let Some(run) = state.runs.get_mut(run_id) else {
                return;
            };
            run.process_id = None;
            let event_exit_code = run.snapshot.exit_code;
            let event_status = run.snapshot.status;
            run.snapshot.exit_code = exit_code.or(event_exit_code);
            run.snapshot.finished_at = Some(now_ms());
            let cancelled = run.cancel_requested
                && (run.termination_succeeded
                    || exit_code != Some(0)
                    || event_status == TestRunStatus::Cancelled);
            let result_mismatch = !cancelled
                && (matches!((exit_code, event_exit_code), (Some(actual), Some(reported)) if actual != reported)
                    || matches!((exit_code, event_status), (Some(0), status) if status.is_terminal() && status != TestRunStatus::Passed)
                    || matches!((exit_code, event_status), (Some(code), TestRunStatus::Passed) if code != 0));
            if cancelled {
                run.snapshot.status = TestRunStatus::Cancelled;
            } else if result_mismatch {
                run.snapshot.status = TestRunStatus::Error;
            } else if !run.snapshot.status.is_terminal() {
                run.snapshot.status = match exit_code {
                    Some(0) => TestRunStatus::Passed,
                    Some(1) => TestRunStatus::Failed,
                    _ => TestRunStatus::Error,
                };
            }
            if run.saw_finish_event && !cancelled && !result_mismatch {
                None
            } else {
                run.next_sequence = run.next_sequence.saturating_add(1);
                Some(TestRunLogEvent {
                    run_id: run_id.to_string(),
                    seq: run.next_sequence,
                    event_type: "run-finish".to_string(),
                    timestamp: now_ms(),
                    message: if cancelled {
                        Some("Test run cancelled".to_string())
                    } else if result_mismatch {
                        Some(format!(
                            "Structured finish ({}, exit {:?}) conflicts with process exit {:?}",
                            status_name(event_status),
                            event_exit_code,
                            exit_code
                        ))
                    } else {
                        Some("Test runner exited without a structured finish event".to_string())
                    },
                    stream: None,
                    case_id: None,
                    node_id: None,
                    outcome: Some(status_name(run.snapshot.status).to_string()),
                    data: Some(serde_json::json!({
                        "status": status_name(run.snapshot.status),
                        "exitCode": run.snapshot.exit_code,
                    })),
                })
            }
        };
        if let Some(event) = synthetic {
            self.record_event(app_handle, event).await;
        }
    }
}

fn resolve_runner(project_root: &str, python_path: Option<&str>) -> AppResult<ResolvedRunner> {
    let raw_root = project_root.trim();
    if raw_root.is_empty() {
        return Err(AppError::TestRunner("Project root is required".to_string()));
    }
    let project_root = std::fs::canonicalize(raw_root).map_err(|error| {
        AppError::TestRunner(format!("Cannot resolve project root '{raw_root}': {error}"))
    })?;
    if !project_root.is_dir() {
        return Err(AppError::TestRunner(format!(
            "Project root '{}' is not a directory",
            project_root.display()
        )));
    }

    let expected_bridge = project_root.join("test_case").join("linkassist_runner.py");
    let bridge_path = std::fs::canonicalize(&expected_bridge).map_err(|error| {
        AppError::TestRunner(format!(
            "Project does not provide test_case/linkassist_runner.py: {error}"
        ))
    })?;
    if !bridge_path.is_file() || !bridge_path.starts_with(&project_root) {
        return Err(AppError::TestRunner(
            "The test runner bridge must be a file under project_root/test_case".to_string(),
        ));
    }

    let raw_python = python_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| default_venv_python(&project_root));
    let python_path = std::fs::canonicalize(&raw_python).map_err(|error| {
        AppError::TestRunner(format!(
            "Cannot find the project pytest interpreter '{}': {error}. Create test_case/.venv and install test_case/requirements.txt, or choose a Python executable.",
            raw_python.display()
        ))
    })?;
    if !python_path.is_file() {
        return Err(AppError::TestRunner(format!(
            "Python path '{}' is not a file",
            python_path.display()
        )));
    }

    Ok(ResolvedRunner {
        project_root: process_compatible_path(project_root),
        python_path: process_compatible_path(python_path),
        bridge_path: process_compatible_path(bridge_path),
    })
}

fn default_venv_python(project_root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        project_root
            .join("test_case")
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        project_root
            .join("test_case")
            .join(".venv")
            .join("bin")
            .join("python")
    }
}

fn runner_command(runner: &ResolvedRunner) -> Command {
    let mut command = Command::new(&runner.python_path);
    command
        .arg(&runner.bridge_path)
        .current_dir(&runner.project_root);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

fn configure_process_group(command: &mut Command) {
    #[cfg(target_os = "windows")]
    command.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    #[cfg(unix)]
    command.process_group(0);
}

fn is_sha256_revision(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|character| character.is_ascii_hexdigit())
}

fn is_valid_runtime_input_name(name: &str) -> bool {
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|value| value.is_ascii_uppercase())
        && characters
            .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == '_')
}

fn validate_start_request(request: &StartTestRunRequest) -> AppResult<()> {
    if request
        .profile
        .as_deref()
        .is_some_and(|profile| profile.trim().is_empty())
    {
        return Err(AppError::TestRunner("Profile cannot be empty".to_string()));
    }
    if request
        .node_ids
        .iter()
        .any(|node_id| node_id.trim().is_empty())
    {
        return Err(AppError::TestRunner("Node IDs cannot be empty".to_string()));
    }
    if request
        .catalog_revision
        .as_deref()
        .is_some_and(|revision| !is_sha256_revision(revision))
    {
        return Err(AppError::TestRunner(
            "Catalog revision must be sha256:<64 hex characters>".to_string(),
        ));
    }
    for name in request.inputs.keys() {
        if !is_valid_runtime_input_name(name) {
            return Err(AppError::TestRunner(format!(
                "Runtime input name '{name}' must use upper-case letters, digits, and underscores"
            )));
        }
    }
    Ok(())
}

fn validate_catalog(catalog: &TestRunnerCatalog) -> AppResult<()> {
    if catalog.runner_id.trim().is_empty() || catalog.title.trim().is_empty() {
        return Err(AppError::TestRunner(
            "Test catalog runnerId and title must be non-empty".to_string(),
        ));
    }
    for (label, revision) in [
        ("catalogRevision", catalog.catalog_revision.as_deref()),
        ("packageRevision", catalog.package_revision.as_deref()),
    ] {
        if revision.is_some_and(|value| !is_sha256_revision(value)) {
            return Err(AppError::TestRunner(format!(
                "Test catalog {label} must be sha256:<64 hex characters>"
            )));
        }
    }
    for (name, definition) in &catalog.input_definitions {
        if !is_valid_runtime_input_name(name) {
            return Err(AppError::TestRunner(format!(
                "Test catalog input definition '{name}' must use upper-case letters, digits, and underscores"
            )));
        }
        for (field, value) in [
            ("label", definition.label.as_deref()),
            ("description", definition.description.as_deref()),
            ("placeholder", definition.placeholder.as_deref()),
        ] {
            if value.is_some_and(|text| text.trim().is_empty()) {
                return Err(AppError::TestRunner(format!(
                    "Test catalog input definition '{name}' has an empty {field}"
                )));
            }
        }
        if !definition.extensions.is_empty() && definition.input_type != TestInputType::File {
            return Err(AppError::TestRunner(format!(
                "Test catalog input definition '{name}' may use extensions only with type=file"
            )));
        }
        let mut extensions = HashSet::new();
        for extension in &definition.extensions {
            if extension.is_empty()
                || !extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
                || !extensions.insert(extension)
            {
                return Err(AppError::TestRunner(format!(
                    "Test catalog input definition '{name}' contains an invalid or duplicate extension '{extension}'"
                )));
            }
        }
    }
    let mut profile_ids = HashSet::new();
    for profile in &catalog.profiles {
        if profile.id.trim().is_empty()
            || profile.title.trim().is_empty()
            || !profile_ids.insert(profile.id.as_str())
        {
            return Err(AppError::TestRunner(format!(
                "Test catalog contains an empty or duplicate profile id '{}'",
                profile.id
            )));
        }
    }
    let mut case_ids = HashSet::new();
    let mut node_ids = HashSet::new();
    for test_case in &catalog.tests {
        if test_case.id.trim().is_empty()
            || test_case.node_id.trim().is_empty()
            || test_case.title.trim().is_empty()
            || test_case.kind.trim().is_empty()
            || test_case.file.trim().is_empty()
            || !case_ids.insert(test_case.id.as_str())
            || !node_ids.insert(test_case.node_id.as_str())
        {
            return Err(AppError::TestRunner(format!(
                "Test catalog contains an invalid or duplicate case '{}'",
                test_case.id
            )));
        }
        for requirement in &test_case.requires {
            let name = match requirement {
                TestRequirement::Name(name) => name,
                TestRequirement::Detail(detail) => &detail.name,
            };
            if name.trim().is_empty() {
                return Err(AppError::TestRunner(format!(
                    "Test case '{}' contains an empty requirement",
                    test_case.id
                )));
            }
        }
    }
    for profile in &catalog.profiles {
        if let Some(profile_node_ids) = &profile.node_ids {
            let mut profile_nodes = HashSet::new();
            for node_id in profile_node_ids {
                if !node_ids.contains(node_id.as_str()) || !profile_nodes.insert(node_id.as_str()) {
                    return Err(AppError::TestRunner(format!(
                        "Test profile '{}' contains an unknown or duplicate node id '{}'",
                        profile.id, node_id
                    )));
                }
            }
        }
    }
    Ok(())
}

fn spawn_line_reader<R>(reader: R, stream: &'static str, sender: mpsc::Sender<ProcessLine>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let line = truncate_log_line(line);
                    if sender.send(ProcessLine { stream, line }).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender
                        .send(ProcessLine {
                            stream: "stderr",
                            line: format!("Failed to read pytest {stream}: {error}"),
                        })
                        .await;
                    break;
                }
            }
        }
    });
}

fn truncate_log_line(line: String) -> String {
    let Some((split_at, _)) = line.char_indices().nth(MAX_LOG_LINE_CHARS) else {
        return line;
    };
    let omitted = line[split_at..].chars().count();
    format!("{}… [{omitted} characters truncated]", &line[..split_at])
}

fn event_from_line(run_id: &str, seq: u64, stream: &str, line: &str) -> TestRunLogEvent {
    let value = serde_json::from_str::<Value>(line).ok();
    let object = value.as_ref().and_then(Value::as_object);
    let event_type = object
        .and_then(|value| value.get("eventType"))
        .and_then(Value::as_str)
        .unwrap_or("log")
        .to_string();
    let message = object
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| (event_type == "log").then(|| line.to_string()));
    TestRunLogEvent {
        run_id: run_id.to_string(),
        seq,
        event_type,
        timestamp: object
            .and_then(|value| value.get("timestamp"))
            .and_then(Value::as_u64)
            .unwrap_or_else(now_ms),
        message,
        stream: object
            .and_then(|value| value.get("stream"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| Some(stream.to_string())),
        case_id: object
            .and_then(|value| value.get("caseId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        node_id: object
            .and_then(|value| value.get("nodeId"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        outcome: object
            .and_then(|value| value.get("outcome"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        data: object.and_then(|value| value.get("data")).cloned(),
    }
}

fn trim_run_history(state: &mut TestRunState) {
    if state.runs.len() < MAX_RUN_HISTORY {
        return;
    }
    let oldest_terminal = state
        .runs
        .iter()
        .filter(|(_, run)| run.snapshot.status.is_terminal())
        .min_by_key(|(_, run)| run.snapshot.started_at.unwrap_or_default())
        .map(|(run_id, _)| run_id.clone());
    if let Some(run_id) = oldest_terminal {
        state.runs.remove(&run_id);
    }
}

async fn terminate_process_tree(process_id: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("taskkill.exe")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
    }
    #[cfg(unix)]
    {
        let group = format!("-{process_id}");
        let term_sent = Command::new("kill")
            .args(["-TERM", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let kill_sent = Command::new("kill")
            .args(["-KILL", &group])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|status| status.success());
        term_sent || kill_sent
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn path_for_frontend(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(target_os = "windows")]
fn process_compatible_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(network_path) = value.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{network_path}"));
    }
    if let Some(local_path) = value.strip_prefix(r"\\?\") {
        return PathBuf::from(local_path);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn process_compatible_path(path: PathBuf) -> PathBuf {
    path
}

fn status_name(status: TestRunStatus) -> &'static str {
    match status {
        TestRunStatus::Queued => "queued",
        TestRunStatus::Running => "running",
        TestRunStatus::Passed => "passed",
        TestRunStatus::Failed => "failed",
        TestRunStatus::Blocked => "blocked",
        TestRunStatus::Cancelled => "cancelled",
        TestRunStatus::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_and_plain_log_lines() {
        let structured = event_from_line(
            "run-1",
            3,
            "stdout",
            r#"{"runId":"run-1","seq":9,"eventType":"test-result","timestamp":123,"caseId":"case-1","outcome":"blocked","data":{"durationMs":4}}"#,
        );
        assert_eq!(structured.seq, 3);
        assert_eq!(structured.event_type, "test-result");
        assert_eq!(structured.timestamp, 123);
        assert_eq!(structured.case_id.as_deref(), Some("case-1"));
        assert_eq!(structured.outcome.as_deref(), Some("blocked"));

        let plain = event_from_line("run-1", 4, "stderr", "plain failure");
        assert_eq!(plain.event_type, "log");
        assert_eq!(plain.message.as_deref(), Some("plain failure"));
        assert_eq!(plain.stream.as_deref(), Some("stderr"));
    }

    #[test]
    fn validates_runtime_input_names() {
        let mut request = StartTestRunRequest {
            project_root: "project".to_string(),
            python_path: None,
            profile: None,
            node_ids: Vec::new(),
            inputs: HashMap::from([("DEVICE_NAME".to_string(), "target".to_string())]),
            allow_destructive: false,
            catalog_revision: None,
        };
        assert!(validate_start_request(&request).is_ok());
        request.inputs = HashMap::from([("bad-name".to_string(), "target".to_string())]);
        assert!(validate_start_request(&request).is_err());
    }

    #[test]
    fn terminal_statuses_are_explicit() {
        assert!(!TestRunStatus::Running.is_terminal());
        assert!(TestRunStatus::Blocked.is_terminal());
        assert_eq!(
            TestRunStatus::parse("canceled"),
            Some(TestRunStatus::Cancelled)
        );
    }

    #[test]
    fn catalog_types_reject_unknown_danger_and_requirement_shapes() {
        let invalid_danger = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "profiles": [{
                "id": "quick",
                "title": "quick",
                "danger": "sfae"
            }],
            "tests": []
        }));
        assert!(invalid_danger.is_err());

        let invalid_requirement = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "profiles": [],
            "tests": [{
                "nodeId": "node",
                "id": "case",
                "title": "case",
                "kind": "command",
                "requires": [{ "name": "exe:node", "optional": "yes" }],
                "file": "case.json",
                "danger": "safe"
            }]
        }));
        assert!(invalid_requirement.is_err());
    }

    #[test]
    fn catalog_input_definitions_round_trip_and_validate() {
        let catalog = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "inputDefinitions": {
                "FIRMWARE_FILE": {
                    "type": "file",
                    "persist": false,
                    "label": "Firmware",
                    "placeholder": "Select a file",
                    "extensions": ["bin"]
                }
            },
            "profiles": [],
            "tests": []
        }))
        .expect("typed input catalog should deserialize");
        assert!(validate_catalog(&catalog).is_ok());
        let serialized = serde_json::to_value(&catalog).expect("catalog should serialize");
        assert_eq!(
            serialized["inputDefinitions"]["FIRMWARE_FILE"]["type"],
            "file"
        );
        assert_eq!(
            serialized["inputDefinitions"]["FIRMWARE_FILE"]["persist"],
            false
        );

        let mut invalid_name = catalog.clone();
        let definition = invalid_name
            .input_definitions
            .remove("FIRMWARE_FILE")
            .expect("fixture definition");
        invalid_name
            .input_definitions
            .insert("bad-name".to_string(), definition);
        assert!(validate_catalog(&invalid_name).is_err());

        let invalid_type = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "inputDefinitions": { "VALUE": { "type": "select" } },
            "profiles": [],
            "tests": []
        }));
        assert!(invalid_type.is_err());

        let invalid_extensions = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "inputDefinitions": {
                "VALUE": { "type": "text", "extensions": ["bin"] }
            },
            "profiles": [],
            "tests": []
        }))
        .expect("shape should deserialize before semantic validation");
        assert!(validate_catalog(&invalid_extensions).is_err());
    }

    #[test]
    fn catalog_profile_node_ids_round_trip_and_validate() {
        let catalog = serde_json::from_value::<TestRunnerCatalog>(serde_json::json!({
            "schemaVersion": 1,
            "runnerId": "runner",
            "title": "tests",
            "profiles": [{
                "id": "quick",
                "title": "Quick",
                "danger": "safe",
                "nodeIds": ["tests/test_fast.py::test_fast"]
            }],
            "tests": [{
                "nodeId": "tests/test_fast.py::test_fast",
                "id": "fast",
                "title": "Fast",
                "kind": "unit",
                "file": "tests/test_fast.py",
                "danger": "safe"
            }]
        }))
        .expect("profile membership should deserialize");
        assert!(validate_catalog(&catalog).is_ok());
        let serialized = serde_json::to_value(&catalog).expect("catalog should serialize");
        assert_eq!(
            serialized["profiles"][0]["nodeIds"],
            serde_json::json!(["tests/test_fast.py::test_fast"])
        );

        let mut unknown = catalog.clone();
        unknown.profiles[0].node_ids = Some(vec!["tests/missing.py::test_missing".to_string()]);
        assert!(validate_catalog(&unknown).is_err());

        let mut duplicate = catalog;
        duplicate.profiles[0].node_ids = Some(vec![
            "tests/test_fast.py::test_fast".to_string(),
            "tests/test_fast.py::test_fast".to_string(),
        ]);
        assert!(validate_catalog(&duplicate).is_err());
    }

    #[tokio::test]
    async fn process_exit_code_cannot_leave_a_conflicting_passed_status() {
        let manager = TestRunManager::new();
        let run_id = "mismatch".to_string();
        {
            let mut state = manager.state.write().await;
            state.runs.insert(
                run_id.clone(),
                ManagedRun {
                    snapshot: TestRunSnapshot {
                        run_id: run_id.clone(),
                        status: TestRunStatus::Passed,
                        project_root: "project".to_string(),
                        profile: None,
                        node_ids: Vec::new(),
                        started_at: Some(now_ms()),
                        finished_at: None,
                        exit_code: Some(0),
                        summary: None,
                        logs: VecDeque::new(),
                    },
                    process_id: None,
                    cancel_requested: false,
                    termination_succeeded: false,
                    next_sequence: 0,
                    saw_finish_event: true,
                },
            );
        }
        manager.finish_run(None, &run_id, Some(1)).await;
        let finished = manager.get_run(&run_id).await.expect("run should exist");
        assert_eq!(finished.status, TestRunStatus::Error);
        assert_eq!(finished.exit_code, Some(1));
        assert!(finished.logs.iter().any(|event| {
            event
                .message
                .as_deref()
                .is_some_and(|message| message.contains("conflicts with process exit"))
        }));
    }

    #[test]
    fn serializes_runs_that_target_the_same_project() {
        let manager = TestRunManager::new();
        let project_root = PathBuf::from("project-a");
        let permit = manager
            .reserve_project(&project_root)
            .expect("first project run should reserve the project");
        assert!(manager.reserve_project(&project_root).is_err());
        assert!(manager.reserve_project(Path::new("project-b")).is_ok());
        drop(permit);
        assert!(manager.reserve_project(&project_root).is_ok());
    }

    #[test]
    fn truncates_individual_log_lines_at_a_bounded_size() {
        let short = "short".to_string();
        assert_eq!(truncate_log_line(short.clone()), short);

        let long = "x".repeat(MAX_LOG_LINE_CHARS + 7);
        let truncated = truncate_log_line(long);
        assert!(truncated.starts_with(&"x".repeat(MAX_LOG_LINE_CHARS)));
        assert!(truncated.ends_with("[7 characters truncated]"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn removes_windows_verbatim_prefix_before_starting_child_tools() {
        assert_eq!(
            process_compatible_path(PathBuf::from(r"\\?\D:\Workspace\project")),
            PathBuf::from(r"D:\Workspace\project")
        );
        assert_eq!(
            process_compatible_path(PathBuf::from(r"\\?\UNC\server\share\project")),
            PathBuf::from(r"\\server\share\project")
        );
    }

    #[tokio::test]
    #[ignore = "requires an external project that implements the LinkAssist pytest bridge"]
    async fn external_project_catalog_matches_the_generic_contract() {
        let project_root = std::env::var("LINKASSIST_TEST_PROJECT_ROOT")
            .expect("LINKASSIST_TEST_PROJECT_ROOT must point at a bridge fixture");
        let python_path = std::env::var("LINKASSIST_TEST_PYTHON").ok();
        let catalog = TestRunManager::new()
            .load_catalog(TestRunnerLocationRequest {
                project_root,
                python_path,
            })
            .await
            .expect("external catalog should load");
        assert_eq!(catalog.schema_version, 1);
        assert!(!catalog.runner_id.is_empty());
        assert!(!catalog.tests.is_empty());
    }

    #[tokio::test]
    #[ignore = "requires an external project and an offline passing profile"]
    async fn external_project_profile_runs_through_the_manager() {
        let project_root = std::env::var("LINKASSIST_TEST_PROJECT_ROOT")
            .expect("LINKASSIST_TEST_PROJECT_ROOT must point at a bridge fixture");
        let python_path = std::env::var("LINKASSIST_TEST_PYTHON").ok();
        let profile = std::env::var("LINKASSIST_TEST_PROFILE").ok();
        let manager = TestRunManager::new();
        let catalog_revision = manager
            .load_catalog(TestRunnerLocationRequest {
                project_root: project_root.clone(),
                python_path: python_path.clone(),
            })
            .await
            .expect("external catalog should load before run")
            .catalog_revision;
        let started = manager
            .start_run(
                None,
                StartTestRunRequest {
                    project_root,
                    python_path,
                    profile,
                    node_ids: Vec::new(),
                    inputs: HashMap::new(),
                    allow_destructive: false,
                    catalog_revision,
                },
            )
            .await
            .expect("external profile should start");

        let finished = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                let snapshot = manager
                    .get_run(&started.run_id)
                    .await
                    .expect("run should remain queryable");
                if snapshot.status.is_terminal() {
                    break snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("external profile timed out");

        assert_eq!(finished.status, TestRunStatus::Passed);
        assert_eq!(finished.exit_code, Some(0));
        assert!(finished
            .logs
            .iter()
            .any(|event| event.event_type == "run-finish"));
        assert!(finished.summary.is_some());
    }

    #[tokio::test]
    #[ignore = "requires an external project profile that blocks without runtime inputs"]
    async fn external_project_blocked_profile_keeps_a_nonzero_blocked_verdict() {
        let project_root = std::env::var("LINKASSIST_TEST_PROJECT_ROOT")
            .expect("LINKASSIST_TEST_PROJECT_ROOT must point at a bridge fixture");
        let python_path = std::env::var("LINKASSIST_TEST_PYTHON").ok();
        let profile = std::env::var("LINKASSIST_TEST_BLOCKED_PROFILE")
            .expect("LINKASSIST_TEST_BLOCKED_PROFILE must name a blocked fixture profile");
        let manager = TestRunManager::new();
        let catalog_revision = manager
            .load_catalog(TestRunnerLocationRequest {
                project_root: project_root.clone(),
                python_path: python_path.clone(),
            })
            .await
            .expect("external catalog should load before run")
            .catalog_revision;
        let started = manager
            .start_run(
                None,
                StartTestRunRequest {
                    project_root,
                    python_path,
                    profile: Some(profile),
                    node_ids: Vec::new(),
                    inputs: HashMap::new(),
                    allow_destructive: false,
                    catalog_revision,
                },
            )
            .await
            .expect("blocked profile should start");

        let finished = tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                let snapshot = manager
                    .get_run(&started.run_id)
                    .await
                    .expect("run should remain queryable");
                if snapshot.status.is_terminal() {
                    break snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("blocked profile timed out");

        assert_eq!(finished.status, TestRunStatus::Blocked);
        assert_eq!(finished.exit_code, Some(1));
        assert!(finished.logs.iter().any(|event| {
            event.event_type == "test-result" && event.outcome.as_deref() == Some("blocked")
        }));
    }

    #[tokio::test]
    #[ignore = "requires LINKASSIST_TEST_PYTHON and starts then cancels a child process"]
    async fn cancellation_stops_the_bridge_process_and_marks_the_run_cancelled() {
        let python_path = std::env::var("LINKASSIST_TEST_PYTHON")
            .expect("LINKASSIST_TEST_PYTHON must point at a Python executable");
        let project_root =
            std::env::temp_dir().join(format!("linkassist-test-runner-cancel-{}", Uuid::new_v4()));
        let test_case_root = project_root.join("test_case");
        std::fs::create_dir_all(&test_case_root).expect("temporary test_case should be created");
        std::fs::write(
            test_case_root.join("linkassist_runner.py"),
            r#"import json
import sys
import time

if sys.argv[1] == "catalog":
    print(json.dumps({"schemaVersion": 1, "runnerId": "cancel-fixture", "title": "fixture", "profiles": [], "tests": []}), flush=True)
    raise SystemExit(0)

run_id = sys.argv[sys.argv.index("--run-id") + 1]
print(json.dumps({"runId": run_id, "seq": 1, "eventType": "run-start"}), flush=True)
time.sleep(60)
print(json.dumps({"runId": run_id, "seq": 2, "eventType": "run-finish", "outcome": "passed", "data": {"status": "passed", "exitCode": 0}}), flush=True)
"#,
        )
        .expect("temporary bridge should be written");

        let manager = TestRunManager::new();
        let started = manager
            .start_run(
                None,
                StartTestRunRequest {
                    project_root: path_for_frontend(&project_root),
                    python_path: Some(python_path),
                    profile: None,
                    node_ids: Vec::new(),
                    inputs: HashMap::new(),
                    allow_destructive: false,
                    catalog_revision: None,
                },
            )
            .await
            .expect("cancellation fixture should start");

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if manager
                    .get_run(&started.run_id)
                    .await
                    .expect("run should exist")
                    .logs
                    .iter()
                    .any(|event| event.event_type == "run-start")
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fixture did not report startup");

        manager
            .cancel_run(&started.run_id)
            .await
            .expect("cancellation should be accepted");
        let finished = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let snapshot = manager
                    .get_run(&started.run_id)
                    .await
                    .expect("run should remain queryable");
                if snapshot.status.is_terminal() {
                    break snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled bridge did not exit");

        assert_eq!(finished.status, TestRunStatus::Cancelled);
        assert!(finished.logs.iter().any(|event| {
            event.event_type == "run-finish" && event.outcome.as_deref() == Some("cancelled")
        }));
        std::fs::remove_dir_all(&project_root).expect("temporary fixture should be removed");
    }
}
