import React, { useEffect, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  summarizeTestRunnerSelection,
  testsForTestRunnerProfile,
} from '../../lib/testRunnerSelection';
import type { TestRunSnapshot, TestRunnerCatalog } from '../../types';
import type {
  ScriptRuntimeSnapshot,
  ScriptUiControl,
  ScriptUiDocument,
  ScriptUiOptionSource,
  ScriptUiStaticOption,
} from './scriptTypes';
import { readUiPath, resolveUiSource, setUiPath } from './scriptUiUtils';

interface ScriptCanvasUiProps {
  ui: ScriptUiDocument;
  values: Record<string, unknown>;
  sources?: Record<string, unknown>;
  snapshot: ScriptRuntimeSnapshot;
  onValuesChange: (values: Record<string, unknown>) => void;
  onAction: (action: string, options?: { preserveLogs?: boolean }) => void;
}

function statusClass(status?: string): string {
  switch (status) {
    case 'running':
    case 'queued': return 'text-accent-blue';
    case 'passed': return 'text-accent-green';
    case 'stopped':
    case 'cancelled': return 'text-yellow-400';
    case 'failed':
    case 'blocked':
    case 'error': return 'text-red-400';
    default: return 'text-text-muted';
  }
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export function formatStepTimestamp(timestamp?: number, format: 'time' | 'datetime' | 'none' = 'time'): string | null {
  if (!timestamp || format === 'none') return null;
  const d = new Date(timestamp);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (format === 'datetime') {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
  }
  return time;
}

function isCatalog(value: unknown): value is TestRunnerCatalog {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as TestRunnerCatalog).tests));
}

function isTestRun(value: unknown): value is TestRunSnapshot {
  return Boolean(value && typeof value === 'object' && typeof (value as TestRunSnapshot).runId === 'string');
}

function summaryCount(run: TestRunSnapshot, key: string): number | undefined {
  if (!run.summary || typeof run.summary !== 'object' || Array.isArray(run.summary)) return undefined;
  const value = (run.summary as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function testExecutionProgress(run: TestRunSnapshot) {
  const starts = run.logs.filter((event) => event.eventType === 'test-start');
  const results = run.logs.filter((event) => event.eventType === 'test-result');
  const resultIds = new Set(results.map((event) => event.nodeId ?? event.caseId).filter(Boolean));
  const latestStart = starts[starts.length - 1];
  const latestStartId = latestStart?.nodeId ?? latestStart?.caseId;
  const countOutcome = (outcome: string) => results.filter((event) => event.outcome === outcome).length;
  const total = summaryCount(run, 'total')
    ?? (run.nodeIds.length > 0 ? run.nodeIds.length : Math.max(starts.length, results.length));

  return {
    total,
    completed: results.length,
    passed: summaryCount(run, 'passed') ?? countOutcome('passed'),
    failed: summaryCount(run, 'failed') ?? countOutcome('failed'),
    blocked: summaryCount(run, 'blocked') ?? countOutcome('blocked'),
    skipped: summaryCount(run, 'skipped') ?? countOutcome('skipped'),
    errored: summaryCount(run, 'errored') ?? countOutcome('error'),
    current: latestStartId && !resultIds.has(latestStartId) ? latestStartId : undefined,
  };
}

export const ScriptCanvasUi: React.FC<ScriptCanvasUiProps> = ({
  ui,
  values,
  sources = {},
  snapshot,
  onValuesChange,
  onAction,
}) => {
  const variables = snapshot.variables ?? {};
  const containerRef = useRef<HTMLDivElement>(null);
  const [primarySize, setPrimarySize] = useState(ui.layout.primarySize ?? 42);
  const horizontal = ui.layout.preset === 'left-right';
  const regionIds = ui.layout.regions;

  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (ui.layout.resizable === false) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const raw = horizontal
      ? ((event.clientX - rect.left) / rect.width) * 100
      : ((event.clientY - rect.top) / rect.height) * 100;
    const primaryMin = ((ui.layout.minPrimaryPx ?? 180) / (horizontal ? rect.width : rect.height)) * 100;
    const secondaryMin = ((ui.layout.minSecondaryPx ?? 180) / (horizontal ? rect.width : rect.height)) * 100;
    setPrimarySize(Math.min(100 - secondaryMin, Math.max(primaryMin, raw)));
  };

  const renderRegion = (regionId: string) => {
    const region = ui.regions[regionId];
    const controlsInRow = region.controlsLayout === 'row';
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface" key={regionId}>
        {(region.title || region.description) && (
          <header className="shrink-0 border-b border-border bg-surface-secondary/50 px-3 py-2">
            {region.title && <div className="text-xs font-semibold text-text-primary">{region.title}</div>}
            {region.description && <div className="mt-0.5 text-[10px] text-text-muted">{region.description}</div>}
          </header>
        )}
        <div className={`flex min-h-0 flex-1 gap-3 overflow-auto ${controlsInRow ? 'flex-row items-center px-3 py-2' : 'flex-col p-3'}`}>
          {region.controls.map((control) => (
            <div
              className={controlsInRow ? (control.type === 'checkbox' || control.compact ? 'shrink-0' : 'min-w-72 flex-1') : undefined}
              key={control.id}
            >
              <ScriptControl
                control={control}
                values={values}
                sources={sources}
                variables={variables}
                snapshot={snapshot}
                onValuesChange={onValuesChange}
                onAction={onAction}
              />
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div ref={containerRef} className={`flex h-full min-h-0 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      <div className="flex min-h-0 min-w-0" style={{ [horizontal ? 'width' : 'height']: `${primarySize}%` }}>
        {renderRegion(regionIds[0])}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        className={`group relative shrink-0 bg-transparent ${horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
      >
        <div
          className={`pointer-events-none absolute bg-[var(--divider-default)] transition-colors group-hover:bg-accent-blue ${horizontal
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
          }`}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">{renderRegion(regionIds[1])}</div>
    </div>
  );
};

interface ScriptControlProps {
  control: ScriptUiControl;
  values: Record<string, unknown>;
  sources: Record<string, unknown>;
  variables: Record<string, unknown>;
  snapshot: ScriptRuntimeSnapshot;
  onValuesChange: (values: Record<string, unknown>) => void;
  onAction: (action: string, options?: { preserveLogs?: boolean }) => void;
}

const ScriptControl: React.FC<ScriptControlProps> = ({
  control,
  values,
  sources,
  variables,
  snapshot,
  onValuesChange,
  onAction,
}) => {
  const [expanded, setExpanded] = useState(control.type !== 'historyList' || control.collapsed !== true);
  const boundValue = control.bind ? readUiPath(values, control.bind) : undefined;
  const setBoundValue = (value: unknown) => {
    if (control.bind) onValuesChange(setUiPath(values, control.bind, value));
  };
  const source = (path?: string) => resolveUiSource(path, values, variables, snapshot, sources);
  const wrapper = (content: React.ReactNode, showLabel = true) => (
    <div
      data-script-control={control.id}
      className={`space-y-1 ${control.grow ? 'flex min-h-0 flex-1 flex-col' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {showLabel && control.label && <div className="text-[11px] font-medium text-text-secondary">{control.label}</div>}
      {content}
      {control.description && <div className="text-[10px] leading-relaxed text-text-muted">{control.description}</div>}
    </div>
  );

  if (['text', 'search', 'password', 'number', 'file', 'directory'].includes(control.type)) {
    const isPicker = control.type === 'file' || control.type === 'directory';
    const input = (
      <input
        className="input-base min-w-0 flex-1 text-xs"
        type={control.type === 'password' ? 'password' : control.type === 'number' ? 'number' : 'text'}
        value={stringValue(boundValue)}
        placeholder={'placeholder' in control ? control.placeholder : undefined}
        min={'min' in control ? control.min : undefined}
        max={'max' in control ? control.max : undefined}
        onChange={(event) => setBoundValue(control.type === 'number' ? Number(event.target.value) : event.target.value)}
      />
    );
    const content = !isPicker ? input : (
      <div className="flex gap-2">
        {input}
        <button
          className="rounded border border-border px-3 text-[11px] text-text-secondary hover:bg-[var(--layer-hover)]"
          onClick={() => {
            void openFileDialog({
              directory: control.type === 'directory',
              multiple: false,
              defaultPath: stringValue(boundValue) || undefined,
              ...('extensions' in control && control.extensions?.length
                ? { filters: [{ name: control.label ?? control.id, extensions: control.extensions }] }
                : {}),
            })
              .then((selected) => { if (typeof selected === 'string') setBoundValue(selected); });
          }}
        >Browse</button>
      </div>
    );
    if (control.inlineLabel) {
      return wrapper(
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-medium text-text-secondary">{control.label}</span>
          <span className="min-w-0 flex-1">{content}</span>
        </label>,
        false,
      );
    }
    return wrapper(content);
  }

  if (control.type === 'checkbox') {
    return wrapper(
      <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={Boolean(boundValue)} onChange={(event) => setBoundValue(event.target.checked)} />
        <span>{control.label ?? control.id}</span>
      </label>,
      false,
    );
  }

  if (control.type === 'select' || control.type === 'multiSelect') {
    const options = includeRememberedChannelOption(
      resolveOptions(control.options, source),
      control.options,
      boundValue,
      sources,
    );
    const selected = control.type === 'multiSelect'
      ? new Set(Array.isArray(boundValue) ? boundValue.map(String) : [])
      : null;
    const content = control.type === 'select' && control.editable ? (
      <ScriptEditableSelect
        value={stringValue(boundValue)}
        options={options}
        placeholder={control.placeholder}
        allowEmpty={control.allowEmpty}
        onChange={(value) => setBoundValue(value)}
      />
    ) : (
      <select
        className="input-base w-full text-xs"
        multiple={control.type === 'multiSelect'}
        value={control.type === 'multiSelect' ? [...(selected ?? [])] : stringValue(boundValue)}
        onChange={(event) => setBoundValue(control.type === 'multiSelect'
          ? Array.from(event.currentTarget.selectedOptions, (option) => option.value)
          : event.target.value)}
      >
        {control.type === 'select' && control.allowEmpty !== false && <option value="">Select…</option>}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
    );
    if (control.inlineLabel) {
      return wrapper(
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] font-medium text-text-secondary">{control.label}</span>
          <span className="min-w-0 flex-1">{content}</span>
        </label>,
        false,
      );
    }
    return wrapper(content);
  }

  if (control.type === 'button') {
    const color = control.variant === 'danger'
      ? 'bg-accent-red hover:bg-accent-red/80'
      : control.variant === 'primary' ? 'bg-accent-green hover:bg-accent-green/80' : 'bg-accent-mauve hover:bg-accent-mauve/85';
    const disabled = snapshot.status === 'running' && control.action !== '$stop';
    return wrapper(
      <button
        className={`w-full rounded px-3 py-2 text-xs font-semibold text-surface disabled:cursor-not-allowed disabled:opacity-40 ${color}`}
        disabled={disabled || (control.action === '$stop' && snapshot.status !== 'running')}
        onClick={() => onAction(control.action)}
      >{control.label ?? control.id}</button>,
      false,
    );
  }

  if (control.type === 'testCases') {
    const catalog = source(control.catalogSource);
    const profile = control.profileBind
      ? stringValue(readUiPath(values, control.profileBind))
      : '';
    const tests = isCatalog(catalog)
      ? testsForTestRunnerProfile(catalog, profile)
      : [];
    const visibleNodeIds = new Set(tests.map((test) => test.nodeId));
    const selected = new Set(
      (Array.isArray(boundValue) ? boundValue.map(String) : [])
        .filter((nodeId) => visibleNodeIds.has(nodeId)),
    );
    const update = (next: Set<string>) => setBoundValue([...next]);
    return wrapper(
      <div className="overflow-hidden rounded border border-border">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[10px] text-text-muted">
          <span className="font-medium text-text-secondary">{control.label ?? 'Test cases'}</span>
          <span className="flex-1">{selected.size} selected / {tests.length} visible</span>
          <button onClick={() => update(new Set(tests.map((test) => test.nodeId)))} className="hover:text-text-primary">All</button>
          <button onClick={() => update(new Set())} className="hover:text-text-primary">Clear</button>
          <button onClick={() => update(new Set(tests.filter((test) => !selected.has(test.nodeId)).map((test) => test.nodeId)))} className="hover:text-text-primary">Invert</button>
        </div>
        <div className="max-h-56 overflow-auto divide-y divide-border/70">
          {tests.length === 0 && <div className="p-3 text-[11px] text-text-muted">Load a catalog or adjust the filter.</div>}
          {tests.map((test) => (
            <label key={test.nodeId} className="flex cursor-pointer gap-2 px-2 py-1.5 hover:bg-[var(--layer-hover)]">
              <input
                type="checkbox"
                checked={selected.has(test.nodeId)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(test.nodeId)) next.delete(test.nodeId); else next.add(test.nodeId);
                  update(next);
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-text-secondary">{test.title}</span>
                <span className="block truncate font-mono text-[9px] text-text-muted">{test.nodeId}</span>
              </span>
              <span className="text-[9px] uppercase text-text-muted">{test.danger ?? 'safe'}</span>
            </label>
          ))}
        </div>
      </div>,
      false,
    );
  }

  if (control.type === 'testInputs') {
    const catalog = source(control.catalogSource);
    if (!isCatalog(catalog)) return wrapper(<div className="text-[11px] text-text-muted">Load a catalog to discover required inputs.</div>);
    const profile = stringValue(readUiPath(values, control.profileBind));
    const nodeIds = new Set(Array.isArray(readUiPath(values, control.nodeIdsBind))
      ? (readUiPath(values, control.nodeIdsBind) as unknown[]).map(String)
      : []);
    const summary = summarizeTestRunnerSelection(catalog, profile, nodeIds);
    const inputs = boundValue && typeof boundValue === 'object' && !Array.isArray(boundValue)
      ? boundValue as Record<string, unknown>
      : {};
    return wrapper(
      <div className="space-y-2 rounded border border-border p-2">
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-text-muted">Required inputs</span>
          <span className={`font-semibold uppercase ${summary.danger === 'write' || summary.danger === 'destructive' ? 'text-red-400' : 'text-text-secondary'}`}>{summary.danger}</span>
        </div>
        {summary.requiredInputs.length === 0
          ? <div className="text-[11px] text-text-muted">No additional input required.</div>
          : summary.requiredInputs.map((name) => {
            const definition = catalog.inputDefinitions?.[name];
            const inputType = definition?.type ?? 'text';
            const label = definition?.label ?? name;
            const picker = inputType === 'file' || inputType === 'directory';
            const field = (
              <input
                aria-label={label}
                className="input-base min-w-0 flex-1 text-xs"
                type={inputType === 'password' ? 'password' : 'text'}
                value={stringValue(inputs[name])}
                placeholder={definition?.placeholder}
                onChange={(event) => setBoundValue({ ...inputs, [name]: event.target.value })}
              />
            );
            return (
              <div key={name} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[10px] text-text-muted">
                  <span className="font-medium text-text-secondary">{label}</span>
                  {label !== name && <span className="truncate font-mono">{name}</span>}
                </div>
                {picker ? (
                  <div className="flex gap-2">
                    {field}
                    <button
                      type="button"
                      aria-label={`Browse ${label}`}
                      className="rounded border border-border px-3 text-[11px] text-text-secondary hover:bg-[var(--layer-hover)]"
                      onClick={() => {
                        const extensions = inputType === 'file' ? definition?.extensions ?? [] : [];
                        void openFileDialog({
                          directory: inputType === 'directory',
                          multiple: false,
                          defaultPath: stringValue(inputs[name]) || undefined,
                          ...(extensions.length > 0
                            ? { filters: [{ name: label, extensions }] }
                            : {}),
                        }).then((selected) => {
                          if (typeof selected === 'string') {
                            setBoundValue({ ...inputs, [name]: selected });
                          }
                        });
                      }}
                    >Browse</button>
                  </div>
                ) : field}
                {definition?.description && (
                  <div className="text-[10px] leading-relaxed text-text-muted">{definition.description}</div>
                )}
              </div>
            );
          })}
      </div>,
    );
  }

  if (control.type === 'runSummary') {
    const run = source(control.source);
    if (!isTestRun(run)) {
      return wrapper(
        <div className="rounded border border-border bg-surface-secondary p-2 text-[10px] text-text-muted">
          <div className="mb-1 font-semibold text-text-secondary">Test execution</div>
          <div>No test run yet.</div>
        </div>,
        false,
      );
    }
    const progress = testExecutionProgress(run);
    return wrapper(
      <div className="rounded border border-border bg-surface-secondary p-2 text-[10px]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-semibold text-text-secondary">Test execution</span>
          <span className={`font-semibold uppercase ${statusClass(run.status)}`}>{run.status}</span>
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-text-muted">
          <span>Progress <strong className="text-text-primary">{progress.completed} / {progress.total || '—'}</strong></span>
          <span>Passed <strong className="text-accent-green">{progress.passed}</strong></span>
          <span>Failed <strong className="text-red-400">{progress.failed}</strong></span>
          <span>Blocked <strong className="text-red-400">{progress.blocked}</strong></span>
          <span>Skipped <strong className="text-text-secondary">{progress.skipped}</strong></span>
          <span>Errors <strong className="text-red-400">{progress.errored}</strong></span>
        </div>
        {progress.current && (
          <div className="mt-2 truncate border-t border-border pt-1 font-mono text-text-secondary" title={progress.current}>
            Running {progress.current}
          </div>
        )}
      </div>,
      false,
    );
  }

  if (control.type === 'testResults') {
    const run = source(control.source);
    const results = isTestRun(run) ? run.logs.filter((event) => event.eventType === 'test-result') : [];
    return wrapper(
      <div className="max-h-52 overflow-auto rounded border border-border divide-y divide-border/70">
        {results.length === 0 && <div className="p-3 text-[11px] text-text-muted">Structured pytest results appear here.</div>}
        {results.map((event) => (
          <div key={`${event.runId}-${event.seq}`} className="flex gap-2 px-2 py-1.5 text-[10px]">
            <span className={`w-14 shrink-0 font-semibold uppercase ${statusClass(event.outcome)}`}>{event.outcome ?? 'result'}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">{event.nodeId ?? event.caseId}</span>
          </div>
        ))}
      </div>,
    );
  }

  if (control.type === 'stepList') {
    const showTimestamp = control.showTimestamp !== false && control.timestampFormat !== 'none';
    const timestampFormat = control.timestampFormat ?? 'time';
    return wrapper(
      <div className="rounded border border-border divide-y divide-border/70">
        {snapshot.steps.length === 0 && <div className="p-3 text-[11px] text-text-muted">No active steps.</div>}
        {snapshot.steps.map((step) => {
          const timestampText = showTimestamp ? formatStepTimestamp(step.startedAt, timestampFormat) : null;
          return (
            <div key={step.id} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 text-[10px]">
              <span className="truncate font-mono text-text-secondary">
                {timestampText && <span className="mr-1.5 text-text-muted">[{timestampText}]</span>}
                {step.name ?? step.id}
              </span>
              <span className={`uppercase ${statusClass(step.status)}`}>{step.status}</span>
            </div>
          );
        })}
      </div>,
    );
  }

  if (control.type === 'logViewer') {
    const entries = control.errorOnly
      ? snapshot.logs.filter((entry) => entry.level === 'error' || entry.level === 'fail')
      : snapshot.logs;
    if (control.hideWhenEmpty && entries.length === 0) return null;
    return wrapper(
      <div className={`${control.grow ? 'min-h-32 flex-1' : 'max-h-72'} overflow-auto rounded border border-border bg-surface-secondary p-2 font-mono text-[10px] leading-5`}>
        {entries.length === 0 && <div className="text-text-muted">Runtime and pytest logs appear here.</div>}
        {entries.map((entry) => (
          <div key={entry.id} className={statusClass(entry.level === 'error' || entry.level === 'fail' ? 'failed' : entry.level === 'pass' ? 'passed' : '')}>
            [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.message}
          </div>
        ))}
      </div>,
    );
  }

  if (control.type === 'historyList') {
    const history = source(control.source);
    const runs = Array.isArray(history) ? history.filter(isTestRun) : [];
    return wrapper(
      <div>
        <button
          type="button"
          aria-label={expanded ? 'Hide run history' : 'Show run history'}
          title={expanded ? 'Hide run history' : 'Show and refresh run history'}
          className="flex h-7 w-full items-center justify-between rounded px-2 text-[11px] font-medium text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary disabled:opacity-40"
          disabled={snapshot.status === 'running'}
          onClick={() => {
            const nextExpanded = !expanded;
            setExpanded(nextExpanded);
            if (nextExpanded && control.refreshAction) {
              onAction(control.refreshAction, { preserveLogs: true });
            }
          }}
        >
          <span>History</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {expanded && (
          <div className="max-h-44 overflow-auto rounded border border-border divide-y divide-border/70">
            {runs.length === 0 && <div className="p-3 text-[11px] text-text-muted">No runs for this project.</div>}
            {runs.map((run) => (
              <div key={run.runId} className="grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 text-[10px]">
                <span className="truncate font-mono text-text-secondary">{run.runId}</span>
                <span className={`uppercase ${statusClass(run.status)}`}>{run.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>,
      false,
    );
  }

  return null;
};

function resolveOptions(
  options: ScriptUiStaticOption[] | ScriptUiOptionSource | undefined,
  resolve: (path?: string) => unknown,
): ScriptUiStaticOption[] {
  if (!options) return [];
  if (Array.isArray(options)) return options;
  const items = resolve(options.source);
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    value: stringValue(readUiPath(item, options.valuePath) ?? item),
    label: stringValue(readUiPath(item, options.labelPath) ?? readUiPath(item, options.valuePath) ?? item),
  }));
}

function includeRememberedChannelOption(
  options: ScriptUiStaticOption[],
  sourceConfig: ScriptUiStaticOption[] | ScriptUiOptionSource | undefined,
  boundValue: unknown,
  sources: Record<string, unknown>,
): ScriptUiStaticOption[] {
  if (Array.isArray(sourceConfig) || !sourceConfig?.source.startsWith('app.openChannels.')) return options;
  const selectedId = stringValue(boundValue);
  if (!selectedId || options.some((option) => option.value === selectedId)) return options;
  const channels = readUiPath(sources, 'app.allChannels');
  if (!Array.isArray(channels)) return options;
  const selected = channels.find((channel) => readUiPath(channel, 'id') === selectedId);
  if (!selected) return options;
  return [{
    value: selectedId,
    label: `${stringValue(readUiPath(selected, 'name')) || selectedId} (remembered, closed)`,
    disabled: true,
  }, ...options];
}

interface ScriptEditableSelectProps {
  value: string;
  options: ScriptUiStaticOption[];
  placeholder?: string;
  /** Set false to hide the leading empty "Select…" choice. */
  allowEmpty?: boolean;
  disabled?: boolean;
  /** Extra classes for the combobox wrapper, sized by the hosting toolbar or region. */
  className?: string;
  onChange: (value: string) => void;
}

/**
 * Single-select combobox: picks a listed option (bound to the option value, e.g. a channel id)
 * or accepts free-typed text such as a serial COM port or a BLE device name.
 */
export const ScriptEditableSelect: React.FC<ScriptEditableSelectProps> = ({
  value,
  options,
  placeholder,
  allowEmpty,
  disabled,
  className,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  const shown = draft ?? selectedOption?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const select = (option: ScriptUiStaticOption) => {
    if (option.disabled) return;
    setOpen(false);
    setDraft(null);
    onChange(option.value);
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <div className="relative">
        <input
          className="input-base w-full py-1 pr-7 text-xs"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange(event.target.value);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setDraft(null)}
        />
        <button
          type="button"
          aria-label="Toggle options"
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <svg
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="absolute top-full right-0 left-0 z-30 mt-1 max-h-48 overflow-auto rounded-xl border border-border bg-surface-secondary/95 p-1 shadow-xl shadow-black/30 backdrop-blur-sm">
          {allowEmpty !== false && (
            <button
              type="button"
              className="w-full rounded-lg px-2.5 py-1 text-left text-xs text-text-muted hover:bg-[var(--layer-hover)]"
              onClick={() => select({ value: '', label: 'Select…' })}
            >Select…</button>
          )}
          {options.map((option) => (
            <button
              type="button"
              key={option.value}
              disabled={option.disabled}
              className="w-full rounded-lg px-2.5 py-1 text-left text-xs text-text-secondary hover:bg-[var(--layer-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => select(option)}
            >{option.label}</button>
          ))}
        </div>
      )}
    </div>
  );
};
