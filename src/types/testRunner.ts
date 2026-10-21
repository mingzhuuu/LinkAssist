export type TestRunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'error';

export type TestDanger = 'safe' | 'read' | 'write' | 'destructive';

export type TestInputType = 'text' | 'password' | 'file' | 'directory';

export interface TestInputDefinition {
  type: TestInputType;
  /** Allow a non-password value to be remembered when its testInputs control opts in. */
  persist?: boolean;
  label?: string;
  description?: string;
  placeholder?: string;
  extensions?: string[];
}

export interface TestRequirement {
  name: string;
  optional?: boolean;
}

export interface TestRunnerProfile {
  id: string;
  title: string;
  description?: string;
  markerExpression?: string;
  danger: TestDanger;
  requiredInputs?: string[];
  /** Explicit profile membership resolved by the project test bridge. */
  nodeIds?: string[];
}

export interface TestRunnerCase {
  nodeId: string;
  id: string;
  title: string;
  kind: string;
  tags: string[];
  requires: Array<string | TestRequirement>;
  requiredInputs?: string[];
  file: string;
  danger?: TestDanger;
}

export interface TestRunnerCatalog {
  schemaVersion: number;
  runnerId: string;
  title: string;
  catalogRevision?: string;
  packageRevision?: string;
  projectRoot?: string;
  inputDefinitions?: Record<string, TestInputDefinition>;
  profiles: TestRunnerProfile[];
  tests: TestRunnerCase[];
}

export interface TestRunnerLocationRequest {
  projectRoot: string;
  pythonPath?: string;
}

export interface StartTestRunRequest extends TestRunnerLocationRequest {
  profile?: string;
  nodeIds?: string[];
  inputs?: Record<string, string>;
  allowDestructive?: boolean;
  catalogRevision?: string;
}

export interface TestRunIdRequest {
  runId: string;
  afterSeq?: number;
  limit?: number;
}

export interface TestRunLogEvent {
  runId: string;
  seq: number;
  eventType: 'run-start' | 'log' | 'test-start' | 'test-result' | 'run-finish' | string;
  timestamp: number;
  message?: string;
  stream?: string;
  caseId?: string;
  nodeId?: string;
  outcome?: string;
  data?: unknown;
}

export interface TestRunSnapshot {
  runId: string;
  status: TestRunStatus;
  projectRoot: string;
  profile?: string;
  nodeIds: string[];
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number;
  summary?: unknown;
  logs: TestRunLogEvent[];
}

export interface TestRunnerSavedLocation {
  projectRoot: string;
  pythonPath: string;
}

export const TEST_RUN_TERMINAL_STATUSES: ReadonlySet<TestRunStatus> = new Set([
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'error',
]);
