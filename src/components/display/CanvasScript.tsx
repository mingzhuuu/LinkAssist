import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { toast, useCanvasStore, useChannelStore } from '../../stores';
import { ScriptCanvasUi, ScriptEditableSelect } from './ScriptCanvasUi';
import { getScriptRuntime } from './scriptRuntime';
import { parseScriptLuaFile } from './scriptLua';
import type {
  ScriptDocument,
  ScriptRuntimeSnapshot,
  ScriptUiButtonControl,
  ScriptUiStaticOption,
  ScriptUiToolbarControl,
  ScriptUiToolbarSelectControl,
} from './scriptTypes';
import { collectPersistedUiState, mergeUiValues, readUiPath, resolveUiSource, setUiPath } from './scriptUiUtils';

interface CanvasScriptProps {
  canvasId: string;
}

const EMPTY_SNAPSHOT: ScriptRuntimeSnapshot = {
  status: 'idle',
  scriptName: 'Automation Script',
  currentStepIndex: -1,
  steps: [],
  logs: [],
};

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'text-accent-blue';
    case 'passed': return 'text-accent-green';
    case 'failed': return 'text-red-400';
    case 'stopped': return 'text-yellow-400';
    default: return 'text-text-secondary';
  }
}

export async function pickScriptDirectory(
  values: Record<string, unknown>,
  bind: string,
  pickDirectory: typeof openFileDialog = openFileDialog,
): Promise<Record<string, unknown> | null> {
  const selected = await pickDirectory({
    directory: true,
    multiple: false,
    defaultPath: String(readUiPath(values, bind) ?? '') || undefined,
  });
  return typeof selected === 'string' ? setUiPath(values, bind, selected) : null;
}

export const CanvasScript: React.FC<CanvasScriptProps> = ({ canvasId }) => {
  const canvas = useCanvasStore((state) => state.canvases.find((item) => item.id === canvasId));
  const config = canvas?.config.script;
  const channels = useChannelStore((state) => state.channels);
  const runtime = useMemo(() => getScriptRuntime(canvasId), [canvasId]);
  const [snapshot, setSnapshot] = useState<ScriptRuntimeSnapshot>(runtime.getSnapshot() ?? EMPTY_SNAPSHOT);
  const [document, setDocument] = useState<ScriptDocument | null>(null);
  const [uiValues, setUiValues] = useState<Record<string, unknown>>({});
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const restoreRunKeyRef = useRef('');
  const appSources = useMemo(() => {
    const channelOptions = channels.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, state: channel.state }));
    return {
      app: {
        allChannels: channelOptions,
        channels: {
          serial: channelOptions.filter((channel) => channel.type === 'serial'),
          ble: channelOptions.filter((channel) => channel.type === 'ble'),
        },
        openChannels: {
          serial: channelOptions.filter((channel) => channel.type === 'serial' && channel.state === 'connected'),
          ble: channelOptions.filter((channel) => channel.type === 'ble' && channel.state === 'connected'),
        },
      },
    };
  }, [channels]);

  useEffect(() => runtime.subscribe(setSnapshot), [runtime]);

  const mergeConfigIntoDocument = useCallback((next: ScriptDocument): ScriptDocument => {
    if (!config) return next;
    const csvLogs = Object.fromEntries(
      Object.entries(next.csvLog ?? {}).map(([target, csvLog]) => [
        target,
        csvLog.baseDir === 'executable'
          ? csvLog
          : config.csvLogOutputs?.[target]?.enabled === true
          ? { ...csvLog, path: config.csvLogOutputs[target]?.path || `${target}.csv` }
          : { ...csvLog, path: '' },
      ]),
    );
    return {
      ...next,
      defaults: {
        stopOnFailure: config.stopOnFailure ?? true,
        timeoutMs: config.defaultTimeoutMs ?? 2000,
        dataFormat: config.defaultDataFormat ?? 'hex',
        logLimit: config.logLimit ?? 500,
        ...next.defaults,
      },
      csvLog: Object.keys(csvLogs).length > 0 ? csvLogs : undefined,
      report: undefined,
    };
  }, [config?.csvLogOutputs, config?.defaultDataFormat, config?.defaultTimeoutMs, config?.logLimit, config?.stopOnFailure]);

  const loadDocument = useCallback(async (valueOverrides?: Record<string, unknown>): Promise<{
    document: ScriptDocument;
    values: Record<string, unknown>;
  } | null> => {
    const path = config?.luaPath ?? config?.yamlPath;
    if (!path) {
      setDocument(null);
      setLoadError('Lua file path is empty');
      return null;
    }
    setLoading(true);
    setLoadError('');
    try {
      const next = mergeConfigIntoDocument(await parseScriptLuaFile(path));
      const persisted = next.ui?.stateVersion
        && config?.uiState?.stateVersion === next.ui.stateVersion
        ? config.uiState.values
        : undefined;
      const values = mergeUiValues(
        mergeUiValues(next.variables ?? {}, persisted),
        valueOverrides,
      );
      setDocument(next);
      setUiValues(values);
      runtime.initializeInteractive(next, values);
      return { document: next, values };
    } catch (error) {
      const message = String(error);
      setDocument(null);
      setLoadError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [config?.luaPath, config?.yamlPath, mergeConfigIntoDocument, runtime]);

  useEffect(() => { void loadDocument(); }, [loadDocument]);

  useEffect(() => {
    if (!document?.ui?.stateVersion || !config) return;
    const persisted = collectPersistedUiState(document.ui, uiValues, {
      variables: snapshot.variables,
      runtime: snapshot,
      sources: appSources,
      previousValues: config.uiState?.values,
      previousSourceRevisions: config.uiState?.sourceRevisions,
    });
    const nextState = {
      stateVersion: document.ui.stateVersion,
      values: persisted.values,
      ...(Object.keys(persisted.sourceRevisions).length > 0
        ? { sourceRevisions: persisted.sourceRevisions }
        : {}),
    };
    if (JSON.stringify(config.uiState) === JSON.stringify(nextState)) return;
    useCanvasStore.getState().updateCanvasConfig(canvasId, {
      script: { ...config, uiState: nextState },
    });
  }, [appSources, canvasId, config, document?.ui, snapshot, uiValues]);

  useEffect(() => {
    const restore = document?.ui?.restore;
    const stateVersion = document?.ui?.stateVersion;
    if (!restore || !stateVersion || !config?.uiState || snapshot.status !== 'idle') return;
    if (config.uiState.stateVersion !== stateVersion) return;
    if (restore.whenBind && !readUiPath(uiValues, restore.whenBind)) return;

    const path = config.luaPath ?? config.yamlPath ?? '';
    const restoreKey = `${path}\u0000${stateVersion}\u0000${restore.action}`;
    if (restoreRunKeyRef.current === restoreKey) return;
    restoreRunKeyRef.current = restoreKey;
    void runtime.runHandler(document, restore.action, uiValues)
      .catch((error) => toast.error(`Failed to restore script state: ${String(error)}`));
  }, [config?.luaPath, config?.uiState, config?.yamlPath, document, runtime, snapshot.status, uiValues]);

  const handleLegacyRun = useCallback(async () => {
    if (!document) return;
    runtime.reset(document.name);
    await runtime.run(document);
  }, [document, runtime]);

  useEffect(() => {
    if (!config?.autoRun || !document || document.ui || snapshot.status !== 'idle') return;
    void handleLegacyRun();
  }, [config?.autoRun, document, handleLegacyRun, snapshot.status]);

  const handleAction = async (
    action: string,
    options: { preserveLogs?: boolean; reloadDocument?: boolean; directoryBind?: string } = {},
  ) => {
    if (action === '$stop') {
      runtime.stop();
      return;
    }
    if (action === '$reset') {
      runtime.initializeInteractive(document!, uiValues);
      return;
    }
    let nextDocument = document;
    let nextValues = uiValues;
    if (options.directoryBind) {
      const selectedValues = await pickScriptDirectory(uiValues, options.directoryBind);
      if (!selectedValues) return;
      nextValues = selectedValues;
      setUiValues(nextValues);
    }
    if (options.reloadDocument) {
      const loaded = await loadDocument(nextValues);
      if (!loaded) return;
      nextDocument = loaded.document;
      nextValues = loaded.values;
    }
    if (!nextDocument) return;
    await runtime.runHandler(nextDocument, action, nextValues, {
      preserveLogs: options.preserveLogs,
    }).catch((error) => toast.error(String(error)));
  };

  if (!canvas || !config) {
    return <div className="flex h-full items-center justify-center text-xs text-text-muted">Script canvas not configured</div>;
  }

  const displayName = canvas.name.trim() || document?.name || snapshot.scriptName || 'Automation Script';
  const isRunning = snapshot.status === 'running';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-xs text-text-secondary">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-3 py-2">
        {document?.ui?.showHeaderInfo !== false && (
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary" title={displayName}>{displayName}</span>
            {snapshot.activeHandler && <span className="truncate font-mono text-[10px] text-text-muted">{snapshot.activeHandler}</span>}
            {snapshot.status !== 'idle' && (
              <span className={`shrink-0 font-semibold uppercase ${statusColor(snapshot.status)}`}>{snapshot.status}</span>
            )}
          </>
        )}
        {document?.ui?.toolbar ? document.ui.toolbar.map((control) => (
          <ScriptToolbarControlView
            key={control.id}
            control={control}
            values={uiValues}
            sources={appSources}
            snapshot={snapshot}
            loading={loading}
            onValuesChange={setUiValues}
            onAction={(action, options) => { void handleAction(action, options); }}
          />
        )) : (
          <button
            className="rounded border border-border px-2 py-1 text-[10px] text-text-secondary hover:bg-[var(--layer-hover)] disabled:opacity-40"
            disabled={loading || isRunning}
            onClick={() => { void loadDocument(); }}
          >{loading ? 'Loading…' : 'Reload'}</button>
        )}
        {!document?.ui && (
          <button
            className={`btn-channel-action min-w-16 shrink-0 px-3 py-[1px] text-xs leading-4 ${isRunning ? 'bg-accent-red hover:bg-accent-red/80 text-surface' : 'bg-accent-green hover:bg-accent-green/80 text-surface'}`}
            onClick={() => { if (isRunning) runtime.stop(); else void handleLegacyRun(); }}
          >{isRunning ? 'Stop' : 'Run'}</button>
        )}
      </div>

      {loadError ? (
        <div className="m-3 rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{loadError}</div>
      ) : document?.ui ? (
        <div className="min-h-0 flex-1">
          <ScriptCanvasUi
            ui={document.ui}
            values={uiValues}
            sources={appSources}
            snapshot={snapshot}
            onValuesChange={setUiValues}
            onAction={(action, options) => { void handleAction(action, options); }}
          />
        </div>
      ) : (
        <LegacyScriptOutput snapshot={snapshot} />
      )}
    </div>
  );
};

const ScriptToolbarControlView: React.FC<{
  control: ScriptUiToolbarControl;
  values: Record<string, unknown>;
  sources: Record<string, unknown>;
  snapshot: ScriptRuntimeSnapshot;
  loading: boolean;
  onValuesChange: (values: Record<string, unknown>) => void;
  onAction: (action: string, options?: { reloadDocument?: boolean; directoryBind?: string }) => void;
}> = ({ control, values, sources, snapshot, loading, onValuesChange, onAction }) => {
  if (control.type === 'button') {
    return <ScriptToolbarButton {...{ control, values, snapshot, loading, onAction }} />;
  }

  const alignClass = control.align === 'end' ? 'ml-auto' : '';
  const disabled = loading || snapshot.status === 'running';
  const boundValue = readUiPath(values, control.bind);
  const setBoundValue = (value: unknown) => onValuesChange(setUiPath(values, control.bind, value));
  if (control.type === 'checkbox') {
    return (
      <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary ${alignClass}`} title={control.description}>
        <input
          type="checkbox"
          checked={Boolean(boundValue)}
          disabled={disabled}
          onChange={(event) => setBoundValue(event.target.checked)}
        />
        <span>{control.label ?? control.id}</span>
      </label>
    );
  }

  const options = resolveToolbarOptions(control.options, values, snapshot, sources);
  const selectedId = String(boundValue ?? '');
  const usesOpenChannelOptions = !Array.isArray(control.options)
    && control.options?.source.startsWith('app.openChannels.');
  const rememberedChannel = usesOpenChannelOptions && !options.some((option) => option.value === selectedId)
    ? (readUiPath(sources, 'app.allChannels') as Array<Record<string, unknown>> | undefined)
      ?.find((channel) => channel.id === selectedId)
    : undefined;
  const visibleOptions = rememberedChannel
    ? [{ value: selectedId, label: `${String(rememberedChannel.name ?? selectedId)} (remembered, closed)`, disabled: true }, ...options]
    : options;
  if (control.editable) {
    return (
      <label className={`flex min-w-0 shrink items-center gap-1.5 text-[11px] text-text-secondary ${alignClass}`} title={control.description}>
        <span className="shrink-0">{control.label ?? control.id}</span>
        <ScriptEditableSelect
          className="max-w-40 min-w-24"
          value={selectedId}
          options={visibleOptions}
          placeholder={control.placeholder}
          allowEmpty={control.allowEmpty}
          disabled={disabled}
          onChange={(value) => setBoundValue(value)}
        />
      </label>
    );
  }
  return (
    <label className={`flex min-w-0 shrink items-center gap-1.5 text-[11px] text-text-secondary ${alignClass}`} title={control.description}>
      <span className="shrink-0">{control.label ?? control.id}</span>
      <select
        className="input-base max-w-40 min-w-24 py-1 text-[11px]"
        value={selectedId}
        disabled={disabled}
        onChange={(event) => setBoundValue(event.target.value)}
      >
        {control.allowEmpty !== false && <option value="">Select…</option>}
        {visibleOptions.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </label>
  );
};

function resolveToolbarOptions(
  options: ScriptUiToolbarSelectControl['options'],
  values: Record<string, unknown>,
  snapshot: ScriptRuntimeSnapshot,
  sources: Record<string, unknown>,
): ScriptUiStaticOption[] {
  if (!options) return [];
  if (Array.isArray(options)) return options;
  const items = resolveUiSource(options.source, values, snapshot.variables ?? {}, snapshot, sources);
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    value: String(readUiPath(item, options.valuePath) ?? item),
    label: String(readUiPath(item, options.labelPath) ?? readUiPath(item, options.valuePath) ?? item),
  }));
}

export const ScriptToolbarButton: React.FC<{
  control: ScriptUiButtonControl;
  values: Record<string, unknown>;
  snapshot: ScriptRuntimeSnapshot;
  loading: boolean;
  onAction: (action: string, options?: { reloadDocument?: boolean; directoryBind?: string }) => void;
}> = ({ control, values, snapshot, loading, onAction }) => {
  const isRunning = snapshot.status === 'running';
  const isThisHandlerRunning = isRunning
    && (!control.runningHandler || snapshot.activeHandler === control.runningHandler);
  const loaded = control.loadedSource
    ? Boolean(resolveUiSource(control.loadedSource, values, snapshot.variables ?? {}, snapshot))
    : false;
  const label = isThisHandlerRunning && control.runningLabel
    ? control.runningLabel
    : loaded && control.loadedLabel ? control.loadedLabel : control.label ?? control.id;
  const action = isThisHandlerRunning && control.runningAction
    ? control.runningAction
    : control.action;
  const disabled = loading || (isRunning && !isThisHandlerRunning);
  const color = isThisHandlerRunning && control.runningAction === '$stop'
    ? 'bg-accent-red hover:bg-accent-red/80 text-surface'
    : control.variant === 'primary'
      ? 'bg-accent-green hover:bg-accent-green/80 text-surface'
      : 'border border-border text-text-secondary hover:bg-[var(--layer-hover)]';

  return (
    <button
      className={`min-w-16 shrink-0 rounded px-3 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${color}${control.align === 'end' ? ' ml-auto' : ''}`}
      disabled={disabled}
      title={control.directoryPicker && control.bind
        ? String(readUiPath(values, control.bind) ?? '') || 'Select project root'
        : undefined}
      onClick={() => onAction(action, {
        ...(control.reloadDocument && !isThisHandlerRunning ? { reloadDocument: true } : {}),
        ...(control.directoryPicker && !isThisHandlerRunning && control.bind
          ? { directoryBind: control.bind }
          : {}),
      })}
    >{label}</button>
  );
};

const LegacyScriptOutput: React.FC<{ snapshot: ScriptRuntimeSnapshot }> = ({ snapshot }) => (
  <div className="min-h-0 flex-1 overflow-auto">
    {snapshot.steps.length === 0 ? (
      <div className="p-4 text-text-muted">Run the script to show steps.</div>
    ) : snapshot.steps.map((step, index) => (
      <div key={`${step.id}-${index}`} className="grid grid-cols-[24px_1fr_auto] gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[10px] text-text-muted">{index + 1}</span>
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-text-secondary">{step.name ?? step.id}</div>
          <div className="truncate text-[10px] text-text-muted">{step.action}{step.error ? ` — ${step.error}` : ''}</div>
        </div>
        <span className={`text-[10px] font-semibold uppercase ${statusColor(step.status)}`}>{step.status}</span>
      </div>
    ))}
  </div>
);
