import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SERIAL_CONFIG, DEFAULT_TCP_CONFIG, useBleStore, useCanvasStore, useChannelStore, useCommandStore, useRemoteStore, useSerialStore, useTcpStore, useTerminalStore, useUIStore } from '../stores';
import { applyClientSnapshot, endRemoteWorkspace, flushRemoteLayout, remoteChannelAction } from '../lib/remoteClient';
import { captureRemoteLayout, remoteLayoutRevision } from '../lib/remoteLayout';
import { captureWorkspaceContent, updateHostWorkspace } from '../lib/remoteWorkspaceState';
import { buildRemoteSnapshot } from '../lib/remoteHost';
import { UartPanel } from '../components/channels/uart';
import { TcpPanel } from '../components/channels/tcp';
import { CanvasScript } from '../components/display/CanvasScript';
import { getScriptRuntime } from '../components/display/scriptRuntime';
import { remoteValueKey } from '../lib/remoteValidation';
import { openWorkspaceFile } from '../lib/workspaceFileDialog';
import { open } from '@tauri-apps/plugin-dialog';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('../components/display/scriptRuntime', () => ({ getScriptRuntime: vi.fn(), disposeScriptRuntime: vi.fn() }));

beforeEach(() => {
  endRemoteWorkspace(); vi.clearAllMocks();
  useChannelStore.setState({ channels: [], activeChannelId: null });
  useSerialStore.setState({ channelConfigs: {}, connectionMap: {}, ports: [], openConnections: [] });
  useTcpStore.setState({ channelConfigs: {}, connectionMap: {}, clientConnections: [], serverClients: [], serverListening: false, udpBound: false });
  useBleStore.setState({ channelStates: {}, bleFilters: {}, customUuidNames: { services: {}, characteristics: {} } });
  useCanvasStore.setState({ canvases: [], dataBuffers: {}, chartViewState: {} });
  useCommandStore.setState({ commandSets: {}, expandedGroups: {}, savedConfigs: {} });
  useTerminalStore.getState().restoreLayoutSnapshot({ root: { type: 'leaf', paneId: 'pane' }, panes: { pane: { tabs: [{ id: 'all', channelId: null, label: 'ALL' }], activeTabId: 'all' } }, focusedPaneId: 'pane' });
  useUIStore.setState({ leftPanelWidth: 100, centerPanelWidth: 600, rightPanelWidth: 400, centerSplitRatio: 0.5 });
  vi.mocked(invoke).mockImplementation(async (command, payload) => {
    if (command !== 'remote_action') return null;
    const { action, args } = payload as { action: string; args: Record<string, unknown> };
    return action === 'workspace.edit' ? { layout: args.layout, content: args.content, revision: 'ack:2' } : null;
  });
});
afterEach(() => { cleanup(); endRemoteWorkspace(); });
const snapshot = () => structuredClone(buildRemoteSnapshot({ channelId: null, canvasId: null }, 1));
const connect = () => { const value = snapshot(); useRemoteStore.setState({ connected: true }); applyClientSnapshot(value); return value; };

describe('shared remote workspace editing', () => {
  it('atomically creates a channel and canvas with configuration, selection and saved commands', () => {
    const layout = captureRemoteLayout(), baseContent = captureWorkspaceContent(), revision = remoteLayoutRevision();
    const content = structuredClone(baseContent);
    content.channels.push({ id: 'new', name: 'UART', type: 'serial', serial: { ...DEFAULT_SERIAL_CONFIG, path: 'COM8' }, tcp: DEFAULT_TCP_CONFIG });
    content.canvases.push({ id: 'table', name: 'Data', groupId: null, activationMode: 'auto', config: { type: 'table', dataSource: 'raw', channels: [{ channelId: 'new', protocolTemplateId: null }], table: { columns: [] } } });
    layout.channelOrder = ['new']; layout.activeChannelId = 'new'; layout.ui.channelConfigPreview = true;
    layout.canvases = [{ id: 'table', rect: { x: 0, y: 0, width: 200, height: 200 }, savedRect: null, savedSnapped: null, zIndex: 1, maximized: false, snapped: false }];
    content.commands.commandSets.new = { groups: [], commands: [{ id: 'cmd', name: 'Read', command: '01', groupId: null, order: 0 }] };
    // The Rust Value boundary sorts keys, unlike a plain JS object clone.
    updateHostWorkspace(JSON.parse(remoteValueKey({ layout, revision, content, baseContent })));
    expect(useChannelStore.getState().activeChannelId).toBe('new');
    expect(useSerialStore.getState().channelConfigs.new.path).toBe('COM8');
    expect(useUIStore.getState().channelConfigPreview).toBe(true);
    expect(useCanvasStore.getState().canvases[0].config.channels[0].channelId).toBe('new');
    expect(useCommandStore.getState().commandSets.new.commands[0].command).toBe('01');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects concurrent configuration and invalid connected-channel edits before changing any store', () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    const baseContent = captureWorkspaceContent(), content = structuredClone(baseContent), layout = captureRemoteLayout(), revision = remoteLayoutRevision();
    content.channels[0].serial.path = 'COM3'; layout.ui.leftPanelWidth = 130;
    useChannelStore.getState().updateChannelState(id, 'connected');
    expect(() => updateHostWorkspace({ layout, revision, content, baseContent })).toThrow('Disconnect');
    expect(useUIStore.getState().leftPanelWidth).toBe(100);
    useChannelStore.getState().updateChannelState(id, 'disconnected');
    useSerialStore.getState().setChannelConfig(id, { path: 'COM9' });
    expect(() => updateHostWorkspace({ layout, revision, content, baseContent })).toThrow('Workspace changed');
    expect(useSerialStore.getState().channelConfigs[id].path).toBe('COM9');
  });

  it('preserves a new channel and its unfinished configuration across incoming snapshots', async () => {
    const host = connect();
    const id = useChannelStore.getState().addChannel('tcp', 'TCP/IP');
    useChannelStore.getState().setActiveChannel(id);
    useUIStore.getState().openChannelConfig();
    useTcpStore.getState().setChannelConfig(id, { clientAddress: '10.0.0.7:' });
    const canvasId = useCanvasStore.getState().addCanvas({ x: 12, y: 20, width: 300, height: 200 });
    applyClientSnapshot({ ...host, sequence: 2 });
    expect(useChannelStore.getState().activeChannelId).toBe(id);
    expect(useTcpStore.getState().channelConfigs[id].clientAddress).toBe('10.0.0.7:');
    expect(useCanvasStore.getState().canvases[0].id).toBe(canvasId);
    await flushRemoteLayout();
    expect(invoke).toHaveBeenCalledWith('remote_action', expect.objectContaining({ action: 'workspace.edit', args: expect.objectContaining({ content: expect.objectContaining({ channels: expect.arrayContaining([expect.objectContaining({ id })]) }) }) }));
  });

  it('flushes field changes before connect and uses the acknowledged configuration revision', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART'); connect();
    useSerialStore.getState().setChannelConfig(id, { path: 'COM8', receiveTimeoutMs: 123 });
    await remoteChannelAction('channel.connect', id);
    const requests = vi.mocked(invoke).mock.calls.map(([, args]) => args as { action: string; args: Record<string, unknown> });
    expect(requests.map(r => r.action)).toEqual(['workspace.edit', 'channel.connect']);
    expect(requests[1].args.revision).toContain('COM8');
    expect(requests[1].args.revision).toContain('123');
  });

  it('keeps per-tab clear state and complete packets instead of rebuilding every tab from ALL', () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    const tabId = useTerminalStore.getState().addTab('pane', id, 'UART');
    const bytes = Array(2048).fill(65);
    useTerminalStore.getState().appendEntryToChannel(id, 'rx', 'full packet', 1, bytes);
    useTerminalStore.getState().selectPaneTab('pane', tabId);
    useTerminalStore.getState().clearEntries('pane');
    connect();
    const pane = useTerminalStore.getState().panes.pane;
    expect(pane.tabEntries[tabId]).toEqual([]);
    expect(pane.tabEntries.all[0].data).toHaveLength(2048);
  });

  it('does not send a snapshot back as an edit and restores local buffers on disconnect', async () => {
    const id = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 200, height: 200 });
    useCanvasStore.getState().pushRow(id, { timestamp: 1, channelId: '', cells: { v: 'local' } });
    const local = useCanvasStore.getState();
    const host = snapshot(); host.canvasFrames![id].rows = [{ timestamp: 2, channelId: '', cells: { v: 'host' } }];
    useRemoteStore.setState({ connected: true }); applyClientSnapshot(JSON.parse(remoteValueKey(host)));
    const config = useCanvasStore.getState().canvases[0].config;
    applyClientSnapshot(structuredClone({ ...host, sequence: 2 }));
    expect(useCanvasStore.getState().canvases[0].config).toBe(config);
    await flushRemoteLayout(); expect(invoke).not.toHaveBeenCalled();
    endRemoteWorkspace(); expect(useCanvasStore.getState().dataBuffers).toEqual(local.dataBuffers);
    applyClientSnapshot({ ...host, sequence: 99 });
    expect(useRemoteStore.getState().active).toBe(false);
    expect(useCanvasStore.getState().dataBuffers).toEqual(local.dataBuffers);
  });

  it('does not lose command messages when the controller counter overlaps host entry IDs', async () => {
    useTerminalStore.getState().appendEntry('pane', 'system', 'before connecting');
    const nextId = useTerminalStore.getState().panes.pane.entries[0].id + 1;
    const host = snapshot();
    host.entries = [{ id: nextId, kind: 'rx', timestamp: 1, text: 'host data' }];
    host.terminalEntryIds = { pane: { all: [nextId] } };
    useRemoteStore.setState({ connected: true }); applyClientSnapshot(host);
    useTerminalStore.getState().appendEntry('pane', 'system', 'Send target selected');
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_action', expect.objectContaining({ action: 'terminal.append', args: expect.objectContaining({ text: 'Send target selected' }) })));
  });
});

describe('shared remote components', () => {
  it('renders the normal UART fields and sends Open Port to the host', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    useSerialStore.getState().setChannelConfig(id, { path: 'COM42' }); connect();
    render(<UartPanel channelId={id} />);
    expect(screen.getByText('Recv Timeout')).toBeTruthy();
    expect(screen.queryByText('Configure')).toBeNull();
    fireEvent.click(screen.getByText('Open Port'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_action', expect.objectContaining({ action: 'channel.connect' })));
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'remote_action')).toBe(true);
  });

  it('shows an existing TCP connection immediately and disconnects its owning channel', async () => {
    const id = useChannelStore.getState().addChannel('tcp', 'TCP/IP');
    useChannelStore.getState().updateChannelState(id, 'connected');
    useTcpStore.setState({ clientConnections: [{ id: 'host-connection', addr: '10.0.0.1:80' }], connectionMap: { 'host-connection': id } }); connect();
    render(<TcpPanel channelId={id} />);
    fireEvent.click(screen.getByText('Disconnect'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_action', expect.objectContaining({ action: 'channel.disconnect', args: expect.objectContaining({ channelId: id }) })));
  });

  it('uses the script header and controls without creating a controller runtime', () => {
    const id = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 300, height: 200 });
    useCanvasStore.getState().updateCanvasConfig(id, { type: 'script' });
    const host = snapshot();
    host.canvasFrames![id].view = { kind: 'script', ui: null, values: {}, sources: {}, error: '', snapshot: { status: 'idle', scriptName: 'Remote automation', currentStepIndex: -1, steps: [], logs: [] } };
    useRemoteStore.setState({ connected: true }); applyClientSnapshot(host);
    render(<CanvasScript canvasId={id} />);
    expect(screen.getByText('Remote automation')).toBeTruthy();
    fireEvent.click(screen.getByText('Run'));
    expect(invoke).toHaveBeenCalledWith('remote_action', { action: 'script.run', args: { canvasId: id } });
    expect(getScriptRuntime).not.toHaveBeenCalled();
  });

  it('browses and selects a host file without opening a controller file dialog', async () => {
    connect();
    vi.mocked(invoke).mockResolvedValue({ path: 'C:/host', parent: 'C:/', entries: [{ name: 'automation.lua', path: 'C:/host/automation.lua', directory: false }] });
    let result: Promise<string | null>;
    await act(async () => { result = openWorkspaceFile({ multiple: false, filters: [{ name: 'Lua', extensions: ['lua'] }] }); });
    fireEvent.doubleClick(await screen.findByText('automation.lua'));
    expect(await result!).toBe('C:/host/automation.lua');
    expect(invoke).toHaveBeenCalledWith('remote_action', { action: 'workspace.browse', args: { path: '' } });
    expect(open).not.toHaveBeenCalled();
  });
});
