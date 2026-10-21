import { invoke } from '@tauri-apps/api/core';
import { cancelTestRun, getTestRun, listTestRuns, loadTestRunnerCatalog, startTestRun } from '../../lib/testRunnerApi';
import {
  filterTestRunnerNodeIds,
  summarizeTestRunnerSelection,
} from '../../lib/testRunnerSelection';
import { useBleStore, useChannelStore, useSerialStore, useTcpStore } from '../../stores';
import { useTerminalStore } from '../../stores/terminalStore';
import { TEST_RUN_TERMINAL_STATUSES } from '../../types';
import type { BleDevice, Channel, GattService, SerialConfig, TestRunLogEvent, TestRunnerCatalog, TestRunSnapshot } from '../../types';
import { csvEscape, parseCsv, CsvRow, toCsv } from './scriptCsv';
import { acquireChannelRuntimeLease, releaseChannelRuntimeLease } from './channelRuntimeLease';
import {
  ScriptAssertStep,
  ScriptCloseStep,
  ScriptDataSpec,
  ScriptDocument,
  ScriptExpectSpec,
  ScriptForEachCsvStep,
  ScriptInboundPacket,
  ScriptLogCsvStep,
  ScriptLogEntry,
  ScriptLuaHelperCall,
  ScriptLuaHelperStep,
  ScriptLuaToolStep,
  ScriptOpenStep,
  ScriptReadStep,
  ScriptRepeatStep,
  ScriptRequestStep,
  ScriptRuntimeSnapshot,
  ScriptRuntimeStepState,
  ScriptSendStep,
  ScriptStep,
  ScriptTakeLatestPacketStep,
  ScriptTestCatalogStep,
  ScriptTestHistoryStep,
  ScriptTestRunStep,
  ScriptWaitStep,
} from './scriptTypes';
import { buildAddress, bytesToHex, bytesToTextPreview, normalizeHex, parseDataSpec, previewBytes, unknownToString } from './scriptUtils';

type RuntimeListener = (snapshot: ScriptRuntimeSnapshot) => void;

export type ScriptRuntimeChannelType = 'serial' | 'tcp-client' | 'tcp-server' | 'udp' | 'ble';
export type ScriptRuntimeLifecycleHook = 'onActivate' | 'onDeactivate';

export interface ScriptHandlerRunOptions {
  preserveLogs?: boolean;
}

export interface ScriptRuntimeChannelBinding {
  alias: string;
  channelType: ScriptRuntimeChannelType;
  uiChannelId: string;
  connectionId: string;
  targetAddr?: string;
  closeOnCleanup?: boolean;
  bleDeviceId?: string;
  bleServiceUuid?: string;
  bleCharUuid?: string;
  unsubscribeOnCleanup?: boolean;
}

interface RuntimeChannel {
  alias: string;
  channelType: ScriptRuntimeChannelType;
  uiChannelId: string;
  connectionId: string;
  targetAddr?: string;
  closeOnCleanup: boolean;
  bleDeviceId?: string;
  bleServiceUuid?: string;
  bleCharUuid?: string;
  unsubscribeOnCleanup?: boolean;
  lifecycleSuspensionOwner?: string;
}

interface PendingWait {
  channelAlias: string;
  expect: ScriptExpectSpec;
  resolve: (packet: ScriptInboundPacket) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  buffer: number[];
}

interface PendingWaitHandle {
  dispose: () => void;
  promise: Promise<ScriptInboundPacket>;
}

interface CsvControlDirective {
  kind: 'repeat' | 'stop';
  times: number;
  infinite: boolean;
}

export interface ScriptLatestPacketResult {
  available: boolean;
  reason: string;
  bytes: number[];
  hex: string;
  text: string;
  length: number;
  timestamp?: number;
  sequence?: number;
}

const MAX_SCRIPT_LOG_ENTRIES = 2000;
const TEST_RUN_LOG_PAGE_SIZE = 500;

function testRunEventKey(event: TestRunLogEvent): string {
  return Number.isFinite(event.seq)
    ? `${event.runId}:${event.seq}`
    : `${event.runId}:${event.timestamp}:${event.eventType}:${event.message ?? ''}`;
}

function rememberBoundedEventKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return false;
  if (keys.size >= MAX_SCRIPT_LOG_ENTRIES) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  keys.add(key);
  return true;
}

function appendBounded<T>(current: readonly T[], incoming: readonly T[], limit: number): T[] {
  if (incoming.length >= limit) return incoming.slice(-limit);
  const keepCurrent = Math.max(0, limit - incoming.length);
  return [...current.slice(-keepCurrent), ...incoming];
}

function normalizeRuntimeError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalizedError = new Error(String(error));
  normalizedError.name = '';
  return normalizedError;
}

function formatTestRunEvent(event: TestRunLogEvent): string {
  let detail = event.message;
  if (!detail && event.data !== undefined) {
    try {
      detail = JSON.stringify(event.data);
    } catch {
      detail = String(event.data);
    }
  }
  return [event.eventType === 'log' ? undefined : event.eventType, event.nodeId ?? event.caseId, detail]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function isTestRunnerCatalog(value: unknown): value is TestRunnerCatalog {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as TestRunnerCatalog).profiles)
    && Array.isArray((value as TestRunnerCatalog).tests),
  );
}

function testRunLogLevel(event: TestRunLogEvent): ScriptLogEntry['level'] {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
  const semanticLevel = typeof data?.level === 'string' ? data.level.toLowerCase() : '';
  if (semanticLevel === 'progress' || semanticLevel === 'success' || semanticLevel === 'pass') {
    return 'pass';
  }
  if (semanticLevel === 'info') return 'info';
  if (semanticLevel === 'warning' || semanticLevel === 'warn') return 'fail';
  if (semanticLevel === 'error' || semanticLevel === 'fail') return 'error';
  if (event.stream === 'stderr' || ['failed', 'blocked', 'error'].includes(event.outcome ?? '')) {
    return 'error';
  }
  return event.outcome === 'passed' ? 'pass' : 'info';
}

class ScriptRuntime {
  private snapshot: ScriptRuntimeSnapshot = {
    status: 'idle',
    scriptName: 'Automation Script',
    currentStepIndex: -1,
    steps: [],
    logs: [],
  };

  private readonly listeners = new Set<RuntimeListener>();
  private readonly channels = new Map<string, RuntimeChannel>();
  private readonly variables: Record<string, unknown> = {};
  private readonly csvData: Record<string, CsvRow[]> = {};
  private readonly initializedCsvLogs = new Set<string>();
  private readonly csvLogPaths = new Map<string, string>();
  private readonly pendingWaits: PendingWait[] = [];
  private readonly activeDelayResolvers = new Map<number, () => void>();
  private readonly scheduledDeadlines = new Map<string, number>();
  private readonly consumedPacketSequences = new Map<string, number>();
  private latestPacketSequence = 0;
  private packetMatchGeneration = 0;
  private packetMatchQueue: Promise<void> = Promise.resolve();
  private reportedFailures = new WeakSet<Error>();
  private nestedParentId: string | null = null;
  private stopRequested = false;
  private document: ScriptDocument | null = null;
  private activeTestRunId: string | null = null;

  constructor(private readonly runtimeId: string) {}

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ScriptRuntimeSnapshot {
    return this.snapshot;
  }

  initializeInteractive(document: ScriptDocument, values: Record<string, unknown> = {}): void {
    if (this.snapshot.status === 'running') return;
    this.document = document;
    Object.keys(this.variables).forEach((key) => delete this.variables[key]);
    Object.assign(this.variables, document.variables ?? {}, values);
    this.resetSamplingState();
    this.snapshot = {
      status: 'idle',
      scriptName: document.name,
      currentStepIndex: -1,
      steps: [],
      logs: [],
    };
    this.emit();
  }

  async runHandler(
    document: ScriptDocument,
    handlerName: string,
    values: Record<string, unknown> = {},
    options: ScriptHandlerRunOptions = {},
  ): Promise<void> {
    if (this.snapshot.status === 'running') return;
    const handlerSteps = document.handlers?.[handlerName];
    if (!handlerSteps) throw new Error(`Script handler not found: ${handlerName}`);

    this.document = document;
    this.stopRequested = false;
    this.clearWaits(new Error('Script handler restarted'));
    this.clearActiveDelays();
    this.channels.clear();
    this.nestedParentId = null;
    Object.assign(this.variables, document.variables ?? {}, values);
    Object.keys(this.csvData).forEach((key) => delete this.csvData[key]);
    this.initializedCsvLogs.clear();
    this.csvLogPaths.clear();
    this.resetSamplingState();

    const allSteps = [...(document.setup ?? []), ...handlerSteps, ...(document.teardown ?? [])]
      .filter((step) => step.enabled !== false && step.display !== 'hidden');
    this.snapshot = {
      ...this.snapshot,
      status: 'running',
      scriptName: document.name,
      activeHandler: handlerName,
      currentStepIndex: -1,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      steps: allSteps.map((step, index) => ({
        id: step.id ?? `${step.action}-${index + 1}`,
        action: step.action,
        name: step.name,
        status: 'pending',
      })),
      logs: options.preserveLogs ? this.snapshot.logs : [],
    };
    this.emit();

    try {
      await this.loadCsvSources(document);
      await this.executeSteps(document.setup ?? [], 'setup');
      await this.executeSteps(handlerSteps, `handler-${handlerName}`);
      this.snapshot = {
        ...this.snapshot,
        status: this.stopRequested ? 'stopped' : 'passed',
        finishedAt: Date.now(),
      };
      this.log('pass', undefined, this.stopRequested ? 'Handler stopped' : `Handler ${handlerName} passed`);
    } catch (error) {
      const normalizedError = normalizeRuntimeError(error);
      this.snapshot = {
        ...this.snapshot,
        status: this.stopRequested ? 'stopped' : 'failed',
        finishedAt: Date.now(),
        error: String(normalizedError),
      };
      this.logFailureOnce(
        this.stopRequested ? 'info' : 'error',
        undefined,
        normalizedError,
        this.stopRequested ? 'Handler stopped' : String(normalizedError),
      );
    } finally {
      if (this.stopRequested) {
        try {
          await this.executeSteps(document.onStop ?? [], 'onStop', true);
        } catch (error) {
          const normalizedError = normalizeRuntimeError(error);
          this.logFailureOnce('error', undefined, normalizedError, `Stop handler failed: ${String(normalizedError)}`);
        }
      }
      try {
        await this.executeSteps(document.teardown ?? [], 'teardown', true);
      } catch (error) {
        const normalizedError = normalizeRuntimeError(error);
        this.logFailureOnce('error', undefined, normalizedError, `Teardown failed: ${String(normalizedError)}`);
      }
      await this.closeAllChannels();
      this.clearWaits(new Error('Script handler finished'));
      this.snapshot = { ...this.snapshot, activeHandler: undefined };
      this.emit();
    }
  }

  reset(scriptName = 'Automation Script'): void {
    if (this.snapshot.status === 'running') return;
    this.clearWaits(new Error('Script reset'));
    this.channels.clear();
    this.nestedParentId = null;
    Object.keys(this.variables).forEach((key) => delete this.variables[key]);
    Object.keys(this.csvData).forEach((key) => delete this.csvData[key]);
    this.initializedCsvLogs.clear();
    this.csvLogPaths.clear();
    this.resetSamplingState();
    this.document = null;
    this.stopRequested = false;
    this.snapshot = {
      status: 'idle',
      scriptName,
      currentStepIndex: -1,
      steps: [],
      logs: [],
    };
    this.emit();
  }

  async run(document: ScriptDocument): Promise<void> {
    if (this.snapshot.status === 'running') return;
    this.document = document;
    this.stopRequested = false;
    this.clearWaits(new Error('Script restarted'));
    this.channels.clear();
    this.nestedParentId = null;
    Object.keys(this.variables).forEach((key) => delete this.variables[key]);
    Object.assign(this.variables, document.variables ?? {});
    Object.keys(this.csvData).forEach((key) => delete this.csvData[key]);
    this.initializedCsvLogs.clear();
    this.csvLogPaths.clear();
    this.resetSamplingState();

    const allSteps = this.flattenTopLevelSteps(document);
    const now = Date.now();
    this.snapshot = {
      status: 'running',
      scriptName: document.name,
      currentStepIndex: -1,
      startedAt: now,
      steps: allSteps.map((step, index) => ({
        id: step.id ?? `${step.action}-${index + 1}`,
        action: step.action,
        name: step.name,
        status: 'pending',
      })),
      logs: [],
    };
    this.emit();

    try {
      await this.loadCsvSources(document);
      await this.executeSteps(document.setup ?? [], 'setup');
      await this.executeSteps(document.steps ?? [], 'steps');
      this.snapshot = { ...this.snapshot, status: this.stopRequested ? 'stopped' : 'passed', finishedAt: Date.now() };
      this.log('pass', undefined, this.stopRequested ? 'Script stopped' : 'Script passed');
    } catch (error) {
      const normalizedError = normalizeRuntimeError(error);
      this.snapshot = { ...this.snapshot, status: this.stopRequested ? 'stopped' : 'failed', finishedAt: Date.now(), error: String(normalizedError) };
      this.logFailureOnce(
        this.stopRequested ? 'info' : 'error',
        undefined,
        normalizedError,
        this.stopRequested ? 'Script stopped' : String(normalizedError),
      );
    } finally {
      if (this.stopRequested) {
        try {
          await this.executeSteps(document.onStop ?? [], 'onStop', true);
        } catch (error) {
          const normalizedError = normalizeRuntimeError(error);
          this.logFailureOnce('error', undefined, normalizedError, `Stop handler failed: ${String(normalizedError)}`);
        }
      }
      try {
        await this.executeSteps(document.teardown ?? [], 'teardown', true);
      } catch (error) {
        const normalizedError = normalizeRuntimeError(error);
        this.logFailureOnce('error', undefined, normalizedError, `Teardown failed: ${String(normalizedError)}`);
      }
      await this.closeAllChannels();
      this.clearWaits(new Error('Script finished'));
      this.emit();
    }
  }

  async runLifecycle(
    document: ScriptDocument,
    hook: ScriptRuntimeLifecycleHook,
    bindings: ScriptRuntimeChannelBinding[] = [],
  ): Promise<void> {
    const hookSteps = document[hook] ?? [];
    const whileActiveSteps = hook === 'onActivate' ? document.whileActive?.steps ?? [] : [];
    if (hookSteps.length === 0 && whileActiveSteps.length === 0) return;
    if (this.snapshot.status === 'running') this.stop();

    this.document = document;
    this.stopRequested = false;
    this.clearWaits(new Error('Lifecycle script restarted'));
    this.clearActiveDelays();
    this.channels.clear();
    this.nestedParentId = null;
    Object.keys(this.variables).forEach((key) => delete this.variables[key]);
    Object.assign(this.variables, document.variables ?? {});
    Object.keys(this.csvData).forEach((key) => delete this.csvData[key]);
    this.initializedCsvLogs.clear();
    this.csvLogPaths.clear();
    this.resetSamplingState();

    const preboundAliases = new Set<string>();
    for (const binding of bindings) {
      const alias = binding.alias.trim();
      if (!alias) continue;
      preboundAliases.add(alias);
      this.channels.set(alias, {
        ...binding,
        alias,
        closeOnCleanup: binding.closeOnCleanup ?? false,
      });
    }

    const allSteps = [
      ...(document.setup ?? []),
      ...hookSteps,
      ...whileActiveSteps,
      ...(document.teardown ?? []),
    ].filter((step) => step.enabled !== false && step.display !== 'hidden');
    const now = Date.now();
    this.snapshot = {
      status: 'running',
      scriptName: `${document.name} ${hook === 'onActivate' ? 'Activate' : 'Deactivate'}`,
      currentStepIndex: -1,
      startedAt: now,
      steps: allSteps.map((step, index) => ({
        id: step.id ?? `${step.action}-${index + 1}`,
        action: step.action,
        name: step.name,
        status: 'pending',
      })),
      logs: [],
    };
    this.emit();

    try {
      await this.loadCsvSources(document);
      await this.executeSteps(document.setup ?? [], 'setup');
      await this.executeSteps(hookSteps, hook);
      if (hook === 'onActivate') {
        await this.executeWhileActive(document);
      }
      this.snapshot = { ...this.snapshot, status: this.stopRequested ? 'stopped' : 'passed', finishedAt: Date.now() };
      this.log('pass', undefined, this.stopRequested ? 'Lifecycle script stopped' : 'Lifecycle script passed');
    } catch (error) {
      const normalizedError = normalizeRuntimeError(error);
      this.snapshot = { ...this.snapshot, status: this.stopRequested ? 'stopped' : 'failed', finishedAt: Date.now(), error: String(normalizedError) };
      this.logFailureOnce(
        this.stopRequested ? 'info' : 'error',
        undefined,
        normalizedError,
        this.stopRequested ? 'Lifecycle script stopped' : String(normalizedError),
      );
    } finally {
      try {
        await this.executeSteps(document.teardown ?? [], 'teardown', true);
      } catch (error) {
        const normalizedError = normalizeRuntimeError(error);
        this.logFailureOnce('error', undefined, normalizedError, `Teardown failed: ${String(normalizedError)}`);
      }
      await this.closeAllChannels(preboundAliases);
      this.clearWaits(new Error('Lifecycle script finished'));
      this.emit();
    }
  }

  private async executeWhileActive(document: ScriptDocument): Promise<void> {
    const steps = document.whileActive?.steps ?? [];
    if (steps.length === 0) return;

    const intervalMs = Math.max(1, toNumber(this.interpolateValue(document.whileActive?.intervalMs), 1000));
    while (!this.stopRequested) {
      await this.executeSteps(steps, 'whileActive');
      if (this.stopRequested) break;
      await this.sleepInterruptible(intervalMs);
    }
  }

  stop(): void {
    this.stopRequested = true;
    const runId = this.activeTestRunId;
    if (runId) {
      void cancelTestRun({ runId }).catch((error) => {
        this.log('error', undefined, `Failed to cancel test run ${runId}: ${String(error)}`);
      });
    }
    this.clearWaits(new Error('Script stopped'));
    this.clearActiveDelays();
    if (this.snapshot.status === 'running' || this.snapshot.status === 'paused') {
      this.snapshot = { ...this.snapshot, status: 'stopped', finishedAt: Date.now() };
      this.emit();
    }
  }

  ingest(packet: ScriptInboundPacket): boolean {
    const channel = this.findChannelByPacket(packet);
    if (!channel) return false;
    const preview = previewBytes(packet.data);
    this.log('receive', undefined, `RX ${channel?.alias ?? packet.channelId}`, preview, channel?.alias);
    this.rememberLatestPacket(channel.alias, packet);
    const generation = this.packetMatchGeneration;
    this.packetMatchQueue = this.packetMatchQueue.then(async () => {
      if (generation !== this.packetMatchGeneration) return;
      await this.matchPendingWaits(channel.alias, packet, generation);
    });
    return true;
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private flattenTopLevelSteps(document: ScriptDocument): ScriptStep[] {
    return [...(document.setup ?? []), ...(document.steps ?? []), ...(document.onStop ?? []), ...(document.teardown ?? [])]
      .filter((step) => step.enabled !== false && step.display !== 'hidden');
  }

  private async loadCsvSource(name: string, quiet = false): Promise<CsvRow[]> {
    const source = this.document?.csv?.[name];
    if (!source) throw new Error(`CSV source not loaded: ${name}`);
    const path = this.interpolate(source.path);
    if (!path) throw new Error(`CSV path is empty for source: ${name}`);

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const content = await invoke<string>('import_from_file', { path });
        const rows = parseCsv(content, source.header !== false);
        this.csvData[name] = rows;
        if (!quiet) {
          this.log('info', undefined, `Loaded CSV ${name}: ${rows.length} rows`);
        }
        return rows;
      } catch (error) {
        lastError = error;
        await sleep(50);
      }
    }
    if (this.csvData[name]?.length) {
      this.log('info', undefined, `Warning: Failed to reload CSV ${name}, using cached data: ${String(lastError)}`);
      return this.csvData[name];
    }
    throw lastError;
  }

  private async loadCsvSources(document: ScriptDocument): Promise<void> {
    const sources = document.csv ?? {};
    for (const name of Object.keys(sources)) {
      await this.loadCsvSource(name, false);
    }
  }

  private async executeSteps(steps: ScriptStep[], section: string, forceContinue = false): Promise<void> {
    for (let index = 0; index < steps.length; index += 1) {
      if (this.stopRequested && !forceContinue) throw new Error('Script stopped');
      const step = steps[index];
      if (step.enabled === false) continue;
      if (step.when !== undefined && !toConditionBoolean(this.interpolateValue(step.when))) continue;
      await this.executeStep(step, `${section}-${index + 1}`, forceContinue);
    }
  }

  private async executeStep(step: ScriptStep, fallbackId: string, forceContinue: boolean): Promise<void> {
    const stepId = step.id ? this.interpolate(step.id) : fallbackId;
    const nestedParentId = this.nestedParentId;
    const stateIndex = this.ensureStepState(step, stepId);
    const startedAt = Date.now();
    this.updateStepState(nestedParentId, stateIndex, stepId, { id: stepId, action: step.action, name: step.name, status: 'running', startedAt });
    this.snapshot = { ...this.snapshot, currentStepIndex: Math.max(0, stateIndex) };
    this.emit();

    try {
      await this.dispatchStep(step, stepId, forceContinue);
      this.updateStepState(nestedParentId, stateIndex, stepId, { status: 'passed', finishedAt: Date.now(), durationMs: Date.now() - startedAt });
      this.log('pass', stepId, `${step.action} passed`);
    } catch (error) {
      const normalizedError = normalizeRuntimeError(error);
      const message = String(normalizedError);
      this.updateStepState(nestedParentId, stateIndex, stepId, { status: 'failed', finishedAt: Date.now(), durationMs: Date.now() - startedAt, error: message });
      this.logFailureOnce('fail', stepId, normalizedError, message);
      const stopOnFailure = this.document?.defaults?.stopOnFailure ?? true;
      if (!forceContinue && step.continueOnError !== true && stopOnFailure) throw normalizedError;
    } finally {
      this.emit();
    }
  }

  private async dispatchStep(step: ScriptStep, stepId: string, forceContinue: boolean): Promise<void> {
    switch (step.action) {
      case 'open':
        await this.openChannel(step);
        return;
      case 'close':
        await this.closeChannel(step);
        return;
      case 'read':
        await this.readData(step, stepId, this.nestedParentId);
        return;
      case 'send':
        await this.sendData(step, stepId, this.nestedParentId);
        return;
      case 'wait':
        await this.waitForData(step, stepId, this.nestedParentId);
        return;
      case 'request':
        await this.request(step, stepId, this.nestedParentId);
        return;
      case 'delay':
        await this.sleepInterruptible(toNumber(this.interpolateValue(step.durationMs), 0));
        return;
      case 'repeat':
        await this.repeat(step);
        return;
      case 'group':
        if (step.childDisplay === 'nested') {
          const previousParentId = this.nestedParentId;
          this.nestedParentId = stepId;
          try {
            await this.executeSteps(step.steps, stepId, forceContinue);
          } finally {
            this.nestedParentId = previousParentId;
          }
        } else {
          await this.executeSteps(step.steps, stepId, forceContinue);
        }
        return;
      case 'forEachCsv':
        await this.forEachCsv(step);
        return;
      case 'set':
        this.variables[step.name] = this.interpolateValue(step.value);
        return;
      case 'assert':
        this.assertStep(step);
        return;
      case 'log':
        this.log('info', stepId, this.interpolate(step.message));
        return;
      case 'logCsv':
        await this.logCsv(step);
        return;
      case 'luaTool':
        await this.runLuaTool(step, stepId);
        return;
      case 'luaHelper':
        await this.runLuaHelper(step, stepId);
        return;
      case 'takeLatestPacket':
        this.takeLatestPacket(step, stepId);
        return;
      case 'testRun':
        await this.runTestRun(step, stepId);
        return;
      case 'testCatalog':
        await this.runTestCatalog(step, stepId);
        return;
      case 'testHistory':
        await this.runTestHistory(step, stepId);
        return;
    }
  }

  private async runTestCatalog(step: ScriptTestCatalogStep, stepId: string): Promise<void> {
    const projectRoot = this.interpolate(step.projectRoot).trim();
    const pythonPath = step.pythonPath ? this.interpolate(step.pythonPath).trim() : '';
    if (!projectRoot) throw new Error('testCatalog step requires projectRoot');
    const catalog = await loadTestRunnerCatalog({ projectRoot, pythonPath: pythonPath || undefined });
    this.variables[step.saveAs || 'catalog'] = catalog;
    this.log('info', stepId, `Loaded ${catalog.profiles.length} profiles and ${catalog.tests.length} tests`);
  }

  private async runTestHistory(step: ScriptTestHistoryStep, stepId: string): Promise<void> {
    const projectRoot = step.projectRoot ? this.interpolate(step.projectRoot).trim() : '';
    const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase();
    const history = (await listTestRuns())
      .filter((run) => !projectRoot || normalizePath(run.projectRoot) === normalizePath(projectRoot))
      .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0));
    this.variables[step.saveAs || 'history'] = history;
    this.log('info', stepId, `Loaded ${history.length} test runs`);
  }

  private async runTestRun(step: ScriptTestRunStep, stepId: string): Promise<void> {
    const projectRoot = this.interpolate(step.projectRoot).trim();
    const pythonPath = step.pythonPath ? this.interpolate(step.pythonPath).trim() : '';
    const profile = step.profile ? this.interpolate(step.profile).trim() : '';
    const nodeIdsValue = this.interpolateValue(step.nodeIds ?? []);
    if (!projectRoot) throw new Error('testRun step requires projectRoot');
    if (!Array.isArray(nodeIdsValue) || nodeIdsValue.some((value) => typeof value !== 'string')) {
      throw new Error('testRun nodeIds must be an array of strings');
    }

    const inputValues = this.interpolateValue(step.inputs ?? {});
    if (!inputValues || typeof inputValues !== 'object' || Array.isArray(inputValues)) {
      throw new Error('testRun inputs must be an object');
    }
    const inputs = Object.fromEntries(
      Object.entries(inputValues).map(([name, value]) => [name, unknownToString(value)]),
    );
    let selectedNodeIds = nodeIdsValue.length > 0 ? nodeIdsValue : undefined;
    let allowDestructive = toBoolean(this.interpolateValue(step.allowDestructive), false);
    if (step.catalogSource) {
      const catalogValue = this.evaluateExpression(step.catalogSource);
      if (!isTestRunnerCatalog(catalogValue)) {
        throw new Error(`testRun catalogSource '${step.catalogSource}' does not resolve to a test catalog`);
      }
      if (step.selectionMode === 'exact-or-profile' && selectedNodeIds) {
        const scopedNodeIds = filterTestRunnerNodeIds(
          catalogValue,
          profile,
          selectedNodeIds,
        );
        selectedNodeIds = scopedNodeIds.length > 0 ? scopedNodeIds : undefined;
      }
      const selection = summarizeTestRunnerSelection(
        catalogValue,
        profile,
        new Set(selectedNodeIds ?? []),
      );
      allowDestructive = allowDestructive
        || selection.danger === 'write'
        || selection.danger === 'destructive';
    }
    const catalogRevisionValue = this.interpolateValue(step.catalogRevision);
    const catalogRevision = typeof catalogRevisionValue === 'string'
      ? catalogRevisionValue.trim() || undefined
      : undefined;
    if (allowDestructive && !window.confirm(
      'This script requests destructive or device-writing tests. Continue for this run only?',
    )) {
      throw new Error('Destructive test run was not confirmed');
    }

    this.log('info', stepId, `Starting test run${profile ? ` profile=${profile}` : ''}`);
    let snapshot = await startTestRun({
      projectRoot,
      pythonPath: pythonPath || undefined,
      profile: step.selectionMode === 'exact-or-profile' && selectedNodeIds ? undefined : profile || undefined,
      nodeIds: selectedNodeIds,
      inputs,
      allowDestructive,
      ...(catalogRevision ? { catalogRevision } : {}),
    });
    this.activeTestRunId = snapshot.runId;
    const seenEvents = new Set<string>();
    let collectedEvents: TestRunLogEvent[] = [];
    let afterSeq: number | undefined;

    const consumeSnapshot = (current: TestRunSnapshot): number => {
      const newEvents: TestRunLogEvent[] = [];
      for (const event of current.logs ?? []) {
        const key = testRunEventKey(event);
        if (!rememberBoundedEventKey(seenEvents, key)) continue;
        if (Number.isFinite(event.seq)) afterSeq = Math.max(afterSeq ?? event.seq, event.seq);
        newEvents.push(event);
      }
      collectedEvents = appendBounded(collectedEvents, newEvents, MAX_SCRIPT_LOG_ENTRIES);
      this.appendLogEntries(newEvents.map((event) => ({
        id: crypto.randomUUID(),
        timestamp: event.timestamp,
        level: testRunLogLevel(event),
        stepId,
        message: formatTestRunEvent(event),
      })));
      snapshot = { ...snapshot, ...current, logs: collectedEvents };
      if (step.saveAs) this.variables[step.saveAs] = snapshot;
      this.emit();
      return current.logs?.length ?? 0;
    };

    try {
      consumeSnapshot(snapshot);
      let drainImmediately = false;
      while (!TEST_RUN_TERMINAL_STATUSES.has(snapshot.status) || drainImmediately) {
        if (this.stopRequested) {
          await cancelTestRun({ runId: snapshot.runId }).catch(() => undefined);
          throw new Error('Script stopped');
        }
        if (!drainImmediately) await this.sleepInterruptible(300);
        if (this.stopRequested) {
          await cancelTestRun({ runId: snapshot.runId }).catch(() => undefined);
          throw new Error('Script stopped');
        }
        const previousAfterSeq = afterSeq;
        const next = await getTestRun({
          runId: snapshot.runId,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          limit: TEST_RUN_LOG_PAGE_SIZE,
        });
        const pageLength = consumeSnapshot(next);
        drainImmediately = pageLength >= TEST_RUN_LOG_PAGE_SIZE && afterSeq !== previousAfterSeq;
      }

      if (step.saveAs) this.variables[step.saveAs] = snapshot;
      this.log('info', stepId, `Test run ${snapshot.runId} finished: ${snapshot.status}`);
      if (snapshot.status !== 'passed') {
        throw new Error(`Test run ${snapshot.runId} finished with status ${snapshot.status}`);
      }
    } finally {
      if (this.activeTestRunId === snapshot.runId) this.activeTestRunId = null;
    }
  }

  /**
   * Hand one step over to a tool in a Lua MCP tool script.
   *
   * The Lua side owns the whole operation — including its own timing, retries and error
   * vocabulary — so the runtime's job here is only to pass parameters, surface the result and
   * apply the declared check. Any wait inside the tool blocks this step; the step's own
   * `timeoutMs` is not a cancellation, so long operations should report progress from Lua.
   */
  private async runLuaTool(step: ScriptLuaToolStep, stepId: string): Promise<void> {
    const luaPath = this.interpolate(step.luaPath);
    const tool = this.interpolate(step.tool);
    if (!luaPath) throw new Error('luaTool step requires luaPath');
    if (!tool) throw new Error('luaTool step requires tool');
    const args = this.interpolateValue(step.args ?? {});
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      throw new Error('luaTool args must be an object');
    }

    this.log('info', stepId, `luaTool ${tool} (${luaPath})`);
    const result = await invoke<unknown>('run_mcp_tool_script_file', {
      filePath: luaPath,
      tool,
      args: args ?? {},
    });
    if (step.saveAs) this.variables[step.saveAs] = result;

    const expectPath = step.expect?.path;
    if (expectPath !== undefined || step.expect?.equals !== undefined) {
      const actual = expectPath
        ? expectPath.split('.').reduce<unknown>(
            (value, key) => (value == null ? value : (value as Record<string, unknown>)[key]),
            result,
          )
        : result;
      const expected = this.interpolateValue(step.expect?.equals);
      if (unknownToString(actual) !== unknownToString(expected)) {
        throw new Error(
          `luaTool ${tool} expected ${expectPath ?? 'result'}=${unknownToString(expected)}, ` +
            `got ${unknownToString(actual)}`,
        );
      }
    }
    this.log('info', stepId, `luaTool ${tool} -> ${JSON.stringify(result).slice(0, 400)}`);
  }

  private async callLuaHelper(
    call: ScriptLuaHelperCall,
    scope: Record<string, unknown> = {},
  ): Promise<unknown> {
    const helperName = this.interpolate(call.helper, scope).trim();
    const func = this.interpolate(call.func, scope).trim();
    if (!helperName) throw new Error('luaHelper requires helper');
    if (!func) throw new Error('luaHelper requires func');
    const definition = this.document?.helpers?.[helperName];
    if (!definition) throw new Error(`Lua helper is not declared: ${helperName}`);
    const embedded = definition.embedded === true;
    const filePath = embedded
      ? this.document?.sourcePath?.trim() ?? ''
      : this.interpolate(definition.luaPath ?? '', scope).trim();
    if (!filePath) {
      throw new Error(embedded
        ? `Embedded Lua helper ${helperName} requires a file-backed automation script`
        : `Lua helper ${helperName} has an empty luaPath`);
    }
    const args = this.interpolateValue(call.args ?? {}, scope);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`Lua helper ${helperName}.${func} args must be an object`);
    }
    return invoke<unknown>('call_lua_script_helper_file', {
      filePath,
      func,
      args,
      baseFilePath: this.document?.sourcePath,
      ...(embedded ? { embedded: true } : {}),
    });
  }

  private async runLuaHelper(step: ScriptLuaHelperStep, stepId: string): Promise<void> {
    const helperName = this.interpolate(step.helper).trim();
    const func = this.interpolate(step.func).trim();
    this.log('info', stepId, `luaHelper ${helperName}.${func}`);
    const result = await this.callLuaHelper(step);
    if (step.saveAs) this.variables[step.saveAs] = result;
    this.log('info', stepId, `luaHelper ${helperName}.${func} -> ${JSON.stringify(result).slice(0, 400)}`);
  }

  private takeLatestPacket(step: ScriptTakeLatestPacketStep, stepId: string): void {
    const alias = this.interpolate(step.channel).trim();
    this.requireChannel(alias);
    const latestPackets = this.variables.latestPackets && typeof this.variables.latestPackets === 'object'
      ? this.variables.latestPackets as Record<string, unknown>
      : {};
    const consume = step.consume === undefined ? true : toBoolean(this.interpolateValue(step.consume), true);
    const required = step.required === undefined ? false : toBoolean(this.interpolateValue(step.required), false);
    const maxAgeMs = step.maxAgeMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, toNumber(this.interpolateValue(step.maxAgeMs), 0));
    const unavailable = (reason: string): ScriptLatestPacketResult => ({
      available: false,
      reason,
      bytes: [],
      hex: '',
      text: '',
      length: 0,
    });

    let result: ScriptLatestPacketResult;
    const value = latestPackets[alias];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      result = unavailable('no packet has been received');
    } else {
      const packet = value as Record<string, unknown>;
      const sequence = toNumber(packet.sequence, 0);
      const timestamp = toNumber(packet.timestamp, 0);
      const bytes = toByteArray(packet.bytes);
      if (sequence <= 0 || timestamp <= 0 || !bytes) {
        result = unavailable('latest packet snapshot is invalid');
      } else if (consume && this.consumedPacketSequences.get(alias) === sequence) {
        result = unavailable('latest packet has already been consumed');
      } else {
        if (consume) this.consumedPacketSequences.set(alias, sequence);
        if (Date.now() - timestamp > maxAgeMs) {
          result = unavailable('latest packet is stale');
        } else {
          result = {
            available: true,
            reason: '',
            bytes,
            hex: bytesToHex(bytes),
            text: bytesToTextPreview(bytes),
            length: bytes.length,
            timestamp,
            sequence,
          };
        }
      }
    }

    this.variables[step.saveAs] = result;
    if (!result.available) {
      this.log('info', stepId, `Latest packet unavailable on ${alias}: ${result.reason}`);
      if (required) throw new Error(`Latest packet unavailable on ${alias}: ${result.reason}`);
    }
  }

  private async logCsv(step: ScriptLogCsvStep): Promise<void> {
    const target = this.interpolate(step.target);
    const config = this.document?.csvLog?.[target];
    if (!config) throw new Error(`CSV log target not found: ${target}`);
    const path = await this.resolveCsvLogPath(target, config);
    if (!path) return;
    const row = this.interpolateValue(step.row);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`logCsv row must be an object: ${target}`);
    const columns = config.columns.map((column) => this.interpolate(column));
    if (!this.initializedCsvLogs.has(target)) {
      const bom = config.bom === true ? '\uFEFF' : '';
      const header = config.header === false ? '' : `${toCsv(columns, [])}\n`;
      await invoke('export_to_file', { path, content: `${bom}${header}` });
      this.initializedCsvLogs.add(target);
    }
    await invoke('append_to_file', { path, content: `${toCsvRow(columns, row as Record<string, unknown>)}\n` });
  }

  private async resolveCsvLogPath(target: string, config: { path: string; baseDir?: 'executable' }): Promise<string> {
    const cached = this.csvLogPaths.get(target);
    if (cached) return cached;
    const relativeOrAbsolutePath = this.interpolate(config.path).trim();
    if (!relativeOrAbsolutePath) return '';
    let resolved = relativeOrAbsolutePath;
    if (config.baseDir === 'executable') {
      if (/[\\/:*?"<>|]/.test(relativeOrAbsolutePath) || relativeOrAbsolutePath === '.' || relativeOrAbsolutePath === '..') {
        throw new Error(`Executable CSV log path must be a file name: ${relativeOrAbsolutePath}`);
      }
      const executableDirectory = await invoke<string>('get_executable_directory');
      resolved = `${executableDirectory.replace(/[\\/]$/, '')}/${relativeOrAbsolutePath}`;
    }
    this.csvLogPaths.set(target, resolved);
    return resolved;
  }

  private async openChannel(step: ScriptOpenStep): Promise<void> {
    const alias = this.interpolate(step.channel);
    const params = this.interpolateRecord(step.params ?? {});
    const name = step.name ? this.interpolate(step.name) : alias;
    const uiType = step.channelType === 'serial' ? 'serial' : step.channelType === 'ble' ? 'ble' : 'tcp';
    const existingChannel = await findReusableChannel(step.channelType, name, alias, params);
    const uiChannelId = existingChannel?.id ?? useChannelStore.getState().addChannel(uiType, name);
    useChannelStore.getState().setActiveChannel(uiChannelId);

    if (step.channelType === 'serial') {
      const savedConfig = useSerialStore.getState().channelConfigs[uiChannelId];
      const config = normalizeSerialConfig({ ...savedConfig, ...params });
      if (!config.path) {
        throw new Error(`Serial channel has no saved port configuration: ${name}`);
      }
      const existingConnectionId = findSerialConnectionId(uiChannelId);
      if (existingConnectionId) {
        const openConnectionIds = await invoke<string[]>('get_serial_connections');
        if (openConnectionIds.includes(existingConnectionId)) {
          const currentBaudRate = savedConfig?.baudRate;
          const baudRateMismatch = params.baudRate !== undefined && currentBaudRate !== undefined && Number(params.baudRate) !== currentBaudRate;
          if (baudRateMismatch) {
            await invoke('close_serial_port', { connectionId: existingConnectionId });
            useSerialStore.getState().removeConnection(existingConnectionId);
          } else {
            const lifecycleSuspensionOwner = await this.suspendSerialCanvasLifecycles(uiChannelId, alias);
            this.channels.set(alias, {
              alias,
              channelType: step.channelType,
              uiChannelId,
              connectionId: existingConnectionId,
              closeOnCleanup: false,
              lifecycleSuspensionOwner,
            });
            useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
            return;
          }
        } else {
          useSerialStore.getState().removeConnection(existingConnectionId);
        }
      }
      useChannelStore.getState().updateChannelState(uiChannelId, 'connecting');
      const connectionId = await invoke<string>('open_serial_port', { config });
      const lifecycleSuspensionOwner = await this.suspendSerialCanvasLifecycles(uiChannelId, alias);
      useSerialStore.getState().setChannelConfig(uiChannelId, config);
      useSerialStore.getState().addConnection(connectionId, uiChannelId);
      useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
      this.channels.set(alias, {
        alias,
        channelType: step.channelType,
        uiChannelId,
        connectionId,
        closeOnCleanup: true,
        lifecycleSuspensionOwner,
      });
      return;
    }

    if (step.channelType === 'tcp-client') {
      const addr = buildAddress(params);
      const existingConnection = findTcpClientConnection(uiChannelId, addr);
      if (existingConnection) {
        this.channels.set(alias, { alias, channelType: step.channelType, uiChannelId, connectionId: existingConnection.id, closeOnCleanup: false });
        useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
        return;
      }
      useChannelStore.getState().updateChannelState(uiChannelId, 'connecting');
      const connectionId = await invoke<string>('tcp_connect', { addr });
      useTcpStore.getState().setChannelConfig(uiChannelId, { mode: 'client', clientAddress: addr });
      useTcpStore.getState().addClientConnection({ id: connectionId, addr }, uiChannelId);
      useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
      this.channels.set(alias, { alias, channelType: step.channelType, uiChannelId, connectionId, closeOnCleanup: true });
      return;
    }

    if (step.channelType === 'ble') {
      const bleConfig = normalizeBleConfig(params);
      const channelState = useBleStore.getState().getChannelState(uiChannelId);
      const connectedDeviceId = channelState.connectedDeviceId;
      let deviceId = bleConfig.deviceId || connectedDeviceId || useBleStore.getState().lastConnectedDeviceIds[uiChannelId] || '';
      let closeOnCleanup = false;

      if (connectedDeviceId && deviceId && connectedDeviceId !== deviceId) {
        throw new Error(`BLE channel already connected to a different device: ${connectedDeviceId}`);
      }

      if (!deviceId) {
        throw new Error(`BLE deviceId missing for ${alias}. Set params.deviceId or reuse an existing BLE channel.`);
      }

      if (!connectedDeviceId) {
        await connectBleDeviceWithRetry(uiChannelId, deviceId);
        closeOnCleanup = true;
      } else {
        deviceId = connectedDeviceId;
        useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
      }

      const subscribedCharacteristics = useBleStore.getState().getChannelState(uiChannelId).subscribedCharacteristics;
      const alreadySubscribed = subscribedCharacteristics.some(
        (item) => normalizeBleUuid(item.serviceUuid) === bleConfig.serviceUuid && normalizeBleUuid(item.charUuid) === bleConfig.charUuid
      );
      let unsubscribeOnCleanup = false;
      if (bleConfig.subscribe && !alreadySubscribed) {
        await invoke('subscribe_ble_notifications', {
          deviceId,
          serviceUuid: bleConfig.serviceUuid,
          charUuid: bleConfig.charUuid,
        });
        useBleStore.getState().addSubscription(bleConfig.serviceUuid, bleConfig.charUuid, uiChannelId);
        unsubscribeOnCleanup = true;
      }

      this.channels.set(alias, {
        alias,
        channelType: step.channelType,
        uiChannelId,
        connectionId: deviceId,
        closeOnCleanup,
        bleDeviceId: deviceId,
        bleServiceUuid: bleConfig.serviceUuid,
        bleCharUuid: bleConfig.charUuid,
        unsubscribeOnCleanup,
      });
      return;
    }

    const addr = buildAddress(params, 'localHost', 'localPort');
    const existingUdpConnectionId = findUdpConnectionId(uiChannelId, addr);
    if (existingUdpConnectionId) {
      this.channels.set(alias, { alias, channelType: step.channelType, uiChannelId, connectionId: existingUdpConnectionId, closeOnCleanup: false });
      useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
      return;
    }
    useChannelStore.getState().updateChannelState(uiChannelId, 'connecting');
    const boundAddr = await invoke<string>('udp_bind', { addr });
    useTcpStore.getState().setChannelConfig(uiChannelId, { mode: 'udp', udpBindAddress: addr });
    useTcpStore.getState().setUdpBound(true, boundAddr);
    useTcpStore.getState().setConnectionChannel(`udp:${boundAddr}`, uiChannelId);
    useChannelStore.getState().updateChannelState(uiChannelId, 'connected');
    this.channels.set(alias, { alias, channelType: step.channelType, uiChannelId, connectionId: `udp:${boundAddr}`, closeOnCleanup: true });
  }

  private async closeChannel(step: ScriptCloseStep): Promise<void> {
    const channel = this.requireChannel(step.channel);
    await this.closeRuntimeChannel(channel);
    this.channels.delete(channel.alias);
  }

  private async sendData(step: ScriptSendStep, stepId: string, parentId: string | null): Promise<void> {
    const bytes = this.resolveData(step.data);
    const channel = this.requireChannel(step.channel);
    const preview = previewBytes(bytes);
    const timestamp = Date.now();
    this.updateCurrentStepData(stepId, { sendHex: preview.hex }, parentId);
    appendTerminalTx(channel.uiChannelId, bytes, timestamp);
    await this.sendBytesToChannel(channel, bytes, step.target);
    this.log('send', stepId, `TX ${step.channel}`, preview, step.channel, timestamp);
  }

  private async readData(step: ScriptReadStep, stepId: string, parentId: string | null): Promise<ScriptInboundPacket> {
    const channel = this.requireChannel(step.channel);
    const packet = await this.readFromChannel(channel);
    const preview = previewBytes(packet.data);
    if (step.saveAs) this.variables[step.saveAs] = { bytes: packet.data, hex: preview.hex, text: preview.textPreview, length: packet.data.length };
    this.updateCurrentStepData(stepId, { receiveHex: preview.hex, textPreview: preview.textPreview }, parentId);
    this.log('receive', stepId, `READ ${step.channel}`, preview, step.channel, packet.timestamp);
    return packet;
  }

  private async waitForData(step: ScriptWaitStep, stepId: string, parentId: string | null): Promise<ScriptInboundPacket> {
    const packet = await this.waitForPacket(
      step.channel,
      this.resolveExpectation(step.expect),
      this.resolveTimeout(step.timeoutMs),
    );
    const preview = previewBytes(packet.data);
    if (step.saveAs) this.variables[step.saveAs] = { bytes: packet.data, hex: preview.hex, text: preview.textPreview, length: packet.data.length };
    this.updateCurrentStepData(stepId, { receiveHex: preview.hex, textPreview: preview.textPreview }, parentId);
    return packet;
  }

  private async request(step: ScriptRequestStep, stepId: string, parentId: string | null): Promise<void> {
    const attempts = Math.max(1, toNumber(this.interpolateValue(step.retry?.times), 1));
    const intervalMs = Math.max(0, toNumber(this.interpolateValue(step.retry?.intervalMs), 0));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const bytes = this.resolveData(step.send);
        const channel = this.requireChannel(step.channel);
        const sendPreview = previewBytes(bytes);
        const timestamp = Date.now();
        const wait = this.createPendingWait(
          step.channel,
          this.resolveExpectation(step.expect),
          this.resolveTimeout(step.timeoutMs),
        );
        this.updateCurrentStepData(stepId, { sendHex: sendPreview.hex }, parentId);
        appendTerminalTx(channel.uiChannelId, bytes, timestamp);
        try {
          await this.sendBytesToChannel(channel, bytes, step.target);
        } catch (error) {
          wait.dispose();
          throw error;
        }
        this.log('send', stepId, `TX ${step.channel} attempt ${attempt}`, sendPreview, step.channel, timestamp);
        const packet = await wait.promise;
        const receivePreview = previewBytes(packet.data);
        if (step.saveAs) this.variables[step.saveAs] = { bytes: packet.data, hex: receivePreview.hex, text: receivePreview.textPreview, length: packet.data.length };
        this.updateCurrentStepData(stepId, { receiveHex: receivePreview.hex, textPreview: receivePreview.textPreview }, parentId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < attempts && intervalMs > 0) await sleep(intervalMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async repeat(step: ScriptRepeatStep): Promise<void> {
    const times = Math.max(0, Math.trunc(toNumber(this.interpolateValue(step.times), 0)));
    const intervalMs = Math.max(0, toNumber(this.interpolateValue(step.intervalMs), 0));
    const periodMs = Math.max(0, toNumber(this.interpolateValue(step.periodMs), 0));
    if (periodMs > 0) {
      const schedule = this.interpolate(step.schedule ?? step.id ?? 'repeat');
      let nextDeadline = this.scheduledDeadlines.get(schedule) ?? (Date.now() + periodMs);
      this.scheduledDeadlines.set(schedule, nextDeadline);
      for (let index = 0; index < times; index += 1) {
        if (nextDeadline < Date.now()) {
          const skippedPeriods = Math.floor((Date.now() - nextDeadline) / periodMs) + 1;
          nextDeadline += skippedPeriods * periodMs;
          this.log('info', undefined, `Fixed schedule ${schedule} skipped ${skippedPeriods} overdue sample deadline(s)`);
        }
        await this.sleepInterruptible(Math.max(0, nextDeadline - Date.now()));
        if (this.stopRequested) throw new Error('Script stopped');
        this.variables.index = index;
        await this.executeSteps(step.steps, `repeat-${step.id ?? 'step'}-${index + 1}`);
        nextDeadline += periodMs;
        this.scheduledDeadlines.set(schedule, nextDeadline);
      }
      return;
    }
    for (let index = 0; index < times; index += 1) {
      this.variables.index = index;
      await this.executeSteps(step.steps, `repeat-${step.id ?? 'step'}-${index + 1}`);
      if (intervalMs > 0) await sleep(intervalMs);
    }
  }

  private async forEachCsv(step: ScriptForEachCsvStep): Promise<void> {
    const sourceConfig = this.document?.csv?.[step.source];
    const shouldReloadPerRow = Boolean(step.reloadPerRow || sourceConfig?.reloadPerRow);
    const rowName = step.rowAs ?? 'row';
    const loop = toBoolean(this.interpolateValue(step.loop), false);
    let csvPassIndex = 0;

    do {
      this.variables.csvPassIndex = csvPassIndex;

      if (!shouldReloadPerRow) {
        const rows = this.csvData[step.source];
        if (!rows) throw new Error(`CSV source not loaded: ${step.source}`);
        let segmentRows: CsvRow[] = [];
        let segmentIndex = 0;
        let dataRowIndex = 0;

        for (const row of rows) {
          if (this.stopRequested) throw new Error('Script stopped');
          const directive = readCsvControlDirective(row);
          if (!directive) {
            segmentRows.push(row);
            continue;
          }

          if (directive.kind === 'stop') return;
          await this.executeCsvRows(step, rowName, segmentRows, directive, segmentIndex, dataRowIndex);
          dataRowIndex += segmentRows.length * (directive.infinite ? 0 : directive.times);
          segmentRows = [];
          segmentIndex += 1;
        }

        await this.executeCsvRows(step, rowName, segmentRows, { kind: 'repeat', times: 1, infinite: false }, segmentIndex, dataRowIndex);
      } else {
        let rowIndex = 0;
        while (!this.stopRequested) {
          const rows = await this.loadCsvSource(step.source, true);
          if (rowIndex >= rows.length) {
            break;
          }
          const row = rows[rowIndex];
          const directive = readCsvControlDirective(row);
          if (directive?.kind === 'stop') {
            return;
          }

          this.variables.loopIndex = 0;
          this.variables.segmentIndex = 0;
          this.variables[rowName] = row;
          this.variables.index = rowIndex;
          this.variables.csvIndex = rowIndex;
          await this.executeSteps(step.steps, `csv-${step.source}-pass-${csvPassIndex + 1}-row-${rowIndex + 1}`);
          rowIndex += 1;
        }
      }

      csvPassIndex += 1;
    } while (loop && !this.stopRequested);
  }

  private async executeCsvRows(
    step: ScriptForEachCsvStep,
    rowName: string,
    rows: CsvRow[],
    directive: CsvControlDirective,
    segmentIndex: number,
    dataRowOffset: number,
  ): Promise<void> {
    if (rows.length === 0) return;
    let loopIndex = 0;
    while (!this.stopRequested && (directive.infinite || loopIndex < directive.times)) {
      this.variables.loopIndex = loopIndex;
      this.variables.segmentIndex = segmentIndex;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (this.stopRequested) throw new Error('Script stopped');
        this.variables[rowName] = rows[rowIndex];
        this.variables.index = rowIndex;
        this.variables.csvIndex = dataRowOffset + (loopIndex * rows.length) + rowIndex;
        await this.executeSteps(step.steps, `csv-${step.source}-segment-${segmentIndex + 1}-loop-${loopIndex + 1}-row-${rowIndex + 1}`);
      }
      loopIndex += 1;
    }
  }

  private assertStep(step: ScriptAssertStep): void {
    const left = this.interpolateValue(step.left);
    const right = this.interpolateValue(step.right);
    const leftText = unknownToString(left);
    const rightText = unknownToString(right);
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    const passed = (() => {
      switch (step.operator) {
        case '=': return leftText === rightText;
        case '!=': return leftText !== rightText;
        case '>': return leftNumber > rightNumber;
        case '>=': return leftNumber >= rightNumber;
        case '<': return leftNumber < rightNumber;
        case '<=': return leftNumber <= rightNumber;
        case 'contains': return leftText.includes(rightText);
        case 'startsWith': return leftText.startsWith(rightText);
        case 'endsWith': return leftText.endsWith(rightText);
        case 'matches': return new RegExp(rightText).test(leftText);
      }
    })();
    if (!passed) throw new Error(`Assertion failed: ${leftText} ${step.operator} ${rightText}`);
  }

  private async sendBytesToChannel(channel: RuntimeChannel, bytes: number[], target?: ScriptSendStep['target']): Promise<void> {
    if (channel.channelType === 'serial') {
      await invoke('send_serial_data', { connectionId: channel.connectionId, data: bytes });
      return;
    }
    if (channel.channelType === 'tcp-client') {
      await invoke('tcp_send', { connectionId: channel.connectionId, data: bytes });
      return;
    }
    if (channel.channelType === 'tcp-server') {
      await invoke('tcp_server_send', { clientId: channel.connectionId, data: bytes });
      return;
    }
    if (channel.channelType === 'ble') {
      if (!channel.bleDeviceId || !channel.bleServiceUuid || !channel.bleCharUuid) {
        throw new Error(`BLE target missing for ${channel.alias}`);
      }
      await invoke('write_ble_characteristic', {
        deviceId: channel.bleDeviceId,
        serviceUuid: channel.bleServiceUuid,
        charUuid: channel.bleCharUuid,
        data: bytes,
      });
      return;
    }
    const targetAddr = target?.addr ?? (target?.host && target?.port ? `${target.host}:${target.port}` : channel.targetAddr);
    if (!targetAddr) throw new Error(`UDP target missing for ${channel.alias}`);
    await invoke('udp_send', { addr: this.interpolate(targetAddr), data: bytes });
  }

  private async readFromChannel(channel: RuntimeChannel): Promise<ScriptInboundPacket> {
    if (channel.channelType !== 'ble') {
      throw new Error(`Read is only supported for BLE channels: ${channel.alias}`);
    }
    if (!channel.bleDeviceId || !channel.bleServiceUuid || !channel.bleCharUuid) {
      throw new Error(`BLE target missing for ${channel.alias}`);
    }
    const data = await invoke<number[]>('read_ble_characteristic', {
      deviceId: channel.bleDeviceId,
      serviceUuid: channel.bleServiceUuid,
      charUuid: channel.bleCharUuid,
    });
    return {
      channelId: channel.uiChannelId,
      data,
      timestamp: Date.now(),
      source: 'ble',
      deviceId: channel.bleDeviceId,
      serviceUuid: channel.bleServiceUuid,
      charUuid: channel.bleCharUuid,
    };
  }

  private waitForPacket(channelAlias: string, expect: ScriptExpectSpec, timeoutMs: number): Promise<ScriptInboundPacket> {
    return this.createPendingWait(channelAlias, expect, timeoutMs).promise;
  }

  private createPendingWait(channelAlias: string, expect: ScriptExpectSpec, timeoutMs: number): PendingWaitHandle {
    this.requireChannel(channelAlias);
    let active = true;
    let wait!: PendingWait;
    const dispose = () => {
      if (!active) return;
      active = false;
      window.clearTimeout(wait.timeoutId);
      this.removePendingWait(wait);
    };
    const promise = new Promise<ScriptInboundPacket>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!active) return;
        active = false;
        this.removePendingWait(wait);
        reject(new Error(`Timeout waiting for ${channelAlias}`));
      }, timeoutMs);
      wait = {
        channelAlias,
        expect,
        resolve: (packet) => {
          if (!active) return;
          active = false;
          window.clearTimeout(timeoutId);
          this.removePendingWait(wait);
          resolve(packet);
        },
        reject: (error) => {
          if (!active) return;
          active = false;
          window.clearTimeout(timeoutId);
          this.removePendingWait(wait);
          reject(error);
        },
        timeoutId,
        buffer: [],
      };
      this.pendingWaits.push(wait);
    });
    return { dispose, promise };
  }

  private requireChannel(aliasValue: string): RuntimeChannel {
    const alias = this.interpolate(aliasValue);
    const channel = this.channels.get(alias);
    if (!channel) throw new Error(`Channel not open: ${alias}`);
    return channel;
  }

  private findChannelByPacket(packet: ScriptInboundPacket): RuntimeChannel | undefined {
    for (const channel of this.channels.values()) {
      if (channel.channelType === 'ble') {
        if (channel.uiChannelId !== packet.channelId) continue;
        if (packet.deviceId && channel.bleDeviceId && packet.deviceId !== channel.bleDeviceId) continue;
        if (packet.serviceUuid && channel.bleServiceUuid && normalizeBleUuid(packet.serviceUuid) !== channel.bleServiceUuid) continue;
        if (packet.charUuid && channel.bleCharUuid && normalizeBleUuid(packet.charUuid) !== channel.bleCharUuid) continue;
        return channel;
      }
      if (channel.uiChannelId === packet.channelId) return channel;
      if (channel.connectionId === packet.connectionId) return channel;
      if (channel.connectionId === `udp:${packet.localAddr}`) return channel;
    }
    return undefined;
  }

  private async closeAllChannels(preserveAliases = new Set<string>()): Promise<void> {
    for (const channel of [...this.channels.values()].reverse()) {
      if (preserveAliases.has(channel.alias) && !channel.closeOnCleanup) continue;
      try {
        await this.closeRuntimeChannel(channel);
      } catch (error) {
        this.log('error', undefined, `Close ${channel.alias} failed: ${String(error)}`);
      }
    }
    this.channels.clear();
  }

  private async closeRuntimeChannel(channel: RuntimeChannel): Promise<void> {
    if (channel.channelType === 'ble') {
      if (channel.unsubscribeOnCleanup && channel.bleDeviceId && channel.bleServiceUuid && channel.bleCharUuid) {
        await invoke('unsubscribe_ble_notifications', {
          deviceId: channel.bleDeviceId,
          serviceUuid: channel.bleServiceUuid,
          charUuid: channel.bleCharUuid,
        });
        useBleStore.getState().removeSubscription(channel.bleServiceUuid, channel.bleCharUuid, channel.uiChannelId);
      }

      if (channel.closeOnCleanup && channel.bleDeviceId) {
        await invoke('disconnect_ble_device', { deviceId: channel.bleDeviceId });
        useBleStore.getState().clearChannelConnection(channel.uiChannelId);
        useChannelStore.getState().updateChannelState(channel.uiChannelId, 'disconnected');
      }
      return;
    }

    if (channel.channelType === 'serial') {
      try {
        if (channel.closeOnCleanup) {
          try {
            await invoke('close_serial_port', { connectionId: channel.connectionId });
          } catch (error) {
            if (!String(error).includes(`Connection not found: ${channel.connectionId}`)) throw error;
          }
          useSerialStore.getState().removeConnection(channel.connectionId);
          useChannelStore.getState().updateChannelState(channel.uiChannelId, 'disconnected');
        }
      } finally {
        await this.resumeSerialCanvasLifecycles(channel, !channel.closeOnCleanup);
      }
      return;
    }

    if (!channel.closeOnCleanup) return;
    if (channel.channelType === 'tcp-client') {
      await invoke('tcp_disconnect', { connectionId: channel.connectionId });
      useTcpStore.getState().removeClientConnection(channel.connectionId);
    } else {
      await invoke('udp_unbind');
      useTcpStore.getState().setUdpBound(false);
      useTcpStore.getState().removeConnectionMapping(channel.connectionId);
    }
    useChannelStore.getState().updateChannelState(channel.uiChannelId, 'disconnected');
  }

  private async suspendSerialCanvasLifecycles(channelId: string, alias: string): Promise<string | undefined> {
    if (this.runtimeId.startsWith('lifecycle:')) return undefined;
    const ownerId = `${this.runtimeId}:${alias}`;
    await acquireChannelRuntimeLease(channelId, ownerId);
    return ownerId;
  }

  private async resumeSerialCanvasLifecycles(channel: RuntimeChannel, resume: boolean): Promise<void> {
    if (!channel.lifecycleSuspensionOwner) return;
    await releaseChannelRuntimeLease(channel.uiChannelId, channel.lifecycleSuspensionOwner, resume);
  }

  private resolveData(spec: ScriptDataSpec): number[] {
    return parseDataSpec(spec.format ?? this.document?.defaults?.dataFormat, this.interpolateValue(spec.value));
  }

  private resolveTimeout(value: unknown): number {
    return Math.max(1, toNumber(this.interpolateValue(value), this.document?.defaults?.timeoutMs ?? 2000));
  }

  private interpolateRecord(record: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, this.interpolateValue(value)]));
  }

  private resolveExpectation(expect: ScriptExpectSpec): ScriptExpectSpec {
    const { luaHelper, ...base } = expect;
    return {
      ...this.interpolateValue(base) as ScriptExpectSpec,
      ...(luaHelper ? { luaHelper } : {}),
    };
  }

  private interpolateValue(value: unknown, scope: Record<string, unknown> = {}): unknown {
    if (typeof value === 'string') return this.interpolate(value, scope);
    if (Array.isArray(value)) return value.map((item) => this.interpolateValue(item, scope));
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (Object.keys(object).length === 1 && typeof object.$ref === 'string') {
        return this.evaluateExpression(object.$ref, scope);
      }
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.interpolateValue(item, scope)]));
    }
    return value;
  }

  private interpolate(text: string, scope: Record<string, unknown> = {}): string {
    return text.replace(/\$\{([^}]+)\}/g, (_, expression: string) => unknownToString(this.evaluateExpression(expression.trim(), scope)));
  }

  private evaluateExpression(expression: string, scope: Record<string, unknown> = {}): unknown {
    const helperCall = parseHelperCall(expression);
    if (helperCall?.name === 'secondsToMs') {
      return Math.round(toNumber(this.evaluateExpressionArgument(helperCall.args[0], scope), 0) * 1000);
    }
    if (helperCall?.name === 'delayToMs') {
      const [secondsExpression, millisecondsExpression] = helperCall.args;
      const milliseconds = this.evaluateExpressionArgument(millisecondsExpression, scope);
      if (milliseconds !== '') return Math.round(toNumber(milliseconds, 0));
      return Math.round(toNumber(this.evaluateExpressionArgument(secondsExpression, scope), 0) * 1000);
    }
    if (helperCall?.name === 'now') {
      return new Date().toLocaleString();
    }
    if (helperCall?.name === 'nowIso') {
      return new Date().toISOString();
    }
    if (helperCall?.name === 'nowTime') {
      return formatLocalTimeSeconds(Date.now());
    }
    if (helperCall?.name === 'nowDateTime') {
      return formatLocalDateTimeSeconds(Date.now());
    }
    if (helperCall?.name === 'nowLocalTimestamp') {
      return formatLocalTimestamp(Date.now());
    }
    if (helperCall?.name === 'nowLocalTimestampSpace') {
      return formatLocalTimestamp(Date.now(), ' ');
    }
    if (helperCall?.name === 'runTimestamp') {
      return formatFileTimestamp(this.snapshot.startedAt ?? Date.now());
    }
    return readPath(this.buildExpressionSource(scope), expression);
  }

  private evaluateExpressionArgument(expression: string | undefined, scope: Record<string, unknown> = {}): unknown {
    if (!expression) return '';
    const trimmed = expression.trim();
    if (parseHelperCall(trimmed)) return this.evaluateExpression(trimmed, scope);
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;
    return readPath(this.buildExpressionSource(scope), trimmed);
  }

  private buildExpressionSource(scope: Record<string, unknown>): Record<string, unknown> {
    return { ...this.variables, ...scope };
  }

  private async matchesPacketExpectation(packet: ScriptInboundPacket, expect: ScriptExpectSpec): Promise<boolean> {
    if (!matchesExpectation(packet.data, expect)) return false;
    const packetValue = {
      ...packet,
      bytes: [...packet.data],
      hex: bytesToHex(packet.data),
      text: bytesToTextPreview(packet.data),
      length: packet.data.length,
    };
    const scope = { packet: packetValue };
    if (!expect.luaHelper) return true;

    const result = await this.callLuaHelper(expect.luaHelper, scope);
    const resultPath = expect.luaHelper.resultPath
      ? this.interpolate(expect.luaHelper.resultPath, scope).trim()
      : '';
    const selected = resultPath
      ? readUnknownPath(result, resultPath)
      : result;
    if (Object.prototype.hasOwnProperty.call(expect.luaHelper, 'equals')) {
      return unknownToString(selected) === unknownToString(this.interpolateValue(expect.luaHelper.equals, scope));
    }
    return toBoolean(selected, false);
  }

  private updateStep(index: number, updates: Partial<ScriptRuntimeStepState>): void {
    if (index < 0) return;
    this.snapshot = {
      ...this.snapshot,
      steps: this.snapshot.steps.map((step, stepIndex) => stepIndex === index ? { ...step, ...updates } : step),
    };
  }

  private updateStepState(parentId: string | null, index: number, stepId: string, updates: Partial<ScriptRuntimeStepState>): void {
    if (parentId) {
      this.updateNestedStep(parentId, stepId, updates);
      return;
    }
    this.updateStep(index, updates);
  }

  private updateNestedStep(parentId: string, childId: string, updates: Partial<ScriptRuntimeStepState>): void {
    this.snapshot = {
      ...this.snapshot,
      steps: this.snapshot.steps.map((step) => {
        if (step.id !== parentId) return step;
        const children = step.children ?? [];
        return {
          ...step,
          children: children.map((child) => child.id === childId ? { ...child, ...updates } : child),
        };
      }),
    };
  }

  private updateCurrentStepData(stepId: string, updates: Partial<ScriptRuntimeStepState>, parentId: string | null = null): void {
    if (parentId) {
      this.updateNestedStep(parentId, stepId, updates);
      return;
    }
    const index = this.snapshot.steps.findIndex((step) => step.id === stepId);
    this.updateStep(index, updates);
  }

  private appendLogEntries(entries: ScriptLogEntry[]): void {
    if (entries.length === 0) return;
    const configuredLimit = this.document?.defaults?.logLimit ?? 500;
    const limit = Number.isFinite(configuredLimit)
      ? Math.min(MAX_SCRIPT_LOG_ENTRIES, Math.max(1, Math.trunc(configuredLimit)))
      : 500;
    this.snapshot = {
      ...this.snapshot,
      logs: appendBounded(this.snapshot.logs, entries, limit),
    };
    this.emit();
  }

  private async packetMatchingWait(packet: ScriptInboundPacket, wait: PendingWait): Promise<ScriptInboundPacket | null> {
    if (!wait.expect.accumulate) return await this.matchesPacketExpectation(packet, wait.expect) ? packet : null;

    wait.buffer.push(...packet.data);
    const expectedLength = Math.max(0, Math.trunc(toNumber(wait.expect.length, 0)));
    if (expectedLength <= 0) {
      const accumulated = { ...packet, data: [...wait.buffer] };
      return await this.matchesPacketExpectation(accumulated, wait.expect) ? accumulated : null;
    }

    const prefix = wait.expect.format !== 'text' && wait.expect.startsWith
      ? toByteArray(wait.expect.startsWith)
      : null;
    while (wait.buffer.length >= expectedLength) {
      let start = 0;
      if (prefix && prefix.length > 0) {
        start = findByteSequence(wait.buffer, prefix);
        if (start < 0) {
          const keep = Math.max(0, prefix.length - 1);
          if (wait.buffer.length > keep) wait.buffer.splice(0, wait.buffer.length - keep);
          return null;
        }
        if (start > 0) wait.buffer.splice(0, start);
        if (wait.buffer.length < expectedLength) return null;
      }
      const candidate = { ...packet, data: wait.buffer.slice(0, expectedLength) };
      if (await this.matchesPacketExpectation(candidate, wait.expect)) return candidate;
      wait.buffer.shift();
    }
    return null;
  }

  private async matchPendingWaits(
    channelAlias: string,
    packet: ScriptInboundPacket,
    generation: number,
  ): Promise<void> {
    for (const wait of [...this.pendingWaits]) {
      if (generation !== this.packetMatchGeneration) return;
      if (channelAlias !== wait.channelAlias || !this.pendingWaits.includes(wait)) continue;
      try {
        const matchedPacket = await this.packetMatchingWait(packet, wait);
        if (generation !== this.packetMatchGeneration || !this.pendingWaits.includes(wait)) continue;
        if (matchedPacket) wait.resolve(matchedPacket);
      } catch (error) {
        if (this.pendingWaits.includes(wait)) {
          wait.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
  }

  private rememberLatestPacket(alias: string, packet: ScriptInboundPacket): void {
    const latestPackets = this.variables.latestPackets && typeof this.variables.latestPackets === 'object'
      ? this.variables.latestPackets as Record<string, unknown>
      : {};
    this.latestPacketSequence += 1;
    latestPackets[alias] = {
      ...packet,
      alias,
      sequence: this.latestPacketSequence,
      bytes: [...packet.data],
      hex: bytesToHex(packet.data),
      length: packet.data.length,
    };
    this.variables.latestPackets = latestPackets;
  }

  private resetSamplingState(): void {
    this.packetMatchGeneration += 1;
    this.packetMatchQueue = Promise.resolve();
    this.reportedFailures = new WeakSet<Error>();
    this.scheduledDeadlines.clear();
    this.consumedPacketSequences.clear();
    this.latestPacketSequence = 0;
    this.variables.latestPackets = {};
  }

  private log(level: ScriptLogEntry['level'], stepId: string | undefined, message: string, data?: ScriptLogEntry['data'], channel?: string, timestamp = Date.now()): void {
    this.appendLogEntries([{
      id: crypto.randomUUID(),
      timestamp,
      level,
      stepId,
      channel,
      message,
      data,
    }]);
  }

  private logFailureOnce(
    level: ScriptLogEntry['level'],
    stepId: string | undefined,
    error: Error,
    message: string,
  ): void {
    if (this.reportedFailures.has(error)) return;
    this.reportedFailures.add(error);
    this.log(level, stepId, message);
  }

  private ensureStepState(step: ScriptStep, stepId: string): number {
    if (step.display === 'hidden') return -1;
    if (this.nestedParentId) {
      this.ensureNestedStepState(this.nestedParentId, step, stepId);
      return -1;
    }
    const existingIndex = this.snapshot.steps.findIndex((item) => item.id === stepId);
    if (existingIndex >= 0) return existingIndex;
    const nextStep: ScriptRuntimeStepState = {
      id: stepId,
      action: step.action,
      name: step.name,
      status: 'pending',
    };
    const nextSteps = [...this.snapshot.steps, nextStep];
    this.snapshot = { ...this.snapshot, steps: nextSteps };
    return nextSteps.length - 1;
  }

  private ensureNestedStepState(parentId: string, step: ScriptStep, stepId: string): void {
    this.snapshot = {
      ...this.snapshot,
      steps: this.snapshot.steps.map((parent) => {
        if (parent.id !== parentId) return parent;
        const children = parent.children ?? [];
        if (children.some((child) => child.id === stepId)) return parent;
        return {
          ...parent,
          children: [...children, { id: stepId, action: step.action, name: step.name, status: 'pending' }],
        };
      }),
    };
  }

  private emit(): void {
    this.snapshot = { ...this.snapshot, variables: { ...this.variables } };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private removePendingWait(wait: PendingWait): void {
    const index = this.pendingWaits.indexOf(wait);
    if (index >= 0) this.pendingWaits.splice(index, 1);
  }

  private clearWaits(error: Error): void {
    for (const wait of [...this.pendingWaits]) {
      window.clearTimeout(wait.timeoutId);
      wait.reject(error);
      this.removePendingWait(wait);
    }
  }

  private clearActiveDelays(): void {
    for (const [timeoutId, resolve] of [...this.activeDelayResolvers.entries()]) {
      window.clearTimeout(timeoutId);
      this.activeDelayResolvers.delete(timeoutId);
      resolve();
    }
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || this.stopRequested) {
        resolve();
        return;
      }
      const timeoutId = window.setTimeout(() => {
        this.activeDelayResolvers.delete(timeoutId);
        resolve();
      }, ms);
      this.activeDelayResolvers.set(timeoutId, resolve);
    });
  }
}

const runtimes = new Map<string, ScriptRuntime>();

export function getScriptRuntime(canvasId: string): ScriptRuntime {
  let runtime = runtimes.get(canvasId);
  if (!runtime) {
    runtime = new ScriptRuntime(canvasId);
    runtimes.set(canvasId, runtime);
  }
  return runtime;
}

export function disposeScriptRuntime(canvasId: string): void {
  const runtime = runtimes.get(canvasId);
  runtime?.dispose();
  runtimes.delete(canvasId);
}

export function ingestScriptPacket(canvasId: string, packet: ScriptInboundPacket): boolean {
  return runtimes.get(canvasId)?.ingest(packet) ?? false;
}

function normalizeSerialConfig(params: Record<string, unknown>): SerialConfig {
  return {
    path: normalizeSerialPortPath(params.path),
    baudRate: toNumber(params.baudRate, 115200),
    dataBits: normalizeUnionNumber(params.dataBits, [5, 6, 7, 8], 8),
    stopBits: normalizeUnionNumber(params.stopBits, [1, 2], 1),
    parity: normalizeUnionString(params.parity, ['none', 'odd', 'even'], 'none'),
    flowControl: normalizeUnionString(params.flowControl, ['none', 'rts_cts', 'dtr_dsr', 'xon_xoff'], 'none'),
    receiveTimeoutMs: Math.max(1, Math.trunc(toNumber(params.receiveTimeoutMs, 50))),
  };
}

function normalizeSerialPortPath(value: unknown): string {
  const path = unknownToString(value).trim();
  const windowsComMatch = path.match(/^(?:\\\\\.\\)?com(\d+)$/i) ?? path.match(/^(\d+)$/);
  if (!windowsComMatch) return path;
  return `COM${Number.parseInt(windowsComMatch[1], 10)}`;
}

function serialPortPathsEqual(left: unknown, right: unknown): boolean {
  return normalizeSerialPortPath(left).toLowerCase() === normalizeSerialPortPath(right).toLowerCase();
}

interface BleOpenConfig {
  deviceId: string;
  serviceUuid: string;
  charUuid: string;
  subscribe: boolean;
  useActiveChannel: boolean;
}

function normalizeBleUuid(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeBleConfig(params: Record<string, unknown>): BleOpenConfig {
  const serviceUuid = normalizeBleUuid(params.serviceUuid);
  const charUuid = normalizeBleUuid(params.charUuid);
  if (!serviceUuid || !charUuid) {
    throw new Error('BLE open params.serviceUuid and params.charUuid are required');
  }
  const subscribe = params.subscribe === undefined ? true : String(params.subscribe).toLowerCase() !== 'false';
  const useActiveChannel = String(params.useActiveChannel ?? '').toLowerCase() === 'true';
  return {
    deviceId: String(params.deviceId ?? '').trim(),
    serviceUuid,
    charUuid,
    subscribe,
    useActiveChannel,
  };
}

async function connectBleDeviceWithRetry(channelId: string, deviceId: string): Promise<void> {
  try {
    await connectBleDevice(channelId, deviceId);
    return;
  } catch (initialError) {
    await scanForBleReconnect(channelId, 3000);
    try {
      await connectBleDevice(channelId, deviceId);
      return;
    } catch {
      await scanForBleReconnect(channelId, 10000);
      await connectBleDevice(channelId, deviceId).catch((retryError) => {
        throw retryError instanceof Error ? retryError : initialError;
      });
    }
  }
}

async function connectBleDevice(channelId: string, deviceId: string): Promise<void> {
  useChannelStore.getState().updateChannelState(channelId, 'connecting');
  try {
    await invoke('connect_ble_device', { deviceId });
    useChannelStore.getState().updateChannelState(channelId, 'connected');
    useBleStore.getState().setConnectedDeviceId(deviceId, channelId);
    useBleStore.getState().setLastConnectedDeviceId(channelId, deviceId);

    const bleState = useBleStore.getState();
    const knownDevice = bleState.getChannelState(channelId).devices.find((device) => device.id === deviceId)
      ?? bleState.devices.find((device) => device.id === deviceId)
      ?? bleState.getLastConnectedDeviceForChannel(channelId);
    if (knownDevice) {
      useBleStore.getState().setLastConnectedDevice(channelId, knownDevice);
    }

    const services = await invoke<GattService[]>('get_gatt_services', { deviceId });
    useBleStore.getState().setGattServices(services, channelId);
  } catch (error) {
    useChannelStore.getState().updateChannelState(channelId, 'error');
    throw error;
  }
}

async function scanForBleDevices(
  channelId: string | undefined,
  durationMs: number,
  shouldStop?: () => boolean,
): Promise<void> {
  const bleStore = useBleStore.getState();
  if (bleStore.scanning) {
    await stopBleScan();
  }

  bleStore.clearDevices(channelId);
  await invoke('start_ble_scan');
  useBleStore.getState().setScanning(true, channelId);

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < durationMs) {
      const devices = await invoke<BleDevice[]>('get_ble_devices');
      useBleStore.getState().setDevices(devices, channelId);
      if (shouldStop?.()) return;
      await sleep(1000);
    }
  } finally {
    await stopBleScan();
  }
}

async function scanForBleReconnect(channelId: string, durationMs: number): Promise<void> {
  await scanForBleDevices(channelId, durationMs);
}

async function scanForBleDeviceByName(
  channelId: string | undefined,
  name: string,
  durationMs: number,
): Promise<void> {
  await scanForBleDevices(channelId, durationMs, () => Boolean(findBleDeviceByName(name)));
}

async function stopBleScan(): Promise<void> {
  try {
    await invoke('stop_ble_scan');
  } finally {
    useBleStore.getState().setScanning(false);
  }
}

async function findReusableChannel(
  channelType: 'serial' | 'tcp-client' | 'udp' | 'ble',
  name: string,
  alias: string,
  params: Record<string, unknown>,
): Promise<Channel | undefined> {
  const uiType = channelType === 'serial' ? 'serial' : channelType === 'ble' ? 'ble' : 'tcp';
  const channels = useChannelStore.getState().channels.filter((channel) => channel.type === uiType);

  if (Object.prototype.hasOwnProperty.call(params, 'channelId')) {
    const channelId = String(params.channelId ?? '').trim();
    if (!channelId) throw new Error(`Select an open ${channelType} channel before running this script.`);
    const selectedChannel = useChannelStore.getState().channels.find((channel) => channel.id === channelId);
    if (selectedChannel) {
      if (selectedChannel.type !== uiType) {
        throw new Error(`Selected channel has type ${selectedChannel.type}, expected ${uiType}: ${selectedChannel.name}`);
      }
      return selectedChannel;
    }
    if (channelType === 'serial') {
      // Free-typed COM port: reuse a serial channel configured with that port, or open a new one.
      params.path = normalizeSerialPortPath(channelId);
      const serialConfigs = useSerialStore.getState().channelConfigs;
      return channels.find((channel) =>
        serialPortPathsEqual(serialConfigs[channel.id]?.path, params.path));
    }
    if (channelType === 'ble') {
      const activeChannelId = useChannelStore.getState().activeChannelId;
      const fallbackChannel = channels.find((channel) => channel.id === activeChannelId) ?? channels[0];
      let device = findBleDeviceByName(channelId);
      if (!device) {
        await scanForBleDeviceByName(fallbackChannel?.id, channelId, 10_000);
        device = findBleDeviceByName(channelId);
      }
      if (!device) {
        throw new Error(`No BLE device matches name after automatic scan: ${channelId}. Make sure the device is awake, advertising, and not connected to another host.`);
      }
      params.deviceId = device.id;
      return device.channelId
        ? channels.find((channel) => channel.id === device.channelId) ?? fallbackChannel
        : fallbackChannel;
    }
    throw new Error(`Remembered channel no longer exists: ${channelId}`);
  }

  if (channelType === 'ble') {
    const useActiveChannel = String(params.useActiveChannel ?? '').toLowerCase() === 'true';
    if (useActiveChannel) {
      const activeChannelId = useChannelStore.getState().activeChannelId;
      const activeChannel = activeChannelId
        ? useChannelStore.getState().channels.find((channel) => channel.id === activeChannelId)
        : undefined;
      if (!activeChannel) {
        throw new Error('No active channel selected. Select a BLE channel before running this script.');
      }
      if (activeChannel.type !== 'ble') {
        throw new Error(`Active channel is not BLE: ${activeChannel.name}`);
      }
      return activeChannel;
    }
  }

  const byName = channels.find((channel) => channel.name === name || channel.name === alias);
  if (byName) return byName;

  if (channelType === 'serial') {
    const config = normalizeSerialConfig(params);
    return channels.find((channel) =>
      serialPortPathsEqual(useSerialStore.getState().channelConfigs[channel.id]?.path, config.path));
  }

  if (channelType === 'tcp-client') {
    const addr = buildAddress(params);
    return channels.find((channel) => {
      const config = useTcpStore.getState().channelConfigs[channel.id];
      return config?.mode === 'client' && config.clientAddress === addr;
    });
  }

  if (channelType === 'ble') {
    const deviceId = String(params.deviceId ?? '').trim();
    if (!deviceId) return undefined;
    const bleState = useBleStore.getState();
    return channels.find((channel) =>
      bleState.getConnectedDeviceIdForChannel(channel.id) === deviceId
      || bleState.lastConnectedDeviceIds[channel.id] === deviceId
    );
  }

  const addr = buildAddress(params, 'localHost', 'localPort');
  return channels.find((channel) => {
    const config = useTcpStore.getState().channelConfigs[channel.id];
    return config?.mode === 'udp' && config.udpBindAddress === addr;
  });
}

function findBleDeviceByName(name: string): { id: string; channelId: string | undefined } | undefined {
  const bleState = useBleStore.getState();
  const target = name.trim().toLowerCase();
  const matches = (device: { name?: string | null; advertisementName?: string | null }): boolean =>
    (device.name ?? '').trim().toLowerCase() === target
    || (device.advertisementName ?? '').trim().toLowerCase() === target;

  const bleChannels = useChannelStore.getState().channels.filter((channel) => channel.type === 'ble');
  for (const channel of bleChannels) {
    const channelState = bleState.getChannelState(channel.id);
    const connected = channelState.connectedDeviceId
      ? channelState.devices.find((device) => device.id === channelState.connectedDeviceId)
        ?? bleState.getLastConnectedDeviceForChannel(channel.id)
      : undefined;
    if (connected && matches(connected)) return { id: connected.id, channelId: channel.id };
  }
  for (const channel of bleChannels) {
    const last = bleState.getLastConnectedDeviceForChannel(channel.id);
    if (last && matches(last)) return { id: last.id, channelId: channel.id };
  }
  for (const channel of bleChannels) {
    const device = bleState.getChannelState(channel.id).devices.find(matches);
    if (device) return { id: device.id, channelId: channel.id };
  }
  const scanned = bleState.devices.find(matches);
  return scanned ? { id: scanned.id, channelId: undefined } : undefined;
}

function findSerialConnectionId(channelId: string): string | undefined {
  return Object.entries(useSerialStore.getState().connectionMap)
    .find(([, mappedChannelId]) => mappedChannelId === channelId)?.[0];
}

function findTcpClientConnection(channelId: string, addr: string): { id: string; addr: string } | undefined {
  const tcpState = useTcpStore.getState();
  return tcpState.clientConnections.find((connection) =>
    connection.addr === addr && tcpState.connectionMap[connection.id] === channelId
  );
}

function findUdpConnectionId(channelId: string, addr: string): string | undefined {
  const tcpState = useTcpStore.getState();
  const configuredId = Object.entries(tcpState.connectionMap)
    .find(([connectionId, mappedChannelId]) => mappedChannelId === channelId && connectionId.startsWith('udp:'))?.[0];
  if (configuredId) return configuredId;
  if (tcpState.udpBound && tcpState.udpAddr === addr) return `udp:${tcpState.udpAddr}`;
  return undefined;
}

function appendTerminalTx(channelId: string, bytes: number[], timestamp?: number): void {
  const txLine = `TX(HEX): ${bytesToHex(bytes)}`;
  useTerminalStore.getState().appendEntryToChannel(channelId, 'tx', txLine, timestamp);
}

function toCsvRow(columns: string[], row: Record<string, unknown>): string {
  return columns.map((column) => csvEscape(row[column])).join(',');
}

function normalizeUnionNumber<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  const numeric = Number(value);
  return allowed.includes(numeric as T) ? numeric as T : fallback;
}

function normalizeUnionString<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(String(value) as T) ? String(value) as T : fallback;
}

function toNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function readCsvControlDirective(row: Record<string, string>): CsvControlDirective | undefined {
  const values = Object.values(row).map((value) => value.trim());
  for (const value of values) {
    if (value === '?*') return { kind: 'repeat', times: 0, infinite: true };
    const match = /^\?(\d+)$/.exec(value);
    if (match) {
      const times = Number(match[1]);
      return times === 0
        ? { kind: 'stop', times: 0, infinite: false }
        : { kind: 'repeat', times, infinite: false };
    }
  }
  return values.some((value) => value === '') ? { kind: 'stop', times: 0, infinite: false } : undefined;
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return '';
  }, source);
}

function readUnknownPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function parseHelperCall(expression: string): { name: string; args: string[] } | null {
  const match = /^(\w+)\((.*)\)$/.exec(expression);
  if (!match) return null;
  return {
    name: match[1],
    args: match[2].split(',').map((arg) => arg.trim()),
  };
}

function toConditionBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized !== '' && !['false', '0', 'no', 'off'].includes(normalized);
  }
  return value !== null && value !== undefined;
}

function formatFileTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${milliseconds}`;
}

function toByteArray(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const bytes = value.map((item) => Number(item));
    return bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255) ? bytes : null;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return parseDataSpec('hex', value);
    } catch {
      return null;
    }
  }
  return null;
}

function findByteSequence(bytes: number[], prefix: number[]): number {
  if (prefix.length === 0) return 0;
  for (let index = 0; index <= bytes.length - prefix.length; index += 1) {
    if (prefix.every((byte, prefixIndex) => bytes[index + prefixIndex] === byte)) return index;
  }
  return -1;
}

function formatLocalTimestamp(timestamp: number, millisecondSeparator = '.'): string {
  const date = new Date(timestamp);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${millisecondSeparator}${pad(date.getMilliseconds(), 3)}`;
}

function formatLocalTimeSeconds(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatLocalDateTimeSeconds(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function matchesExpectation(bytes: number[], expect: ScriptExpectSpec): boolean {
  if (expect.length !== undefined && bytes.length !== expect.length) return false;
  const format = expect.format ?? 'hex';
  const actual = format === 'text' ? bytesToTextPreview(bytes) : bytesToHex(bytes);
  const comparable = format === 'hex' ? normalizeHex(actual) : actual;
  if (expect.equals !== undefined) {
    const expected = format === 'hex' ? normalizeHex(String(expect.equals)) : String(expect.equals);
    if (comparable !== expected) return false;
  }
  if (expect.contains !== undefined) {
    const expected = format === 'hex' ? normalizeHex(expect.contains) : expect.contains;
    if (!comparable.includes(expected)) return false;
  }
  if (expect.startsWith !== undefined) {
    const expected = format === 'hex' ? normalizeHex(expect.startsWith) : expect.startsWith;
    if (!comparable.startsWith(expected)) return false;
  }
  if (expect.endsWith !== undefined) {
    const expected = format === 'hex' ? normalizeHex(expect.endsWith) : expect.endsWith;
    if (!comparable.endsWith(expected)) return false;
  }
  if (expect.regex !== undefined && !new RegExp(expect.regex).test(actual)) return false;
  return true;
}
