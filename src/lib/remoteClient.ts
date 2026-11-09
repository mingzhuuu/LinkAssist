import { remoteValueKey } from './remoteValidation';
import { invoke } from '@tauri-apps/api/core';
import { useBleStore, useCanvasStore, useChannelStore, useCommandStore, useProtocolStore, useSerialStore, useTcpStore, useTerminalStore, useUIStore, toast } from '../stores';
import { isRemoteWorkspace, useRemoteStore } from '../stores/remoteStore';
import type { RemoteWorkspaceSnapshot } from '../types';
import { applyRemoteLayout, captureRemoteLayout, validateRemoteLayout, type RemoteLayout } from './remoteLayout';
import { visibleTerminalEntries } from '../stores/terminalStore';
import { flushWorkspaceSave } from './workspacePersistence';
import { applyWorkspaceContent, captureWorkspaceContent, type WorkspaceContent } from './remoteWorkspaceState';

let restore: (() => void) | null = null;
let applying = false;
let dirty = false;
let sending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = '';
let baseline = '';
let contentBaseline: WorkspaceContent | undefined;
let sequence = -1;
let syncError: unknown;
let generation = 0;
let unsubscribe: Array<() => void> = [];

export async function remoteAction(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!useRemoteStore.getState().connected) throw new Error('Remote host is disconnected');
  try { return await invoke('remote_action', { action, args }); }
  catch (error) { toast.error(String(error)); throw error; }
}

export async function prepareRemoteWorkspace() {
  if (isRemoteWorkspace()) return;
  if (useChannelStore.getState().channels.some(channel => channel.state === 'connected' || channel.state === 'connecting')) throw new Error('Disconnect local channels before switching to a remote workspace');
  await flushWorkspaceSave();
}

function begin() {
  if (restore) return;
  const ui = useUIStore.getState(), channel = useChannelStore.getState(), terminal = useTerminalStore.getState(), canvas = useCanvasStore.getState();
  const serial = useSerialStore.getState(), tcp = useTcpStore.getState(), ble = useBleStore.getState(), protocol = useProtocolStore.getState(), commands = useCommandStore.getState();
  restore = () => {
    const closeBehavior = useUIStore.getState().closeBehavior;
    useUIStore.setState({ ...ui, closeBehavior }); useChannelStore.setState(channel); useTerminalStore.setState(terminal); useCanvasStore.setState(canvas);
    useSerialStore.setState(serial); useTcpStore.setState(tcp); useBleStore.setState(ble); useProtocolStore.setState(protocol); useCommandStore.setState(commands);
  };
  useRemoteStore.setState({ active: true });
  unsubscribe = [useUIStore, useTerminalStore, useCanvasStore, useChannelStore, useSerialStore, useTcpStore, useBleStore, useCommandStore].map(store => store.subscribe(layoutChanged));
  unsubscribe.push(useTerminalStore.subscribe((state, previous) => {
    if (applying) return;
    for (const [paneId, pane] of Object.entries(state.panes)) {
      const old = previous.panes[paneId];
      if (!old || old.entries === pane.entries || old.activeTabId !== pane.activeTabId || old.tabs !== pane.tabs) continue;
      // Controller/host entry counters are independent. Identity identifies new
      // local echoes; matching numeric IDs must not suppress a command message.
      const added = pane.entries.filter(entry => (entry.kind === 'system' || (entry.kind === 'tx' && !entry.data)) && !old.entries.includes(entry));
      for (const entry of added) void flushRemoteLayout().then(() => remoteAction('terminal.append', { paneId, tabId: pane.activeTabId, text: entry.text, kind: entry.kind })).catch(() => {});
    }
  }));
}

function layoutChanged() {
  if (applying || !isRemoteWorkspace()) return;
  if (remoteValueKey(captureRemoteLayout()) === baseline && (!contentBaseline || remoteValueKey(captureWorkspaceContent()) === remoteValueKey(contentBaseline))) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => { void sendLayout(); }, 180);
}

async function sendLayout() {
  if (!dirty || sending || !useRemoteStore.getState().connected) return;
  sending = true; dirty = false;
  syncError = undefined;
  const currentGeneration = generation;
  const layout = captureRemoteLayout();
  const content = contentBaseline ? captureWorkspaceContent() : undefined;
  try {
    const response = await remoteAction(content ? 'workspace.edit' : 'workspace.layout', { layout, revision, ...(content ? { content, baseContent: contentBaseline } : {}) }) as { layout: RemoteLayout; revision: string; content?: WorkspaceContent };
    if (generation !== currentGeneration) return;
    revision = response.revision;
    if (response.content) contentBaseline = response.content;
    if (!dirty) {
      applying = true;
      if (response.content) applyWorkspaceContent(response.content, response.layout);
      applyRemoteLayout(response.layout);
      baseline = remoteValueKey(captureRemoteLayout());
      applying = false;
    }
  } catch (error) {
    if (generation !== currentGeneration) return;
    dirty = false;
    syncError = error;
    // Never replay an edit whose result is unknown or whose base is stale.
    const snapshot = await invoke<RemoteWorkspaceSnapshot | null>('remote_snapshot').catch(() => null);
    if (generation === currentGeneration && snapshot) applyClientSnapshot(snapshot, true);
  } finally {
    if (generation === currentGeneration) { sending = false; if (dirty) void sendLayout(); }
  }
}

export async function flushRemoteLayout() {
  clearTimeout(timer);
  await sendLayout();
  // Existing request owns its acknowledgement; poll only while it is in flight.
  while (sending) await new Promise(resolve => setTimeout(resolve, 20));
  if (dirty) await sendLayout();
  if (syncError) { const error = syncError; syncError = undefined; throw error; }
}

export function applyClientSnapshot(snapshot: RemoteWorkspaceSnapshot, force = false) {
  if (!useRemoteStore.getState().connected) return;
  if (!snapshot.layout || !snapshot.layoutRevision) { useRemoteStore.setState({ error: 'Update the host to enable main-window layout sync.' }); return; }
  validateRemoteLayout(snapshot.layout);
  if (!force && snapshot.sequence <= sequence) return;
  sequence = snapshot.sequence;
  begin();
  applying = true;
  try {
    const geometry = new Map(snapshot.layout.canvases.map(canvas => [canvas.id, canvas]));
    const pending = (dirty || sending) && !force;
    const content = pending ? captureWorkspaceContent() : snapshot.content;
    const pendingLayout = pending ? captureRemoteLayout() : snapshot.layout;
    const incomingParts = snapshot.layoutRevision.split(':');
    const currentParts = revision.split(':');
    const olderThanAcknowledgement = incomingParts[0] === currentParts[0] && Number(incomingParts[1]) < Number(currentParts[1]);
    if (olderThanAcknowledgement && !force) return;
    useChannelStore.setState({ channels: snapshot.channels.map(item => item.channel) });
    useSerialStore.setState({ ports: snapshot.ports, channelConfigs: Object.fromEntries(snapshot.channels.map(item => [item.channel.id, item.serial])), connectionMap: {}, openConnections: [] });
    useTcpStore.setState({ channelConfigs: Object.fromEntries(snapshot.channels.map(item => [item.channel.id, item.tcp])), serverClients: snapshot.channels.flatMap(item => item.clients), connectionMap: Object.fromEntries(snapshot.channels.flatMap(item => item.clients.map(c => [c.id, item.channel.id]))) });
    useBleStore.setState({ scanning: snapshot.scanning, channelStates: Object.fromEntries(snapshot.channels.flatMap(item => item.ble ? [[item.channel.id, item.ble]] : [])) });
    if (snapshot.connections) {
      useSerialStore.setState(snapshot.connections.serial);
      useTcpStore.setState(snapshot.connections.tcp);
      useBleStore.setState(snapshot.connections.ble);
    }
    const current = useCanvasStore.getState().canvases;
    useCanvasStore.setState({ canvases: snapshot.canvases.map(canvas => ({
      ...canvas, activationMode: canvas.activationMode ?? 'auto' as const,
      config: remoteValueKey(current.find(c => c.id === canvas.id)?.config) === remoteValueKey(canvas.config) ? current.find(c => c.id === canvas.id)!.config : canvas.config,
      rect: { x: 0, y: 0, width: 400, height: 300 }, savedRect: null, savedSnapped: null, zIndex: 0, maximized: false, snapped: false,
      ...(geometry.get(canvas.id) ?? {}),
      ...((dirty || sending) && !force ? current.find(c => c.id === canvas.id) : {}),
    })) });
    if (content) applyWorkspaceContent(content, pendingLayout);
    else if (snapshot.commands) useCommandStore.setState({ commandSets: snapshot.commands });
    useCanvasStore.setState({ dataBuffers: Object.fromEntries(Object.entries(snapshot.canvasFrames ?? {}).map(([id, frame]) => [id, frame.rows])), chartViewState: snapshot.chartViewState ?? {} });
    if (force || (!dirty && !sending && !olderThanAcknowledgement)) {
      applyRemoteLayout(snapshot.layout);
      revision = snapshot.layoutRevision;
      contentBaseline = snapshot.content;
      baseline = remoteValueKey(captureRemoteLayout());
    }
    const panes = { ...useTerminalStore.getState().panes };
    const entriesById = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    for (const [id, pane] of Object.entries(panes)) {
      const hostPane = snapshot.terminalEntries?.[id];
      const tabEntries = Object.fromEntries(pane.tabs.map(tab => [tab.id, snapshot.terminalEntryIds?.[id]?.[tab.id]?.flatMap(entryId => entriesById.get(entryId) ?? []) ?? hostPane?.[tab.id] ?? visibleTerminalEntries(tab, snapshot.entries)]));
      panes[id] = { ...pane, tabEntries, entries: tabEntries[pane.activeTabId ?? ''] ?? [] };
    }
    useTerminalStore.setState({ panes });
    useRemoteStore.setState({ snapshot, error: '' });
  } finally { applying = false; }
}

export function endRemoteWorkspace() {
  generation++; clearTimeout(timer); unsubscribe.forEach(fn => fn()); unsubscribe = [];
  applying = true;
  restore?.(); restore = null;
  dirty = false; sending = false; revision = ''; baseline = ''; contentBaseline = undefined; sequence = -1; syncError = undefined;
  useRemoteStore.setState({ active: false, connected: false, snapshot: null, name: '', error: '' });
  applying = false;
}

export async function remoteChannelAction(action: string, channelId: string, args: Record<string, unknown> = {}) {
  await flushRemoteLayout();
  const channel = useChannelStore.getState().channels.find(item => item.id === channelId);
  if (!channel) throw new Error('Channel no longer exists');
  const config = channel.type === 'serial' ? useSerialStore.getState().channelConfigs[channelId] : channel.type === 'tcp' ? useTcpStore.getState().channelConfigs[channelId] : null;
  return remoteAction(action, { channelId, revision: remoteValueKey([channel.name, channel.type, config]), ...args });
}

export function clearRemoteTerminal(paneId: string) {
  if (!isRemoteWorkspace()) { useTerminalStore.getState().clearEntries(paneId); return; }
  void flushRemoteLayout().then(() => remoteAction('terminal.clear', { paneId })).catch(() => {});
}

/** Route only named workspace reads through the authenticated host. */
export function workspaceInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isRemoteWorkspace()) return invoke<T>(command, args);
  const actions: Record<string, string> = {
    get_lua_protocol_file_summary: 'workspace.protocolSummary',
    parse_lua_automation_file: 'workspace.scriptDocument',
    parse_lua_canvas_lifecycle_file: 'workspace.lifecycleDocument',
  };
  const action = actions[command];
  if (!action) return Promise.reject(new Error(`Unsupported remote workspace command: ${command}`));
  return remoteAction(action, args) as Promise<T>;
}

/** Strict terminal adapter, never forwards arbitrary native command names. */
export function terminalInvoke<T>(command: string, args: Record<string, unknown>, channelId: string | null): Promise<T> {
  if (!isRemoteWorkspace()) return invoke<T>(command, args);
  if (!channelId) return Promise.reject(new Error('Select a remote channel first'));
  const action = command === 'write_ble_characteristic' ? 'channel.send' : command === 'subscribe_ble_notifications' ? 'ble.subscribe' : command === 'unsubscribe_ble_notifications' ? 'ble.unsubscribe' : null;
  if (!action) return Promise.reject(new Error('Unsupported remote terminal action'));
  return remoteChannelAction(action, channelId, { data: args.data, serviceUuid: args.serviceUuid, charUuid: args.charUuid }) as Promise<T>;
}
