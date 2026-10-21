export type ScriptChannelType = 'serial' | 'tcp-client' | 'udp' | 'ble';
export type ScriptDataFormat = 'hex' | 'text' | 'base64' | 'json' | 'bytes';
export type ScriptStatus = 'idle' | 'running' | 'paused' | 'passed' | 'failed' | 'stopped';
export type ScriptStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface ScriptDefaults {
  stopOnFailure?: boolean;
  timeoutMs?: number;
  dataFormat?: 'hex' | 'text';
  logLimit?: number;
  logPreview?: {
    hex?: boolean;
    text?: boolean;
  };
}

export interface ScriptCsvSource {
  path: string;
  encoding?: string;
  header?: boolean;
  /** Reload the CSV from disk before executing each row, allowing dynamic edits during script run. */
  reloadPerRow?: boolean;
}

export type ScriptCsvSources = Record<string, ScriptCsvSource>;

export interface ScriptCsvLogTarget {
  path: string;
  columns: string[];
  /** Write the configured column names as the first row. Defaults to true. */
  header?: boolean;
  /** Resolve the relative path beside the running LinkAssist executable. */
  baseDir?: 'executable';
  /** Prefix the file with UTF-8 BOM for spreadsheet programs that need it for non-ASCII headers. */
  bom?: boolean;
}

export type ScriptCsvLogTargets = Record<string, ScriptCsvLogTarget>;

export interface ScriptDataSpec {
  format?: ScriptDataFormat;
  value: unknown;
}

export interface ScriptLuaHelperDefinition {
  /** External Lua helper file. Relative paths are resolved beside the owning automation script. */
  luaPath?: string;
  /** Load helpers() and call() from the owning automation script itself. */
  embedded?: boolean;
}

export interface ScriptLuaHelperCall {
  /** Alias declared in ScriptDocument.helpers. */
  helper: string;
  /** Function exported by the Lua helper file. */
  func: string;
  args?: Record<string, unknown>;
  /** Optional dotted path selected from the returned value. */
  resultPath?: string;
  /** When supplied, compare the selected result with this interpolated value. */
  equals?: unknown;
}

export interface ScriptExpectSpec {
  format?: 'hex' | 'text' | 'json';
  equals?: string | number;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  regex?: string;
  length?: number;
  /** Run a domain matcher supplied by an external Lua helper package. */
  luaHelper?: ScriptLuaHelperCall;
  /** Accumulate inbound chunks until one complete matching frame can be extracted. */
  accumulate?: boolean;
}

export interface ScriptRetrySpec {
  times?: number;
  intervalMs?: number;
}

export interface ScriptStepBase {
  id?: string;
  name?: string;
  action: string;
  enabled?: boolean;
  /** Execute this step only when the boolean/reference resolves truthy. */
  when?: boolean | { $ref: string };
  display?: 'visible' | 'hidden';
  channel?: string;
  timeoutMs?: number | string;
  continueOnError?: boolean;
  saveAs?: string;
}

export interface ScriptOpenStep extends ScriptStepBase {
  action: 'open';
  channel: string;
  channelType: ScriptChannelType;
  params?: Record<string, unknown>;
}

export interface ScriptCloseStep extends ScriptStepBase {
  action: 'close';
  channel: string;
}

export interface ScriptSendStep extends ScriptStepBase {
  action: 'send';
  channel: string;
  data: ScriptDataSpec;
  target?: { host?: string; port?: number | string; addr?: string };
}

export interface ScriptReadStep extends ScriptStepBase {
  action: 'read';
  channel: string;
}

export interface ScriptWaitStep extends ScriptStepBase {
  action: 'wait';
  channel: string;
  expect: ScriptExpectSpec;
}

export interface ScriptRequestStep extends ScriptStepBase {
  action: 'request';
  channel: string;
  send: ScriptDataSpec;
  expect: ScriptExpectSpec;
  target?: { host?: string; port?: number | string; addr?: string };
  retry?: ScriptRetrySpec;
}

export interface ScriptDelayStep extends ScriptStepBase {
  action: 'delay';
  durationMs?: number | string;
}

export interface ScriptRepeatStep extends ScriptStepBase {
  action: 'repeat';
  times?: number | string;
  intervalMs?: number | string;
  /** Fixed start-to-start cadence. Unlike intervalMs, step execution time is not added to the next deadline. */
  periodMs?: number | string;
  /** Reuse one cadence across adjacent repeat steps, such as successive CSV control rows. */
  schedule?: string;
  steps: ScriptStep[];
}

export interface ScriptGroupStep extends ScriptStepBase {
  action: 'group';
  childDisplay?: 'rows' | 'nested';
  steps: ScriptStep[];
}

export interface ScriptForEachCsvStep extends ScriptStepBase {
  action: 'forEachCsv';
  source: string;
  rowAs?: string;
  /** Repeat the complete CSV until Stop is requested. */
  loop?: boolean | string | ScriptValueReference;
  /** Reload the CSV from disk before executing each row. Defaults to false (or inherits from source). */
  reloadPerRow?: boolean;
  steps: ScriptStep[];
}

export interface ScriptSetStep extends ScriptStepBase {
  action: 'set';
  name: string;
  value: unknown;
}

export interface ScriptAssertStep extends ScriptStepBase {
  action: 'assert';
  left: unknown;
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith' | 'endsWith' | 'matches';
  right: unknown;
}

export interface ScriptLogStep extends ScriptStepBase {
  action: 'log';
  message: string;
}

export interface ScriptLogCsvStep extends ScriptStepBase {
  action: 'logCsv';
  target: string;
  row: Record<string, unknown>;
}

/**
 * Call one tool of a Lua MCP tool script by file path.
 *
 * This is the step that lets an automation script drive capabilities defined outside LinkAssist:
 * the Lua script owns the domain knowledge and the whole multi-step operation, and the canvas
 * only supplies parameters and checks the outcome. `expect` compares a dotted path in the
 * returned object; `saveAs` binds the whole result to a variable for later steps.
 */
export interface ScriptLuaToolStep extends ScriptStepBase {
  action: 'luaTool';
  luaPath: string;
  tool: string;
  args?: Record<string, unknown>;
  expect?: { path?: string; equals?: unknown };
}

/** Run one pure/domain transform supplied by an external Lua helper package. */
export interface ScriptLuaHelperStep extends ScriptStepBase, ScriptLuaHelperCall {
  action: 'luaHelper';
}

/** Read the most recent packet observed on an open runtime channel. */
export interface ScriptTakeLatestPacketStep extends ScriptStepBase {
  action: 'takeLatestPacket';
  channel: string;
  maxAgeMs?: number | string;
  /** Mark a packet as consumed so a later step cannot reuse it. Defaults to true. */
  consume?: boolean | string;
  /** Fail instead of returning available=false. Defaults to false. */
  required?: boolean | string;
  saveAs: string;
}

/** Preserve arrays/objects when a Script action consumes an interactive UI value. */
export interface ScriptValueReference {
  $ref: string;
}

/** Run a cataloged pytest selection through LinkAssist's controlled test runner. */
export interface ScriptTestRunStep extends ScriptStepBase {
  action: 'testRun';
  projectRoot: string;
  pythonPath?: string;
  profile?: string;
  nodeIds?: string[] | ScriptValueReference;
  inputs?: Record<string, unknown> | ScriptValueReference;
  /** Exact node IDs override profile selection when the interactive dashboard has checked rows. */
  selectionMode?: 'profile-and-nodes' | 'exact-or-profile';
  /** Loaded catalog path used to infer whether this selection needs one-time authorization. */
  catalogSource?: string;
  /** Requests one-time user confirmation; it is never persisted as an authorization. */
  allowDestructive?: boolean | ScriptValueReference;
  /** Pins the catalog loaded by a preceding testCatalog step. */
  catalogRevision?: string | ScriptValueReference;
}

export interface ScriptTestCatalogStep extends ScriptStepBase {
  action: 'testCatalog';
  projectRoot: string;
  pythonPath?: string;
}

export interface ScriptTestHistoryStep extends ScriptStepBase {
  action: 'testHistory';
  projectRoot?: string;
}

export type ScriptStep =
  | ScriptOpenStep
  | ScriptCloseStep
  | ScriptReadStep
  | ScriptSendStep
  | ScriptWaitStep
  | ScriptRequestStep
  | ScriptDelayStep
  | ScriptRepeatStep
  | ScriptGroupStep
  | ScriptForEachCsvStep
  | ScriptSetStep
  | ScriptAssertStep
  | ScriptLogStep
  | ScriptLogCsvStep
  | ScriptLuaToolStep
  | ScriptLuaHelperStep
  | ScriptTakeLatestPacketStep
  | ScriptTestRunStep
  | ScriptTestCatalogStep
  | ScriptTestHistoryStep;

export type ScriptUiLayoutPreset = 'top-bottom' | 'left-right';

export interface ScriptUiLayout {
  preset: ScriptUiLayoutPreset;
  /** The two region ids, in top/bottom or left/right order. */
  regions: [string, string];
  /** Initial percentage occupied by the first region. */
  primarySize?: number;
  minPrimaryPx?: number;
  minSecondaryPx?: number;
  resizable?: boolean;
}

export interface ScriptUiOptionSource {
  source: string;
  valuePath?: string;
  labelPath?: string;
}

export interface ScriptUiStaticOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ScriptUiControlBase {
  id: string;
  type: string;
  label?: string;
  description?: string;
  bind?: string;
  persist?: boolean;
  /** Let this control occupy the remaining region height. */
  grow?: boolean;
  /** Render the label and input on the same row. */
  inlineLabel?: boolean;
  /** Toolbar only: 'end' pushes this control to the right edge of the toolbar row. */
  align?: 'start' | 'end';
  /** Keep this control content-sized inside a row layout. */
  compact?: boolean;
}

export interface ScriptUiInputControl extends ScriptUiControlBase {
  type: 'text' | 'search' | 'password' | 'number' | 'file' | 'directory';
  placeholder?: string;
  min?: number;
  max?: number;
  extensions?: string[];
}

export interface ScriptUiCheckboxControl extends ScriptUiControlBase {
  type: 'checkbox';
  bind: string;
}

export interface ScriptUiSelectControl extends ScriptUiControlBase {
  type: 'select' | 'multiSelect';
  bind: string;
  options?: ScriptUiStaticOption[] | ScriptUiOptionSource;
  /** Let single-selects accept free-typed values, such as a serial COM port or a BLE device name. */
  editable?: boolean;
  placeholder?: string;
  /** Set false to hide the leading empty "Select…" choice in single-selects. */
  allowEmpty?: boolean;
}

export interface ScriptUiButtonControl extends ScriptUiControlBase {
  type: 'button';
  action: string;
  variant?: 'default' | 'primary' | 'danger';
  loadedSource?: string;
  loadedLabel?: string;
  runningAction?: string;
  runningLabel?: string;
  runningHandler?: string;
  /** Reparse the Lua document before dispatching this action. */
  reloadDocument?: boolean;
  /** Pick a project/directory into `bind` before dispatching the action. */
  directoryPicker?: boolean;
}

export interface ScriptUiTestCasesControl extends ScriptUiControlBase {
  type: 'testCases';
  bind: string;
  catalogSource: string;
  /** Optional selected profile used to scope the visible catalog cases. */
  profileBind?: string;
}

export interface ScriptUiTestInputsControl extends ScriptUiControlBase {
  type: 'testInputs';
  bind: string;
  catalogSource: string;
  profileBind: string;
  nodeIdsBind: string;
}

export interface ScriptUiOutputControl extends ScriptUiControlBase {
  type: 'runSummary' | 'testResults' | 'stepList' | 'logViewer' | 'historyList';
  source?: string;
  collapsed?: boolean;
  refreshAction?: string;
  /** For logViewer, keep only failed/error entries. */
  errorOnly?: boolean;
  /** For logViewer, render nothing until at least one visible entry exists. */
  hideWhenEmpty?: boolean;
  /** For stepList, whether to display execution timestamps. Defaults to true. */
  showTimestamp?: boolean;
  /** For stepList, format of the timestamp: 'time' (HH:mm:ss), 'datetime' (YYYY-MM-DD HH:mm:ss), or 'none'. Defaults to 'time'. */
  timestampFormat?: 'time' | 'datetime' | 'none';
}

export type ScriptUiControl =
  | ScriptUiInputControl
  | ScriptUiCheckboxControl
  | ScriptUiSelectControl
  | ScriptUiButtonControl
  | ScriptUiTestCasesControl
  | ScriptUiTestInputsControl
  | ScriptUiOutputControl;

export interface ScriptUiRegion {
  title?: string;
  description?: string;
  /** Arrange controls vertically or in one horizontally scrollable row. */
  controlsLayout?: 'column' | 'row';
  controls: ScriptUiControl[];
}

export interface ScriptUiDocument {
  schemaVersion: 1;
  stateVersion?: string;
  /** Optionally rebuild derived read-only state after persisted values are restored. */
  restore?: {
    action: string;
    whenBind?: string;
  };
  /** Hide the script name, active handler, and run status before toolbar controls. */
  showHeaderInfo?: boolean;
  /** Compact controls rendered in declaration order at the upper-right of the canvas header. */
  toolbar?: ScriptUiToolbarControl[];
  layout: ScriptUiLayout;
  regions: Record<string, ScriptUiRegion>;
}

export interface ScriptUiToolbarSelectControl extends Omit<ScriptUiSelectControl, 'type'> {
  type: 'select';
}

export type ScriptUiToolbarControl =
  | ScriptUiButtonControl
  | ScriptUiToolbarSelectControl
  | ScriptUiCheckboxControl;

export interface ScriptWhileActive {
  intervalMs?: number | string;
  steps: ScriptStep[];
}

export interface ScriptReportPaths {
  json?: { path?: string };
  csv?: { path?: string };
}

export interface ScriptDocument {
  version: number;
  name: string;
  description?: string;
  /** Absolute source file used only to resolve relative helper paths at runtime. */
  sourcePath?: string;
  /** Named external Lua helper packages used by luaHelper steps and matchers. */
  helpers?: Record<string, ScriptLuaHelperDefinition>;
  defaults?: ScriptDefaults;
  variables?: Record<string, unknown>;
  ui?: ScriptUiDocument;
  handlers?: Record<string, ScriptStep[]>;
  csv?: ScriptCsvSources;
  csvLog?: ScriptCsvLogTargets;
  setup?: ScriptStep[];
  steps?: ScriptStep[];
  onStop?: ScriptStep[];
  onActivate?: ScriptStep[];
  whileActive?: ScriptWhileActive;
  onDeactivate?: ScriptStep[];
  teardown?: ScriptStep[];
  report?: ScriptReportPaths;
}

export interface ScriptDataPreview {
  bytes: number[];
  hex: string;
  textPreview: string;
}

export interface ScriptLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'send' | 'receive' | 'pass' | 'fail' | 'error';
  stepId?: string;
  channel?: string;
  message: string;
  data?: ScriptDataPreview;
}

export interface ScriptRuntimeStepState {
  id: string;
  action: string;
  name?: string;
  status: ScriptStepStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  sendHex?: string;
  receiveHex?: string;
  textPreview?: string;
  children?: ScriptRuntimeStepState[];
}

export interface ScriptRuntimeSnapshot {
  status: ScriptStatus;
  scriptName: string;
  currentStepIndex: number;
  startedAt?: number;
  finishedAt?: number;
  steps: ScriptRuntimeStepState[];
  logs: ScriptLogEntry[];
  /** Runtime bindings exposed to declarative Script Canvas controls. */
  variables?: Record<string, unknown>;
  activeHandler?: string;
  error?: string;
}

export interface ScriptInboundPacket {
  channelId: string;
  data: number[];
  timestamp: number;
  source: 'serial' | 'tcp' | 'udp' | 'ble';
  connectionId?: string;
  localAddr?: string;
  remoteAddr?: string;
  deviceId?: string;
  serviceUuid?: string;
  charUuid?: string;
}
