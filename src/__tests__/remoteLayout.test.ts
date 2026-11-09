import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useCanvasStore, useChannelStore, useTerminalStore, useUIStore, useRemoteStore } from '../stores';
import { captureRemoteLayout, remoteLayoutRevision, updateHostLayout, validateRemoteLayout } from '../lib/remoteLayout';
import { applyClientSnapshot, endRemoteWorkspace, flushRemoteLayout } from '../lib/remoteClient';
import { buildRemoteSnapshot } from '../lib/remoteHost';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

beforeEach(() => {
  endRemoteWorkspace(); vi.clearAllMocks();
  useChannelStore.setState({ channels: [], activeChannelId: null });
  useCanvasStore.setState({ canvases: [], dataBuffers: {} });
  useUIStore.setState({ leftPanelWidth: 100, centerPanelWidth: 600, rightPanelWidth: 400, centerSplitRatio: 0.5 });
});
afterEach(() => { endRemoteWorkspace(); });

describe('host-owned layout updates', () => {
  it('applies terminal splits, panels and canvas geometry while preserving receive buffers', () => {
    const canvasId = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 300, height: 200 });
    const paneId = useTerminalStore.getState().focusedPaneId!;
    useTerminalStore.getState().appendEntry(paneId, 'rx', 'retained data');
    const layout = structuredClone(captureRemoteLayout()), revision = remoteLayoutRevision();
    layout.ui.leftPanelWidth = 120;
    layout.canvases[0].rect.x = 50;
    const response = updateHostLayout(layout, revision);
    expect(useUIStore.getState().leftPanelWidth).toBe(120);
    expect(useCanvasStore.getState().canvases.find(c => c.id === canvasId)?.rect.x).toBe(50);
    expect(useTerminalStore.getState().panes[paneId].entries.some(e => e.text === 'retained data')).toBe(true);
    expect(response.revision).not.toBe(revision);
  });
  it('rejects stale edits without undoing a newer local layout', () => {
    const layout = captureRemoteLayout(), revision = remoteLayoutRevision();
    useUIStore.getState().setLeftPanelWidth(140);
    expect(() => updateHostLayout(layout, revision)).toThrow('Layout changed');
    expect(useUIStore.getState().leftPanelWidth).toBe(140);
  });
  it('rejects malformed geometry, dangling panes and workspace object removal', () => {
    const id = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 300, height: 200 });
    const layout = captureRemoteLayout();
    expect(() => validateRemoteLayout({ ...layout, ui: { ...layout.ui, centerSplitRatio: Infinity } })).toThrow();
    expect(() => validateRemoteLayout({ ...layout, terminal: { ...layout.terminal, panes: {} } })).toThrow();
    expect(() => updateHostLayout({ ...layout, canvases: [] }, remoteLayoutRevision())).toThrow('objects changed');
    expect(useCanvasStore.getState().canvases[0].id).toBe(id);
  });
  it('ignores injected executable config and local-only window settings', () => {
    useUIStore.setState({ closeBehavior: 'background' });
    useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 300, height: 200 });
    const config = useCanvasStore.getState().canvases[0].config;
    const layout = captureRemoteLayout();
    updateHostLayout({ ...layout, ui: { ...layout.ui, closeBehavior: 'exit' }, canvases: layout.canvases.map(c => ({ ...c, config: { type: 'script', script: { luaPath: 'untrusted.lua' } } })) }, remoteLayoutRevision());
    expect(useUIStore.getState().closeBehavior).toBe('background');
    expect(useCanvasStore.getState().canvases[0].config).toBe(config);
  });
});

describe('controller main-workspace bridge', () => {
  it('restores the controller workspace and does not send hydration back as an edit', async () => {
    const localLayout = captureRemoteLayout();
    const snapshot = buildRemoteSnapshot({ channelId: null, canvasId: null }, 1);
    snapshot.layout!.ui.leftPanelWidth = 145;
    useRemoteStore.setState({ connected: true });
    applyClientSnapshot(snapshot);
    expect(useRemoteStore.getState().active).toBe(true);
    expect(useUIStore.getState().leftPanelWidth).toBe(145);
    await flushRemoteLayout();
    expect(invoke).not.toHaveBeenCalled();
    endRemoteWorkspace();
    expect(captureRemoteLayout()).toEqual(localLayout);
  });
  it('sends a user edit with its original revision and accepts the host acknowledgement', async () => {
    const snapshot = buildRemoteSnapshot({ channelId: null, canvasId: null }, 1);
    useRemoteStore.setState({ connected: true }); applyClientSnapshot(snapshot);
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const request = args as { args: { layout: ReturnType<typeof captureRemoteLayout> } };
      return { layout: request.args.layout, revision: 'acknowledged' };
    });
    useUIStore.getState().setLeftPanelWidth(130);
    await flushRemoteLayout();
    expect(invoke).toHaveBeenCalledWith('remote_action', expect.objectContaining({ action: 'workspace.edit', args: expect.objectContaining({ revision: snapshot.layoutRevision }) }));
    expect(useUIStore.getState().leftPanelWidth).toBe(130);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('refreshes after conflict without replaying the rejected change', async () => {
    const snapshot = buildRemoteSnapshot({ channelId: null, canvasId: null }, 1);
    useRemoteStore.setState({ connected: true }); applyClientSnapshot(snapshot);
    const fresh = structuredClone(snapshot); fresh.layout!.ui.leftPanelWidth = 140; fresh.layoutRevision = 'new';
    vi.mocked(invoke).mockImplementation(async command => {
      if (command === 'remote_action') throw new Error('Layout changed');
      return fresh;
    });
    useUIStore.getState().setLeftPanelWidth(130); await expect(flushRemoteLayout()).rejects.toThrow('Layout changed');
    expect(useUIStore.getState().leftPanelWidth).toBe(140);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'remote_action')).toHaveLength(1);
  });
});
