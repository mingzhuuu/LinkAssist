import { isRemoteWorkspace, useRemoteStore } from '../stores/remoteStore';
import { remoteChannelAction } from './remoteClient';
import { invoke } from '@tauri-apps/api/core';
import { useSerialStore } from '../stores/serialStore';
import { useTcpStore } from '../stores/tcpStore';
import { useBleStore } from '../stores/bleStore';
import type { PaneState } from '../stores/terminalStore';
import type { Channel } from '../types';

/** Capture the selected endpoint before queuing raw terminal input. No parsing or newline suffix. */
export function prepareTerminalInteractiveSend(
  channel: Channel,
  pane: PaneState,
  data: number[],
  report: (message: string) => void,
): () => Promise<unknown> {
  if (isRemoteWorkspace()) return prepareRemoteSend(channel, pane, data);
  if (channel.type !== 'ble') return prepareTerminalNetworkSend(channel, pane, data, report);
  const deviceId = useBleStore.getState().channelStates[channel.id]?.connectedDeviceId;
  if (!deviceId) throw new Error('BLE not connected');
  const target = pane.selectedWriteTarget;
  if (!target) throw new Error('Turn interaction OFF and use /select to choose a writable characteristic first');
  return () => invoke('write_ble_characteristic', {
    deviceId, serviceUuid: target.serviceUuid, charUuid: target.charUuid, data,
  });
}

/** Resolve only endpoints owned by the explicitly selected channel. */
export function prepareTerminalNetworkSend(
  channel: Channel,
  pane: PaneState,
  data: number[],
  report: (message: string) => void,
): () => Promise<unknown> {
  if (isRemoteWorkspace()) return prepareRemoteSend(channel, pane, data);
  if (channel.type === 'serial') {
    const id = Object.entries(useSerialStore.getState().connectionMap).find(([, owner]) => owner === channel.id)?.[0];
    if (!id) throw new Error('No serial port open for this channel');
    if (id.startsWith('monitor:')) throw new Error('Monitor channels are read-only');
    return () => invoke('send_serial_data', { connectionId: id, data });
  }
  const tcp = useTcpStore.getState();
  const mode = tcp.channelConfigs[channel.id]?.mode ?? tcp.mode;
  if (mode === 'client') {
    const conn = tcp.clientConnections.find(c => tcp.connectionMap[c.id] === channel.id);
    if (!conn) throw new Error('No active TCP connection for this channel');
    return () => invoke('tcp_send', { connectionId: conn.id, data });
  }
  if (mode === 'udp') {
    if (!tcp.udpBound || tcp.connectionMap[`udp:${tcp.udpAddr}`] !== channel.id) {
      throw new Error('No UDP socket bound for this channel');
    }
    const addr = pane.udpTargetAddr;
    if (!addr) throw new Error('No UDP target set — use /udptarget <ip:port> first');
    return () => invoke('udp_send', { addr, data });
  }
  const clients = tcp.serverClients.filter(c => tcp.connectionMap[c.id] === channel.id);
  if (!clients.length) throw new Error('No TCP client connected to this channel');
  if (pane.selectedTcpClientId === 'all') {
    return async () => {
      const results = await Promise.allSettled(clients.map(c => invoke('tcp_server_send', { clientId: c.id, data })));
      const sent = results.filter(r => r.status === 'fulfilled').length;
      if (!sent) throw new Error('Broadcast failed for every client');
      if (sent < clients.length) report(`Broadcast: ${sent}/${clients.length} clients reached`);
    };
  }
  const client = pane.selectedTcpClientId ? clients.find(c => c.id === pane.selectedTcpClientId) : clients[0];
  if (!client) throw new Error('Selected client disconnected — use /clients to pick a new target');
  if (!pane.selectedTcpClientId && clients.length > 1) report(`Sending to ${client.addr} (use /client <n|all> to change)`);
  return () => invoke('tcp_server_send', { clientId: client.id, data });
}

export async function sendWithImmediateTxEcho(
  echoTx: () => void,
  send: () => Promise<unknown>
): Promise<void> {
  // A response can arrive before an asynchronous send invocation resolves.
  // Echo the user's send first so terminal history preserves causality.
  echoTx();
  await send();
}

function prepareRemoteSend(channel: Channel, pane: PaneState, data: number[]): () => Promise<unknown> {
  const clients = useRemoteStore.getState().snapshot?.channels.find(item => item.channel.id === channel.id)?.clients ?? [];
  const args = { data, target: pane.udpTargetAddr ?? undefined, serviceUuid: pane.selectedWriteTarget?.serviceUuid, charUuid: pane.selectedWriteTarget?.charUuid };
  if (pane.selectedTcpClientId === 'all' && channel.type === 'tcp') return () => Promise.all(clients.map(client => remoteChannelAction('channel.send', channel.id, { ...args, clientId: client.id })));
  return () => remoteChannelAction('channel.send', channel.id, { ...args, clientId: pane.selectedTcpClientId ?? clients[0]?.id });
}
