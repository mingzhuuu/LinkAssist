import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTcp } from '../hooks/useTcp';
import { useTcpStore, useChannelStore } from '../stores';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

describe('transport routing lifecycle', () => {
  beforeEach(() => {
    useTcpStore.setState({ connectionMap: {}, serverClients: [], serverListening: false, serverAddr: '', udpBound: false, udpAddr: '' });
    useChannelStore.getState().restoreChannels([{ id: 'transport', type: 'tcp', name: 'Loopback' }]);
  });
  afterEach(cleanup);
  it('retains the listening address used to associate accepted clients, then clears old routes', async () => {
    const { result } = renderHook(useTcp);
    await act(() => result.current.startServer('127.0.0.1:17890', 'transport'));
    const server = useTcpStore.getState();
    expect(server.serverAddr).toBe('127.0.0.1:17890');
    expect(server.connectionMap[`server:${server.serverAddr}`]).toBe('transport');
    act(() => {
      server.addServerClient({ id: 'accepted-client', addr: '127.0.0.1:50000' });
      server.setConnectionChannel('accepted-client', 'transport');
    });
    await act(() => result.current.stopServer('transport'));
    expect(useTcpStore.getState().connectionMap).toEqual({});
  });
  it('retains the UDP binding address and removes the route after unbind', async () => {
    const { result } = renderHook(useTcp);
    await act(() => result.current.bindUdp('127.0.0.1:17891', 'transport'));
    const udp = useTcpStore.getState();
    expect(udp.udpAddr).toBe('127.0.0.1:17891');
    expect(udp.connectionMap[`udp:${udp.udpAddr}`]).toBe('transport');
    await act(() => result.current.unbindUdp('transport'));
    expect(useTcpStore.getState().connectionMap).toEqual({});
  });
});
