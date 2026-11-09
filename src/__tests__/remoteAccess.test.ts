import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useBle, useSerial, useTcp } from '../hooks';
import { DEFAULT_TCP_CONFIG, useChannelStore, useSerialStore, useTcpStore, useBleStore, useCanvasStore } from '../stores';
import { buildRemoteSnapshot, executeRemoteAction, remoteChannel } from '../lib/remoteHost';
import { parseRemoteInput, remoteBytes } from '../lib/remoteValidation';
import { registerRemoteCanvas, remoteCanvasAction, remoteCanvasView } from '../lib/remoteCanvasBridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

function adapters() { return renderHook(() => ({ serial: useSerial(), tcp: useTcp(), ble: useBle() })).result.current; }
const watch = () => ({ channelId: null, canvasId: null });

beforeEach(() => {
  vi.clearAllMocks();
  useChannelStore.setState({ channels: [], activeChannelId: null });
  useSerialStore.setState({ channelConfigs: {}, connectionMap: {}, ports: [], openConnections: [] });
  useTcpStore.setState({ channelConfigs: {}, connectionMap: {}, clientConnections: [], serverClients: [], udpBound: false, udpAddr: '', serverListening: false });
  useBleStore.setState({ channelStates: {}, scanning: false });
  useCanvasStore.setState({ canvases: [], dataBuffers: {} });
});

describe('remote host authorization boundaries', () => {
  it('rejects stale configuration without overwriting the host', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    const old = remoteChannel(id);
    useSerialStore.getState().setChannelConfig(id, { path: 'COM7' });
    await expect(executeRemoteAction('channel.configure', { channelId: id, revision: old.revision, config: { path: 'COM3' } }, adapters(), watch())).rejects.toThrow('host configuration changed');
    expect(useSerialStore.getState().channelConfigs[id].path).toBe('COM7');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cannot send through another channels serial connection', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    useSerialStore.setState({ connectionMap: { 'port-other': 'another-channel' } });
    await expect(executeRemoteAction('channel.send', { channelId: id, data: [1] }, adapters(), watch())).rejects.toThrow('not connected');
    expect(invoke).not.toHaveBeenCalled();
    useSerialStore.setState({ connectionMap: { 'port-owned': id, 'port-other': 'another-channel' } });
    await executeRemoteAction('channel.send', { channelId: id, data: [0, 255] }, adapters(), watch());
    expect(invoke).toHaveBeenCalledExactlyOnceWith('send_serial_data', { connectionId: 'port-owned', data: [0, 255] });
  });

  it('restricts TCP server send to a client owned by the selected channel', async () => {
    const id = useChannelStore.getState().addChannel('tcp', 'Server');
    useTcpStore.setState({ channelConfigs: { [id]: { ...DEFAULT_TCP_CONFIG, mode: 'server' } }, connectionMap: { foreign: 'other' }, serverClients: [{ id: 'foreign', addr: '127.0.0.1:1234' }] });
    await expect(executeRemoteAction('channel.send', { channelId: id, clientId: 'foreign', data: [1] }, adapters(), watch())).rejects.toThrow('Select a connected TCP client');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not pass arbitrary invoke names through the bridge', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    await expect(executeRemoteAction('export_to_file', { channelId: id, path: 'secrets' }, adapters(), watch())).rejects.toThrow('not allowed');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('refuses configuration changes on a connected device', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    useChannelStore.getState().updateChannelState(id, 'connected');
    await expect(executeRemoteAction('channel.remove', { channelId: id, revision: remoteChannel(id).revision }, adapters(), watch())).rejects.toThrow('Disconnect');
    expect(useChannelStore.getState().channels).toHaveLength(1);
  });

  it('saves channel changes only on the host and returns a fresh snapshot', async () => {
    const id = useChannelStore.getState().addChannel('serial', 'UART');
    await executeRemoteAction('channel.configure', { channelId: id, revision: remoteChannel(id).revision, config: { path: 'COM8', baudRate: 9600 } }, adapters(), watch());
    expect(buildRemoteSnapshot(watch(), 42).channels[0].serial).toMatchObject({ path: 'COM8', baudRate: 9600 });
    expect(buildRemoteSnapshot(watch(), 42).sequence).toBe(42);
  });
});

describe('remote input and canvas ownership', () => {
  it('rejects malformed and excessive device data', () => {
    for (const input of ['1', 'zz', '01-02', '']) expect(() => parseRemoteInput(input, 'hex')).toThrow();
    expect(parseRemoteInput('00 aF\n10', 'hex')).toEqual([0, 175, 16]);
    expect(parseRemoteInput('好', 'text')).toEqual(Array.from(new TextEncoder().encode('好')));
    expect(() => remoteBytes([256])).toThrow();
    expect(() => remoteBytes(Array(8193).fill(0))).toThrow();
  });

  it('does not unregister a replacement bridge and executes only on the host', async () => {
    const old = registerRemoteCanvas('script', { view: () => ({ kind: 'form', values: {}, status: 'idle' }), action: vi.fn() });
    const action = vi.fn().mockResolvedValue(undefined);
    const current = registerRemoteCanvas('script', { view: () => ({ kind: 'form', values: {}, status: 'ready' }), action });
    old();
    expect(remoteCanvasView('script')).toMatchObject({ status: 'ready' });
    await remoteCanvasAction('script', 'script.run', {});
    expect(action).toHaveBeenCalledTimes(1);
    current();
    await expect(remoteCanvasAction('script', 'script.run', {})).rejects.toThrow('host');
  });
});
