import { invoke } from '@tauri-apps/api/core';
import type {
  StartTestRunRequest,
  TestRunIdRequest,
  TestRunSnapshot,
  TestRunnerCatalog,
  TestRunnerLocationRequest,
} from '../types';

export async function loadTestRunnerCatalog(
  request: TestRunnerLocationRequest,
): Promise<TestRunnerCatalog> {
  return invoke<TestRunnerCatalog>('load_test_runner_catalog', { request });
}

export async function startTestRun(request: StartTestRunRequest): Promise<TestRunSnapshot> {
  return invoke<TestRunSnapshot>('start_test_run', { request });
}

export async function getTestRun(request: TestRunIdRequest): Promise<TestRunSnapshot> {
  return invoke<TestRunSnapshot>('get_test_run', { request });
}

export async function listTestRuns(): Promise<TestRunSnapshot[]> {
  return invoke<TestRunSnapshot[]>('list_test_runs');
}

export async function cancelTestRun(request: TestRunIdRequest): Promise<TestRunSnapshot> {
  return invoke<TestRunSnapshot>('cancel_test_run', { request });
}

