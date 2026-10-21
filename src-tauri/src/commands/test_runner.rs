use crate::test_runner::{
    StartTestRunRequest, TestRunIdRequest, TestRunSnapshot, TestRunnerCatalog,
    TestRunnerLocationRequest,
};
use crate::{AppResult, AppState};
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn load_test_runner_catalog(
    state: State<'_, AppState>,
    request: TestRunnerLocationRequest,
) -> AppResult<TestRunnerCatalog> {
    state.test_run_manager.load_catalog(request).await
}

#[tauri::command]
pub async fn start_test_run(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    request: StartTestRunRequest,
) -> AppResult<TestRunSnapshot> {
    state
        .test_run_manager
        .start_run(Some(app_handle), request)
        .await
}

#[tauri::command]
pub async fn get_test_run(
    state: State<'_, AppState>,
    request: TestRunIdRequest,
) -> AppResult<TestRunSnapshot> {
    state
        .test_run_manager
        .get_run_since(&request.run_id, request.after_seq, request.limit)
        .await
}

#[tauri::command]
pub async fn list_test_runs(state: State<'_, AppState>) -> AppResult<Vec<TestRunSnapshot>> {
    Ok(state.test_run_manager.list_runs().await)
}

#[tauri::command]
pub async fn cancel_test_run(
    state: State<'_, AppState>,
    request: TestRunIdRequest,
) -> AppResult<TestRunSnapshot> {
    state.test_run_manager.cancel_run(&request.run_id).await
}
