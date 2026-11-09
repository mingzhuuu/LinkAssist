import { remoteValueKey } from './remoteValidation';
import { useCanvasStore, useChannelStore, useTerminalStore, useUIStore } from '../stores';
import type { Canvas } from '../types';
import type { TerminalLayoutSnapshot } from '../stores/terminalStore';
import { isTerminalLayoutSnapshot, normalizeTerminalChannelSettings } from './persistenceValidation';

const UI_KEYS = ['leftPanelWidth', 'centerPanelWidth', 'rightPanelWidth', 'centerSplitRatio',
  'centerTopVisible', 'channelConfigPreview', 'centerBottomVisible', 'rightPanelVisible', 'channelPanelVisible',
  'themeMode', 'sendFormat', 'receiveFormat', 'showInputPrefix', 'showTimestamp', 'showReceived',
  'terminalChannelSettings', 'channelQuickOpenSelectedIds'] as const;
type LayoutUI = Pick<ReturnType<typeof useUIStore.getState>, typeof UI_KEYS[number]>;
export type CanvasGeometry = Pick<Canvas, 'id' | 'rect' | 'savedRect' | 'savedSnapped' | 'zIndex' | 'maximized' | 'snapped'>;
export interface RemoteLayout {
  ui: LayoutUI;
  terminal: TerminalLayoutSnapshot;
  canvases: CanvasGeometry[];
  channelOrder: string[];
  activeChannelId: string | null;
}

export function captureRemoteLayout(): RemoteLayout {
  const ui = useUIStore.getState();
  return {
    ui: Object.fromEntries(UI_KEYS.map(key => [key, ui[key]])) as LayoutUI,
    terminal: useTerminalStore.getState().getLayoutSnapshot(),
    canvases: useCanvasStore.getState().canvases.map(({ id, rect, savedRect, savedSnapped, zIndex, maximized, snapped }) => ({ id, rect, savedRect, savedSnapped, zIndex, maximized, snapped })),
    channelOrder: useChannelStore.getState().channels.map(channel => channel.id),
    activeChannelId: useChannelStore.getState().activeChannelId,
  };
}

const revisionEpoch = crypto.randomUUID();
let lastLayout = '';
let revision = 0;
export function remoteLayoutRevision(layout = captureRemoteLayout()): string {
  const encoded = remoteValueKey(layout);
  if (encoded !== lastLayout) { lastLayout = encoded; revision++; }
  return `${revisionEpoch}:${revision}`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const rectValid = (value: unknown) => record(value) && finite(value.x, -1e7, 1e7) && finite(value.y, -1e7, 1e7) && finite(value.width, 1, 1e7) && finite(value.height, 1, 1e7);

export function validateRemoteLayout(value: unknown): asserts value is RemoteLayout {
  if (!record(value) || !record(value.ui) || !isTerminalLayoutSnapshot(value.terminal) || !Array.isArray(value.canvases) || !Array.isArray(value.channelOrder)) throw new Error('Invalid workspace layout');
  const ui = value.ui;
  for (const key of UI_KEYS) if (!(key in ui)) throw new Error(`Missing layout setting: ${key}`);
  if (!finite(ui.leftPanelWidth, 40, 150) || !finite(ui.centerPanelWidth, 300, 100000) || !finite(ui.rightPanelWidth, 0, 100000) || !finite(ui.centerSplitRatio, 0.05, 0.95)) throw new Error('Invalid panel dimensions');
  for (const key of ['centerTopVisible', 'centerBottomVisible', 'rightPanelVisible', 'channelPanelVisible', 'showInputPrefix', 'showTimestamp', 'showReceived']) if (typeof ui[key] !== 'boolean') throw new Error('Invalid panel state');
  if (!['light', 'dark', 'system', 'high-contrast', 'high-contrast-light'].includes(String(ui.themeMode)) || !['ascii', 'hex'].includes(String(ui.sendFormat)) || !['ascii', 'hex'].includes(String(ui.receiveFormat)) || !normalizeTerminalChannelSettings(ui.terminalChannelSettings)) throw new Error('Invalid terminal settings');
  if (!Array.isArray(ui.channelQuickOpenSelectedIds) || !ui.channelQuickOpenSelectedIds.every(id => typeof id === 'string')) throw new Error('Invalid quick-open channels');
  if (!value.channelOrder.every(id => typeof id === 'string') || new Set(value.channelOrder).size !== value.channelOrder.length || (value.activeChannelId !== null && (typeof value.activeChannelId !== 'string' || !value.channelOrder.includes(value.activeChannelId)))) throw new Error('Invalid channel order');
  const ids = new Set<string>();
  for (const canvas of value.canvases) {
    if (!record(canvas) || typeof canvas.id !== 'string' || ids.has(canvas.id) || !rectValid(canvas.rect) || (canvas.savedRect !== null && !rectValid(canvas.savedRect)) || (canvas.savedSnapped !== null && typeof canvas.savedSnapped !== 'boolean') || typeof canvas.maximized !== 'boolean' || typeof canvas.snapped !== 'boolean' || !finite(canvas.zIndex, 0, 2147483647)) throw new Error('Invalid canvas geometry');
    ids.add(canvas.id);
  }
}

/** Retain live buffers and in-progress command input when applying a layout. */
export function applyRemoteLayout(layout: RemoteLayout) {
  const previous = useTerminalStore.getState();
  if (remoteValueKey(previous.getLayoutSnapshot()) !== remoteValueKey(layout.terminal)) {
    previous.restoreLayoutSnapshot(layout.terminal);
    const panes = { ...useTerminalStore.getState().panes };
    for (const [id, pane] of Object.entries(panes)) {
      const old = previous.panes[id];
      if (!old) continue;
      const tabEntries = Object.fromEntries(pane.tabs.map(tab => [tab.id, old.tabEntries[tab.id] ?? []]));
      panes[id] = { ...old, ...pane, cmdInput: old.cmdInput, tabEntries, entries: tabEntries[pane.activeTabId ?? ''] ?? [], tabWriteTargets: old.tabWriteTargets, selectedWriteTarget: old.selectedWriteTarget, selectedTcpClientId: old.selectedTcpClientId, udpTargetAddr: old.udpTargetAddr };
    }
    useTerminalStore.setState({ panes });
  }
  useUIStore.setState(Object.fromEntries(UI_KEYS.map(key => [key, layout.ui[key]])));
  const channels = useChannelStore.getState().channels;
  useChannelStore.setState({ channels: layout.channelOrder.flatMap(id => channels.find(c => c.id === id) ?? []), activeChannelId: layout.activeChannelId });
  const geometries = new Map(layout.canvases.map(canvas => [canvas.id, canvas]));
  useCanvasStore.setState({ canvases: useCanvasStore.getState().canvases.map(canvas => {
    const geometry = geometries.get(canvas.id);
    // Explicit fields: remote objects can never replace config or active state.
    return geometry ? { ...canvas, rect: geometry.rect, savedRect: geometry.savedRect, savedSnapped: geometry.savedSnapped, zIndex: geometry.zIndex, maximized: geometry.maximized, snapped: geometry.snapped } : canvas;
  }) });
}

export function updateHostLayout(value: unknown, expected: unknown) {
  if (expected !== remoteLayoutRevision()) throw new Error('Layout changed on host. Refreshed; retry your change.');
  validateRemoteLayout(value);
  const current = captureRemoteLayout();
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
  if (!sameIds(current.channelOrder, value.channelOrder) || !sameIds(current.canvases.map(c => c.id), value.canvases.map(c => c.id))) throw new Error('Workspace objects changed. Refresh before editing.');
  for (const pane of Object.values(value.terminal.panes)) for (const tab of pane.tabs) {
    if ((tab.channelId !== null && !current.channelOrder.includes(tab.channelId)) || (Array.isArray(tab.receiveChannels) && tab.receiveChannels.some(id => !current.channelOrder.includes(id)))) throw new Error('Unknown terminal channel');
  }
  applyRemoteLayout(value);
  const layout = captureRemoteLayout();
  return { layout, revision: remoteLayoutRevision(layout) };
}
