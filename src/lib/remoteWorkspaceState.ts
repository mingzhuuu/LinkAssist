import { remoteValueKey } from './remoteValidation';
import { DEFAULT_SERIAL_CONFIG, DEFAULT_TCP_CONFIG, normalizeSerialConfig, useBleStore, useCanvasStore, useChannelStore, useCommandStore, useSerialStore, useTcpStore } from '../stores';
import type { Canvas } from '../types';
import { applyRemoteLayout, captureRemoteLayout, remoteLayoutRevision, validateRemoteLayout, type RemoteLayout } from './remoteLayout';

/** Editable workspace data, deliberately separate from connection/runtime state. */
export function captureWorkspaceContent() {
  const serial = useSerialStore.getState(), tcp = useTcpStore.getState(), ble = useBleStore.getState();
  return {
    channels: useChannelStore.getState().channels.map(({ id, name, type }) => ({ id, name, type,
      serial: serial.channelConfigs[id] ?? DEFAULT_SERIAL_CONFIG,
      tcp: tcp.channelConfigs[id] ?? DEFAULT_TCP_CONFIG,
    })),
    canvases: useCanvasStore.getState().canvases.map(({ id, name, groupId, config, activationMode }) => ({ id, name, groupId: groupId ?? null, config, activationMode })),
    commands: useCommandStore.getState().getSnapshot(),
    bleFilters: ble.bleFilters,
    customUuidNames: ble.customUuidNames,
  };
}
export type WorkspaceContent = ReturnType<typeof captureWorkspaceContent>;
const equal = (a: unknown, b: unknown) => remoteValueKey(a) === remoteValueKey(b);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const numericExtractor = (v: unknown) => record(v) && typeof v.formula === 'string'
  && (v.source === 'parsed' ? typeof v.fieldId === 'string' : v.source === 'raw' && typeof v.offset === 'number' && typeof v.format === 'string');
const tableColumn = (v: unknown) => record(v) && typeof v.id === 'string' && typeof v.alias === 'string'
  && typeof v.offset === 'number' && typeof v.format === 'string' && typeof v.formula === 'string';

function validateContent(value: unknown, layout: RemoteLayout): asserts value is WorkspaceContent {
  if (!record(value) || !Array.isArray(value.channels) || !Array.isArray(value.canvases) || !record(value.commands)
    || !record(value.commands.commandSets) || !record(value.commands.expandedGroups) || !record(value.bleFilters) || !record(value.customUuidNames)) throw new Error('Invalid workspace content');
  const ids = new Set<string>();
  for (const c of value.channels) {
    if (!record(c) || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100
      || !['ble', 'serial', 'tcp'].includes(String(c.type)) || !record(c.serial) || !record(c.tcp)
      || !['client', 'server', 'udp'].includes(String(c.tcp.mode))
      || ['clientAddress', 'serverAddress', 'udpBindAddress', 'udpTargetAddress'].some(k => typeof (c.tcp as Record<string, unknown>)[k] !== 'string')) throw new Error('Invalid channel configuration');
    ids.add(c.id);
  }
  if (ids.size !== layout.channelOrder.length || layout.channelOrder.some(id => !ids.has(id))) throw new Error('Invalid channel layout');
  // Local channel removal retains terminal history and canvas bindings. Preserve
  // those existing references, but reject newly injected unknown channel IDs.
  const knownIds = new Set([...ids, ...useChannelStore.getState().channels.map(c => c.id),
    ...useCanvasStore.getState().canvases.flatMap(c => c.config.channels.map(link => link.channelId)),
    ...Object.values(captureRemoteLayout().terminal.panes).flatMap(pane => pane.tabs.flatMap(tab => [tab.channelId, ...(Array.isArray(tab.receiveChannels) ? tab.receiveChannels : [])]))]);
  for (const pane of Object.values(layout.terminal.panes)) for (const tab of pane.tabs) {
    if ((tab.channelId && !knownIds.has(tab.channelId)) || (Array.isArray(tab.receiveChannels) && tab.receiveChannels.some(id => !knownIds.has(id)))) throw new Error('Unknown terminal channel');
  }
  const canvasIds = new Set<string>();
  for (const c of value.canvases) {
    if (!record(c) || typeof c.id !== 'string' || canvasIds.has(c.id) || typeof c.name !== 'string'
      || (c.groupId !== null && typeof c.groupId !== 'string') || !['auto', 'manual-off'].includes(String(c.activationMode))
      || !record(c.config) || !['table', 'chart', 'form', 'script'].includes(String(c.config.type))
      || !['raw', 'parsed'].includes(String(c.config.dataSource)) || !Array.isArray(c.config.channels)
      || c.config.channels.some(link => !record(link) || typeof link.channelId !== 'string' || !knownIds.has(link.channelId))) throw new Error('Invalid canvas configuration');
    // Validate renderer collections before they enter the mounted host UI.
    for (const [kind, collection] of [['table', 'columns'], ['chart', 'series'], ['form', 'rows']]) {
      const config = c.config[kind];
      if (config !== undefined && (!record(config) || !Array.isArray(config[collection]) || config[collection].some((item: unknown) => !record(item) || typeof item.id !== 'string'))) throw new Error('Invalid canvas fields');
    }
    const { table, form, chart, script, lifecycleScript } = c.config;
    if (record(table) && (table.columns as unknown[]).some(column => !tableColumn(column))) throw new Error('Invalid table column');
    if (record(form) && (!['send', 'display'].includes(String(form.mode)) || (form.rows as unknown[]).some(row => !record(row) || typeof row.label !== 'string' || !tableColumn(row.column)))) throw new Error('Invalid form row');
    if (record(chart)) {
      if (!['line', 'bar', 'scatter'].includes(String(chart.kind)) || !record(chart.yAxis) || !['auto', 'manual'].includes(String(chart.yAxis.mode))) throw new Error('Invalid chart axes');
      if (chart.kind === 'line' && (!record(chart.xSource) || (chart.xSource.kind !== 'timestamp' && !(chart.xSource.kind === 'extractor' && numericExtractor(chart.xSource.extractor))))) throw new Error('Invalid chart X source');
      if ((chart.series as unknown[]).some(series => !record(series) || typeof series.name !== 'string' || typeof series.color !== 'string' || (chart.kind === 'scatter' ? !numericExtractor(series.xExtractor) || !numericExtractor(series.yExtractor) : !numericExtractor(series.extractor)))) throw new Error('Invalid chart series');
    }
    for (const item of [script, lifecycleScript]) if (item !== undefined && (!record(item) || item.sourceType !== 'file' || (item.luaPath !== undefined && typeof item.luaPath !== 'string'))) throw new Error('Invalid script configuration');
    canvasIds.add(c.id);
  }
  if (canvasIds.size !== layout.canvases.length || layout.canvases.some(c => !canvasIds.has(c.id))) throw new Error('Invalid canvas layout');
  for (const filters of Object.values(value.bleFilters)) {
    if (!record(filters) || typeof filters.nameFilter !== 'string' || typeof filters.rssiFilter !== 'number'
      || ['hasServicesFilter', 'hasNameFilter', 'connectableFilter'].some(k => typeof filters[k] !== 'boolean')) throw new Error('Invalid BLE filters');
  }
  for (const kind of ['services', 'characteristics']) {
    const names = value.customUuidNames[kind];
    if (!record(names) || Object.values(names).some(name => typeof name !== 'string')) throw new Error('Invalid BLE names');
  }
  if (value.commands.savedConfigs !== undefined && (!record(value.commands.savedConfigs) || Object.values(value.commands.savedConfigs).some(configs => !Array.isArray(configs) || configs.some(config => !record(config) || !record(config.data) || !Array.isArray(config.data.groups) || !Array.isArray(config.data.commands))))) throw new Error('Invalid saved commands');
}

/** Called only after validation, or while hydrating an authenticated host snapshot. */
export function applyWorkspaceContent(content: WorkspaceContent, layout: RemoteLayout) {
  const channels = useChannelStore.getState();
  channels.restoreChannels(content.channels.map(({ id, name, type }) => ({ id, name, type })));
  useSerialStore.setState({ channelConfigs: Object.fromEntries(content.channels.map(c => [c.id, normalizeSerialConfig(c.serial)])) });
  useTcpStore.setState({ channelConfigs: Object.fromEntries(content.channels.map(c => [c.id, c.tcp])) });
  useBleStore.setState({ bleFilters: content.bleFilters, customUuidNames: content.customUuidNames });
  if (!equal(content.commands, useCommandStore.getState().getSnapshot())) useCommandStore.getState().restoreSnapshot(content.commands);
  const store = useCanvasStore.getState();
  for (const canvas of store.canvases) if (!content.canvases.some(c => c.id === canvas.id)) store.removeCanvas(canvas.id);
  const current = useCanvasStore.getState();
  const canvases: Canvas[] = content.canvases.map(c => {
    const old = current.canvases.find(item => item.id === c.id);
    const geometry = layout.canvases.find(item => item.id === c.id)!;
    return { ...geometry, id: c.id, name: c.name, groupId: c.groupId, activationMode: c.activationMode, config: old && equal(old.config, c.config) ? old.config : c.config,
      active: c.activationMode === 'manual-off' ? false : old?.activationMode === 'auto' ? old.active : true };
  });
  useCanvasStore.setState({ canvases, nextZIndex: Math.max(0, ...canvases.map(c => c.zIndex)) + 1 });
}

/** Atomic validation before any store mutation; stale edits are never silently replayed. */
export function updateHostWorkspace(args: Record<string, unknown>) {
  if (args.revision !== remoteLayoutRevision() || !equal(args.baseContent, captureWorkspaceContent())) throw new Error('Workspace changed on host. Refreshed; retry your change.');
  validateRemoteLayout(args.layout);
  validateContent(args.content, args.layout);
  const content = args.content;
  for (const old of useChannelStore.getState().channels) {
    const next = content.channels.find(c => c.id === old.id);
    if (next && next.type !== old.type) throw new Error('Cannot change a channel type');
    if (old.state !== 'connected' && old.state !== 'connecting') continue;
    const previous = captureWorkspaceContent().channels.find(c => c.id === old.id)!;
    if (!next || (old.type === 'serial' && !equal(previous.serial, next.serial)) || (old.type === 'tcp' && !equal(previous.tcp, next.tcp))) throw new Error('Disconnect the channel before changing its configuration');
  }
  applyWorkspaceContent(content, args.layout);
  applyRemoteLayout(args.layout);
  const layout = captureRemoteLayout();
  return { layout, revision: remoteLayoutRevision(layout), content: captureWorkspaceContent() };
}

