import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLayoutImport, validateCanvases } from '../lib/layoutValidation';
import { importLayout } from '../components/layout/layoutImport';
import { useCanvasStore, useChannelStore, useTerminalStore, useUIStore } from '../stores';
import { terminalLayoutChanged } from '../lib/terminalLayoutChange';
import { canvasIngestStats, disposeCanvasIngest, enqueueCanvasIngest, MAX_CANVAS_INGEST_QUEUE } from '../lib/canvasIngestQueue';
import { resolveLayoutPaths } from '../lib/layoutPaths';

describe('portable examples', () => {
  const examples = import.meta.glob('../../config/layout/*.json', { query: '?raw', import: 'default', eager: true });
  it.each(Object.entries(examples))('validates %s', (_name, content) => {
    expect(() => parseLayoutImport(content as string)).not.toThrow();
  });
  it('resolves resources against the selected layout directory', () => {
    expect(resolveLayoutPaths({ luaPath: '../script/demo.lua', csvPath: 'C:/logs/out.csv' }, 'D:\\examples\\layout\\demo.json'))
      .toEqual({ luaPath: 'D:/examples/script/demo.lua', csvPath: 'C:/logs/out.csv' });
    expect(resolveLayoutPaths({ protocolFile: '../protocol/a.lua' }, '/opt/example/layout/a.json'))
      .toEqual({ protocolFile: '/opt/example/protocol/a.lua' });
  });
});

describe('layout import transaction boundary', () => {
  beforeEach(() => {
    useCanvasStore.getState().removeAllCanvases();
    useChannelStore.getState().restoreChannels([{ id: 'existing', type: 'serial', name: 'Existing' }]);
  });
  it.each([
    '{"canvases":[null]}',
    '{"channels":[],"ui":{"terminal_layout":{"root":null}}}',
    '{"channels":[],"mcp_tools":{"scripts":[null]}}',
    '{"channels":[],"__proto__":{"polluted":true}}',
    '{"channels":[{"id":"a","channel_type":"unknown","name":"a","settings":{}}]}',
    '{"channels":[{"id":"a","channel_type":"tcp","name":"a","settings":{"serverAddress":[]}}]}',
    '{"saved_commands":{"commandSets":{},"expandedGroups":{},"savedConfigs":{"a":[null]}}}',
  ])('rejects invalid data before removing channels or canvases: %s', (content) => {
    const id = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 100, height: 100 });
    const channels = useChannelStore.getState().channels;
    const canvases = useCanvasStore.getState().canvases;
    expect(() => importLayout(content)).toThrow();
    expect(useChannelStore.getState().channels).toBe(channels);
    expect(useCanvasStore.getState().canvases).toBe(canvases);
    expect(useCanvasStore.getState().canvases[0].id).toBe(id);
  });
  it('preserves absent sections and accepts explicit clears', () => {
    useUIStore.getState().replaceTerminalChannelSettings({
      existing: { sendFormat: 'hex', receiveFormat: 'ascii', showInputPrefix: false, showTimestamp: false },
    });
    const settings = useUIStore.getState().terminalChannelSettings;
    importLayout('{"ui":{"theme_mode":"dark"}}');
    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(useUIStore.getState().themeMode).toBe('dark');
    expect(useUIStore.getState().terminalChannelSettings).toBe(settings);
    importLayout('{"channels":[]}');
    expect(useChannelStore.getState().channels).toHaveLength(0);
  });
  it('rejects formulas in shared layouts without executing them', () => {
    useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 100, height: 100 });
    const canvases = structuredClone(useCanvasStore.getState().canvases);
    canvases[0].config.table = { columns: [{ id: 'x', alias: 'x', offset: 0, format: 'UInt8', formula: 'globalThis.x = 1' }] };
    expect(() => parseLayoutImport(JSON.stringify({ canvases }))).toThrow(/formula/);
    expect(validateCanvases(canvases, false)[0].config.table?.columns[0].formula).toBe('globalThis.x = 1');
  });
  it('drops rows arriving after canvas deletion', () => {
    const id = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 100, height: 100 });
    useCanvasStore.getState().removeCanvas(id);
    useCanvasStore.getState().pushRow(id, { timestamp: 1, channelId: 'existing', cells: {} });
    expect(useCanvasStore.getState().dataBuffers[id]).toBeUndefined();
  });
});

describe('terminal persistence selection', () => {
  it('ignores receive data and detects persisted edits', () => {
    const initial = useTerminalStore.getState();
    const paneId = Object.keys(initial.panes)[0];
    useTerminalStore.getState().appendEntry(paneId, 'rx', 'packet');
    const received = useTerminalStore.getState();
    expect(terminalLayoutChanged(received, initial)).toBe(false);
    useTerminalStore.getState().pushCmdHistory(paneId, 'test');
    expect(terminalLayoutChanged(useTerminalStore.getState(), received)).toBe(true);
  });
});

describe('bounded canvas queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { disposeCanvasIngest('test'); vi.useRealTimers(); });
  it('discards late results even if a new canvas reuses the same ID', async () => {
    let finish!: (commit: () => void) => void;
    const oldCommit = vi.fn();
    const newCommit = vi.fn();
    enqueueCanvasIngest('test', () => new Promise(resolve => { finish = resolve; }));
    disposeCanvasIngest('test');
    enqueueCanvasIngest('test', async () => newCommit);
    finish(oldCommit);
    await vi.runAllTimersAsync();
    expect(oldCommit).not.toHaveBeenCalled();
    expect(newCommit).toHaveBeenCalledOnce();
  });
  it('counts overload and continues after individual parse failures', async () => {
    let finish!: (commit: () => void) => void;
    const commit = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    enqueueCanvasIngest('test', () => new Promise(resolve => { finish = resolve; }));
    for (let i = 0; i < MAX_CANVAS_INGEST_QUEUE + 5; i++) enqueueCanvasIngest('test', async () => commit);
    enqueueCanvasIngest('test', async () => { throw new Error('bad packet'); });
    enqueueCanvasIngest('test', async () => commit);
    finish(commit);
    await vi.runAllTimersAsync();
    expect(canvasIngestStats('test')).toEqual({ pending: 0, dropped: 7, errors: 1 });
    expect(commit).toHaveBeenCalledTimes(MAX_CANVAS_INGEST_QUEUE);
    warning.mockRestore();
  });
});
