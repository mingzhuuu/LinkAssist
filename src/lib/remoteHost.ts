import { captureRemoteLayout, remoteLayoutRevision, updateHostLayout } from './remoteLayout';
import { useCommandStore } from '../stores/commandStore';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SERIAL_CONFIG, DEFAULT_TCP_CONFIG, normalizeSerialConfig, useBleStore, useCanvasStore, useChannelStore, useSerialStore, useTcpStore, useTerminalStore, useUIStore } from '../stores';
import type { RemoteChannel, RemoteWorkspaceSnapshot } from '../types';
import type { useBle, useSerial, useTcp } from '../hooks';
import { getSnapshot as chartSnapshot, clear as clearChart, setPaused } from '../components/display/chartRuntime';
import { remoteCanvasAction, remoteCanvasView } from './remoteCanvasBridge';
import { checkRemoteRevision, remoteBytes, remoteText, remoteValueKey } from './remoteValidation';
import { captureWorkspaceContent, updateHostWorkspace } from './remoteWorkspaceState';

export interface RemoteWatch { channelId: string | null; canvasId: string | null }
export interface RemoteHostAdapters { serial: ReturnType<typeof useSerial>; tcp: ReturnType<typeof useTcp>; ble: ReturnType<typeof useBle> }

function boundedCanvasFrame(id: string, budget: number): NonNullable<RemoteWorkspaceSnapshot['canvasFrames']>[string] {
  const store = useCanvasStore.getState();
  const canvas = store.canvases.find(c => c.id === id);
  let rows = store.dataBuffers[id] ?? [];
  let chart = canvas?.config.type === 'chart' ? chartSnapshot(id) : null;
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify({ rows, chart })).length > budget && (rows.length > 1 || (chart?.[0].length ?? 0) > 2)) {
    rows = rows.slice(-Math.max(1, Math.ceil(rows.length / 2)));
    if (chart) chart = chart.map(series => series.slice(-Math.max(2, Math.ceil(series.length / 2)))) as typeof chart;
  }
  return { rows, chart, view: remoteCanvasView(id) };
}

export function remoteChannel(id: string): RemoteChannel {
  const channel = useChannelStore.getState().channels.find(item => item.id === id);
  if (!channel) throw new Error('Channel no longer exists');
  const serial = useSerialStore.getState().channelConfigs[id] ?? DEFAULT_SERIAL_CONFIG;
  const tcpState = useTcpStore.getState();
  const tcp = tcpState.channelConfigs[id] ?? DEFAULT_TCP_CONFIG;
  return {
    channel, serial, tcp,
    revision: remoteValueKey([channel.name, channel.type, channel.type === 'serial' ? serial : channel.type === 'tcp' ? tcp : null]),
    ble: useBleStore.getState().channelStates[id] ?? null,
    clients: tcpState.serverClients.filter(client => tcpState.connectionMap[client.id] === id),
  };
}

export function buildRemoteSnapshot(watch: RemoteWatch, sequence: number): RemoteWorkspaceSnapshot {
  const canvasStore = useCanvasStore.getState();
  const entries = new Map<number, ReturnType<typeof useTerminalStore.getState>['panes'][string]['entries'][number]>();
  for (const pane of Object.values(useTerminalStore.getState().panes)) {
    for (const list of [pane.entries, ...Object.values(pane.tabEntries)]) {
      for (const entry of list) {
        if (!watch.channelId || entry.sourceChannelId === watch.channelId) entries.set(entry.id, entry);
      }
    }
  }
  const canvas = canvasStore.canvases.find(item => item.id === watch.canvasId);
  const serialState = useSerialStore.getState(), tcpState = useTcpStore.getState(), bleState = useBleStore.getState();
  // Deduplicate across ALL/MIXED/channel tabs; retain complete byte packets.
  const terminalEntries = [...entries.values()].sort((a, b) => a.id - b.id);
  const encoder = new TextEncoder();
  let bytes = 0, start = terminalEntries.length;
  while (start > 0) {
    const size = encoder.encode(JSON.stringify(terminalEntries[start - 1])).length;
    if (bytes + size > 800_000) break;
    bytes += size; start--;
  }
  const retainedEntries = terminalEntries.slice(start);
  const retainedIds = new Set(retainedEntries.map(entry => entry.id));
  return {
    version: 1, sequence,
    content: captureWorkspaceContent(),
    terminalEntryIds: Object.fromEntries(Object.entries(useTerminalStore.getState().panes).map(([id, pane]) => [id, Object.fromEntries(pane.tabs.map(tab => [tab.id, (pane.tabEntries[tab.id] ?? []).filter(entry => retainedIds.has(entry.id)).map(entry => entry.id)]))])),
    chartViewState: canvasStore.chartViewState,
    connections: {
      serial: { connectionMap: serialState.connectionMap, openConnections: serialState.openConnections },
      tcp: { connectionMap: tcpState.connectionMap, clientConnections: tcpState.clientConnections, serverListening: tcpState.serverListening, serverAddr: tcpState.serverAddr, serverClients: tcpState.serverClients, udpBound: tcpState.udpBound, udpAddr: tcpState.udpAddr },
      ble: { scanningChannelId: bleState.scanningChannelId, connectedChannelId: bleState.connectedChannelId, connectedDeviceId: bleState.connectedDeviceId, deviceChannelMap: bleState.deviceChannelMap, devices: bleState.devices, gattServices: bleState.gattServices, lastConnectedDeviceIds: bleState.lastConnectedDeviceIds, lastConnectedDevices: bleState.lastConnectedDevices },
    },
    layout: captureRemoteLayout(), layoutRevision: remoteLayoutRevision(),
    commands: useCommandStore.getState().commandSets,
    canvasFrames: Object.fromEntries(canvasStore.canvases.map(c => [c.id, boundedCanvasFrame(c.id, Math.floor(600_000 / Math.max(1, canvasStore.canvases.length)))])),
    themeMode: useUIStore.getState().themeMode,
    channels: useChannelStore.getState().channels.map(channel => remoteChannel(channel.id)),
    ports: useSerialStore.getState().ports,
    scanning: useBleStore.getState().scanning,
    entries: retainedEntries,
    canvases: canvasStore.canvases.map(({ id, name, active, config, activationMode, groupId }) => ({ id, name, active, config, activationMode, groupId })),
    canvasId: canvas?.id ?? null,
    rows: canvas ? (canvasStore.dataBuffers[canvas.id] ?? []).slice(-100) : [],
    chart: canvas?.config.type === 'chart' ? chartSnapshot(canvas.id).map(series => series.slice(-500)) : null,
    canvasView: canvas ? remoteCanvasView(canvas.id) : null,
  };
}

export async function executeRemoteAction(action: string, args: Record<string, unknown>, adapters: RemoteHostAdapters, watch: RemoteWatch): Promise<unknown> {
  if (action === 'workspace.browse') return invoke('remote_list_directory', { path: typeof args.path === 'string' ? args.path : '' });
  if (action === 'workspace.edit') return updateHostWorkspace(args);
  if (action === 'workspace.protocolSummary') return invoke('get_lua_protocol_file_summary', { filePath: remoteText(args.filePath, 'protocol path', 4096), resourceRoot: args.resourceRoot });
  if (action === 'workspace.scriptDocument' || action === 'workspace.lifecycleDocument') return invoke(action === 'workspace.scriptDocument' ? 'parse_lua_automation_file' : 'parse_lua_canvas_lifecycle_file', { path: remoteText(args.path, 'script path', 4096) });
  if (action === 'terminal.clear') {
    const paneId = remoteText(args.paneId, 'pane ID');
    if (!useTerminalStore.getState().panes[paneId]) throw new Error('Terminal no longer exists');
    useTerminalStore.getState().clearEntries(paneId); return null;
  }
  if (action === 'terminal.append') {
    const paneId = remoteText(args.paneId, 'pane ID');
    const pane = useTerminalStore.getState().panes[paneId];
    if (!pane || pane.activeTabId !== args.tabId) throw new Error('Terminal selection changed');
    if (typeof args.text !== 'string' || args.text.length > 16384 || !['system', 'tx'].includes(String(args.kind))) throw new Error('Invalid terminal message');
    useTerminalStore.getState().appendEntry(paneId, args.kind as 'system' | 'tx', args.text); return null;
  }
  if (action === 'ble.pairingStatuses') {
    if (!Array.isArray(args.deviceIds) || args.deviceIds.some(id => typeof id !== 'string')) throw new Error('Invalid BLE devices');
    return adapters.ble.getPairingStatuses(args.deviceIds as string[]);
  }
  if (action === 'workspace.layout') return updateHostLayout(args.layout, args.revision);
  if (action === 'workspace.watch') {
    watch.channelId = typeof args.channelId === 'string' ? args.channelId : null;
    watch.canvasId = typeof args.canvasId === 'string' ? args.canvasId : null;
    return null;
  }
  if (action === 'serial.refresh') { await adapters.serial.refreshPorts(); return null; }
  if (action === 'ble.stopScan') { await adapters.ble.stopScan(); return null; }
  if (action === 'channel.create') {
    if (!['serial', 'tcp', 'ble'].includes(String(args.type))) throw new Error('Unknown channel type');
    return useChannelStore.getState().addChannel(args.type as 'serial' | 'tcp' | 'ble', remoteText(args.name, 'channel name', 100));
  }
  if (action.startsWith('canvas.') || action.startsWith('script.')) {
    const id = remoteText(args.canvasId, 'canvas ID');
    const store = useCanvasStore.getState();
    const canvas = store.canvases.find(item => item.id === id);
    if (!canvas) throw new Error('Canvas no longer exists');
    if (action === 'canvas.activate') {
      if (canvas.config.channels.some(link => useChannelStore.getState().channels.find(channel => channel.id === link.channelId)?.state !== 'connected')) throw new Error('Connect the linked channels first');
      store.activateCanvas(id);
    } else if (action === 'canvas.deactivate') store.deactivateCanvas(id);
    else if (action === 'canvas.clear') { store.clearRows(id); clearChart(id); }
    else if (action === 'canvas.pause') { store.setChartPaused(id, args.paused === true); setPaused(id, args.paused === true); }
    else await remoteCanvasAction(id, action, args);
    return null;
  }
  const id = remoteText(args.channelId, 'channel ID');
  const context = remoteChannel(id);
  const { channel, serial, tcp, ble } = context;
  const serialStore = useSerialStore.getState();
  const tcpStore = useTcpStore.getState();
  const connectionId = Object.entries(serialStore.connectionMap).find(([, owner]) => owner === id)?.[0];
  const tcpConnection = tcpStore.clientConnections.find(connection => tcpStore.connectionMap[connection.id] === id);

  if (['channel.configure', 'channel.rename', 'channel.remove'].includes(action)) {
    checkRemoteRevision(args.revision, context.revision);
    if (action === 'channel.rename') {
      const name = remoteText(args.name, 'channel name', 100);
      useChannelStore.getState().renameChannel(id, name);
      const terminal = useTerminalStore.getState();
      for (const [paneId, pane] of Object.entries(terminal.panes)) for (const tab of pane.tabs) if (tab.channelId === id) terminal.renameTab(paneId, tab.id, name);
      return null;
    }
    if (channel.state === 'connected' || channel.state === 'connecting') throw new Error('Disconnect the channel before changing its configuration');
    if (action === 'channel.remove') { useChannelStore.getState().removeChannel(id); return null; }
    if (!args.config || typeof args.config !== 'object' || Array.isArray(args.config)) throw new Error('Invalid channel configuration');
    if (channel.type === 'serial') {
      const config = normalizeSerialConfig(args.config);
      remoteText(config.path, 'serial port');
      serialStore.setChannelConfig(id, config);
    } else if (channel.type === 'tcp') {
      const config = args.config as Record<string, unknown>;
      if (!['client', 'server', 'udp'].includes(String(config.mode))) throw new Error('Invalid TCP mode');
      tcpStore.setChannelConfig(id, {
        mode: config.mode as 'client' | 'server' | 'udp',
        clientAddress: remoteText(config.clientAddress, 'TCP address'),
        serverAddress: remoteText(config.serverAddress, 'listen address'),
        udpBindAddress: remoteText(config.udpBindAddress, 'UDP bind address'),
        udpTargetAddress: remoteText(config.udpTargetAddress, 'UDP target'),
      });
    } else throw new Error('BLE uses device selection instead of a connection configuration');
    return null;
  }
  if (action === 'channel.connect') {
    checkRemoteRevision(args.revision, context.revision);
    if (channel.state === 'connected' || channel.state === 'connecting') throw new Error('Channel is already connected or connecting');
    if (channel.type === 'serial') return adapters.serial.openPort(serial, id);
    else if (channel.type === 'ble') {
      if (args.deviceId) await adapters.ble.connectDevice(remoteText(args.deviceId, 'BLE device'), id);
      else await adapters.ble.reconnectLastDevice(id);
    } else if (tcp.mode === 'client') return adapters.tcp.connectTcp(tcp.clientAddress, id);
    else if (tcp.mode === 'server') {
      if (tcpStore.serverListening) throw new Error('The TCP server is already in use');
      await adapters.tcp.startServer(tcp.serverAddress, id);
    } else {
      if (tcpStore.udpBound) throw new Error('The UDP socket is already in use');
      await adapters.tcp.bindUdp(tcp.udpBindAddress, id);
    }
    return null;
  }
  if (action === 'channel.disconnect') {
    if (channel.type === 'serial' && connectionId) await adapters.serial.closePort(connectionId, id);
    else if (channel.type === 'ble' && ble?.connectedDeviceId) await adapters.ble.disconnectDevice(ble.connectedDeviceId, id);
    else if (channel.type === 'tcp' && tcp.mode === 'client' && tcpConnection) await adapters.tcp.disconnectTcp(tcpConnection.id, id);
    else if (channel.type === 'tcp' && tcp.mode === 'server' && tcpStore.connectionMap[`server:${tcpStore.serverAddr}`] === id) await adapters.tcp.stopServer(id);
    else if (channel.type === 'tcp' && tcp.mode === 'udp' && tcpStore.connectionMap[`udp:${tcpStore.udpAddr}`] === id) await adapters.tcp.unbindUdp(id);
    else throw new Error('This channel has no active connection');
    return null;
  }
  if (action === 'ble.scan') {
    if (channel.type !== 'ble') throw new Error('Select a BLE channel');
    await adapters.ble.startScan(id);
    if (!useBleStore.getState().scanning) throw new Error('BLE scan could not be started');
    return null;
  }
  if (action === 'tcp.disconnectClient') {
    const client = context.clients.find(item => item.id === args.clientId);
    if (!client) throw new Error('Client does not belong to this channel');
    await adapters.tcp.disconnectClient(client.id); return null;
  }
  if (action === 'ble.discover') {
    if (!ble?.connectedDeviceId) throw new Error('BLE channel is not connected');
    return adapters.ble.discoverServices(ble.connectedDeviceId, id);
  }
  const target = () => {
    if (channel.type !== 'ble' || !ble?.connectedDeviceId) throw new Error('BLE channel is not connected');
    const serviceUuid = remoteText(args.serviceUuid, 'service UUID');
    const charUuid = remoteText(args.charUuid, 'characteristic UUID');
    if (!ble.gattServices.some(service => service.uuid === serviceUuid && service.characteristics.some(char => char.uuid === charUuid))) throw new Error('Characteristic does not belong to the selected device');
    return { deviceId: ble.connectedDeviceId, serviceUuid, charUuid };
  };
  if (action === 'ble.read' || action === 'ble.subscribe' || action === 'ble.unsubscribe') {
    const info = target();
    if (action === 'ble.read') return adapters.ble.readCharacteristic(info.deviceId, info.serviceUuid, info.charUuid);
    if (action === 'ble.subscribe') { await adapters.ble.subscribeNotifications(info.deviceId, info.serviceUuid, info.charUuid); useBleStore.getState().addSubscription(info.serviceUuid, info.charUuid, id); }
    else { await adapters.ble.unsubscribeNotifications(info.deviceId, info.serviceUuid, info.charUuid); useBleStore.getState().removeSubscription(info.serviceUuid, info.charUuid, id); }
    return null;
  }
  if (action !== 'channel.send') throw new Error('Remote action is not allowed');
  const data = remoteBytes(args.data);
  let send: () => Promise<unknown>;
  if (channel.type === 'serial' && connectionId) send = () => invoke('send_serial_data', { connectionId, data });
  else if (channel.type === 'ble') { const info = target(); send = () => invoke('write_ble_characteristic', { ...info, data }); }
  else if (channel.type === 'tcp' && tcp.mode === 'client' && tcpConnection) send = () => invoke('tcp_send', { connectionId: tcpConnection.id, data });
  else if (channel.type === 'tcp' && tcp.mode === 'server') {
    const client = context.clients.find(client => client.id === args.clientId);
    if (!client) throw new Error('Select a connected TCP client');
    send = () => invoke('tcp_server_send', { clientId: client.id, data });
  } else if (channel.type === 'tcp' && tcp.mode === 'udp' && tcpStore.udpBound && tcpStore.connectionMap[`udp:${tcpStore.udpAddr}`] === id) {
    const addr = remoteText(args.target ?? tcp.udpTargetAddress, 'UDP target');
    send = () => invoke('udp_send', { addr, data });
  } else throw new Error('Channel is not connected');
  useTerminalStore.getState().appendEntryToChannel(id, 'tx', `TX(HEX): ${data.map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`, undefined, data);
  try { await send(); }
  catch (error) {
    useTerminalStore.getState().appendEntryToChannel(id, 'system', `Remote send failed: ${String(error)}`);
    throw error;
  }
  return null;
}
