import { enqueueCanvasIngest as queueCanvasIngest } from '../../lib/canvasIngestQueue';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createEventSubscriptions } from './eventSubscriptions';
import { invoke } from '@tauri-apps/api/core';
import { useChannelStore, useUIStore, useProtocolStore, useBleStore, useSerialStore, useTcpStore, useCanvasStore } from '../../stores';
import { TerminalIcon } from '../common/Icons';
import { BlePanel } from '../channels/ble';
import { UartPanel } from '../channels/uart';
import { TcpPanel } from '../channels/tcp';
import { buildCanvasRow } from '../display/canvasDataUtils';
import { ingestPacket } from '../display/chartRuntime';
import { ingestScriptPacket } from '../display/scriptRuntime';
import { hasCanvasLifecycleScript, ingestCanvasLifecyclePacket } from '../display/canvasLifecycleRuntime';
import { useTerminalStore } from '../../stores/terminalStore';
import { PaneTreeRenderer } from './PaneTreeRenderer';
import { toHex } from './terminalUtils';
import {
  activityMatchesActiveChannel,
  channelActivitySourceLabel,
  registerChannelConnection,
  shouldDisplayChannelActivity,
  unregisterChannelConnection,
} from '../../lib';
import type {
  Channel,
  ChannelActivityEvent,
  ParsedField,
  ParseResult,
} from '../../types';
import { reportProtocolParseError, reportProtocolParseResult } from '../display/protocolParseDiagnostics';

async function parseLuaFile(
  protocolFile: string,
  protocolResourceRoot: string | undefined,
  channelId: string,
  data: number[],
): Promise<ParsedField[]> {
  try {
    const result = await invoke<ParseResult>('parse_data_with_lua_file', {
      filePath: protocolFile,
      resourceRoot: protocolResourceRoot,
      data,
    });
    reportProtocolParseResult(channelId, protocolFile, result);
    return result.fields;
  } catch (error) {
    reportProtocolParseError(channelId, protocolFile, error);
    throw error;
  }
}

// Per-canvas bounded ingest queues: Lua parsing is async and packets would
// otherwise race each other, landing rows out of receive order. A single pump
// drains each queue in order; when data outruns parse throughput the oldest
// packets are dropped so the display stays current instead of lagging.
interface CanvasIngestJob {
  columns: Parameters<typeof buildCanvasRow>[0];
  data: number[];
  timestamp: number;
  channelId: string;
  channelName: string;
  protocolFile?: string;
  protocolResourceRoot?: string;
}

function enqueueCanvasIngest(canvasId: string, job: CanvasIngestJob): void {
  const config = useCanvasStore.getState().canvases.find(c => c.id === canvasId)?.config;
  if (!config) return;
  queueCanvasIngest(canvasId, async () => {
    const parsedFields = job.protocolFile
      ? await parseLuaFile(job.protocolFile, job.protocolResourceRoot, job.channelId, job.data)
      : undefined;
    const row = buildCanvasRow(job.columns, job.data, job.timestamp, job.channelId, job.channelName, parsedFields);
    return () => {
      const current = useCanvasStore.getState().canvases.find(c => c.id === canvasId);
      if (current?.active && current.config === config) useCanvasStore.getState().pushRow(canvasId, row);
    };
  });
}

function pushDataToCanvases(channelId: string, data: number[], serviceUuid?: string, charUuid?: string) {
  const canvasState = useCanvasStore.getState();
  const channelInfo = useChannelStore.getState().channels.find(c => c.id === channelId);
  const channelName = channelInfo?.name ?? channelId;
  const now = Date.now();

  for (const canvas of canvasState.canvases) {
    if (!canvas.active) continue;
    const link = canvas.config.channels.find((l) => l.channelId === channelId);
    if (!link) continue;

    if (channelInfo?.type === 'ble' && link.bleTarget && (serviceUuid || charUuid)) {
      if (link.bleTarget.serviceUuid !== serviceUuid || link.bleTarget.charUuid !== charUuid) {
        continue;
      }
    }

    const isParsed = canvas.config.dataSource === 'parsed' && !!link.protocolFile;

    if (canvas.config.type === 'chart') {
      ingestPacket(
        canvas.id,
        channelId,
        data,
        now,
        isParsed ? link.protocolFile! : undefined,
        isParsed ? link.protocolResourceRoot ?? undefined : undefined,
      );
      continue;
    }

    if (canvas.config.type === 'form') {
      const formRows = canvas.config.form?.rows ?? [];
      const columns = formRows.map((r) => ({ ...r.column, parsedFieldId: r.parsedFieldId }));
      if (columns.length === 0) continue;
      enqueueCanvasIngest(canvas.id, {
        columns,
        data,
        timestamp: now,
        channelId,
        channelName,
        protocolFile: isParsed ? link.protocolFile! : undefined,
        protocolResourceRoot: isParsed ? link.protocolResourceRoot ?? undefined : undefined,
      });
      continue;
    }
    const columns = canvas.config.table?.columns ?? [];
    if (columns.length === 0) continue;
    enqueueCanvasIngest(canvas.id, {
      columns,
      data,
      timestamp: now,
      channelId,
      channelName,
      protocolFile: isParsed ? link.protocolFile! : undefined,
      protocolResourceRoot: isParsed ? link.protocolResourceRoot ?? undefined : undefined,
    });
  }
}

function appendTerminalRx(
  channelId: string | null,
  text: string,
  data: number[],
  bleMetadata?: { serviceUuid: string; charUuid: string },
  timestamp?: number,
  sourceLabel?: string,
) {
  const terminal = useTerminalStore.getState();
  if (channelId) {
    terminal.appendEntryToChannel(channelId, 'rx', text, timestamp, data, bleMetadata, sourceLabel);
  } else {
    terminal.appendEntryToTerminal('rx', text, timestamp, data, bleMetadata, sourceLabel);
  }
}

function appendTerminalSystem(
  channelId: string | null,
  text: string,
  timestamp?: number,
  sourceLabel?: string,
) {
  const terminal = useTerminalStore.getState();
  if (channelId) {
    terminal.appendEntryToChannel(channelId, 'system', text, timestamp, undefined, undefined, sourceLabel);
  } else {
    terminal.appendEntryToTerminal('system', text, timestamp, undefined, undefined, sourceLabel);
  }
}

function channelLabel(channelId: string, fallback: string): string {
  const channel = useChannelStore.getState().channels.find(item => item.id === channelId);
  return channel ? `${channel.name} · ${fallback}` : fallback;
}

function mappedActivityChannelId(activity: ChannelActivityEvent): string | null {
  if (activity.transport === 'ble' && activity.endpoint?.deviceId) {
    return useBleStore.getState().getChannelIdForDevice(activity.endpoint.deviceId);
  }
  if (activity.connectionId) {
    if (activity.transport === 'serial') {
      return useSerialStore.getState().connectionMap[activity.connectionId] ?? null;
    }
    if (activity.transport !== 'ble') {
      return useTcpStore.getState().connectionMap[activity.connectionId] ?? null;
    }
  }
  return null;
}

function exactActiveActivityChannelId(activity: ChannelActivityEvent): string | null {
  const channelState = useChannelStore.getState();
  const activeChannel = channelState.channels.find(channel => channel.id === channelState.activeChannelId);
  if (!activeChannel) return null;
  const bleState = useBleStore.getState();
  const serialState = useSerialStore.getState();
  const tcpState = useTcpStore.getState();
  const bleChannelState = bleState.channelStates[activeChannel.id];
  const matched = activityMatchesActiveChannel(activity, {
    activeChannel,
    bleDeviceIds: [
      bleChannelState?.connectedDeviceId,
      bleState.lastConnectedDeviceIds[activeChannel.id],
      bleState.lastConnectedDevices[activeChannel.id]?.id,
    ].filter((value): value is string => !!value),
    serialPath: serialState.channelConfigs[activeChannel.id]?.path,
    tcpConfig: tcpState.channelConfigs[activeChannel.id],
  });
  return matched ? activeChannel.id : null;
}

function syncActivityConnection(activity: ChannelActivityEvent, channelId: string): void {
  const channel = useChannelStore.getState().channels.find(item => item.id === channelId);
  if (!channel) return;

  if (activity.kind === 'connected') {
    useChannelStore.getState().updateChannelState(channelId, 'connected');
    if (activity.transport === 'ble' && activity.endpoint?.deviceId) {
      useBleStore.getState().setConnectedDeviceId(activity.endpoint.deviceId, channelId);
      registerChannelConnection(channelId, 'ble', activity.endpoint.deviceId);
    } else if (activity.transport === 'serial' && activity.connectionId) {
      const serial = useSerialStore.getState();
      if (!serial.openConnections.includes(activity.connectionId)) {
        serial.addConnection(activity.connectionId, channelId);
      }
      registerChannelConnection(channelId, 'serial', activity.connectionId);
    } else if (channel.type === 'tcp' && activity.connectionId) {
      const tcp = useTcpStore.getState();
      if (activity.transport === 'tcp-client') {
        if (!tcp.clientConnections.some(item => item.id === activity.connectionId)) {
          tcp.addClientConnection({
            id: activity.connectionId,
            addr: activity.endpoint?.address ?? activity.connectionId,
          }, channelId);
        }
        registerChannelConnection(channelId, 'tcp-client', activity.connectionId);
      } else if (activity.transport === 'tcp-server') {
        tcp.setServerListening(true, activity.endpoint?.localAddress);
        tcp.setConnectionChannel(activity.connectionId, channelId);
        registerChannelConnection(channelId, 'tcp-server', activity.connectionId);
      } else if (activity.transport === 'udp') {
        tcp.setUdpBound(true, activity.endpoint?.localAddress);
        tcp.setConnectionChannel(activity.connectionId, channelId);
        registerChannelConnection(
          channelId,
          'udp',
          activity.connectionId,
          tcp.channelConfigs[channelId]?.udpTargetAddress,
        );
      }
    }
    syncCanvasesForChannel({ ...channel, state: 'connected' });
    return;
  }

  if (activity.kind !== 'disconnected') return;
  useChannelStore.getState().updateChannelState(channelId, 'disconnected');
  unregisterChannelConnection(channelId);
  if (activity.transport === 'ble') {
    useBleStore.getState().clearChannelConnection(channelId);
  } else if (activity.transport === 'serial' && activity.connectionId) {
    useSerialStore.getState().removeConnection(activity.connectionId);
  } else if (activity.transport === 'tcp-client' && activity.connectionId) {
    useTcpStore.getState().removeClientConnection(activity.connectionId);
  } else if (activity.transport === 'tcp-server') {
    useTcpStore.getState().setServerListening(false);
  } else if (activity.transport === 'udp') {
    useTcpStore.getState().setUdpBound(false);
  }
  syncCanvasesForChannel({ ...channel, state: 'disconnected' });
}

function syncCanvasesForChannel(channel: Channel): void {
  const canvasStore = useCanvasStore.getState();
  const relevantCanvases = canvasStore.canvases.filter((canvas) =>
    canvas.config.channels.some((link) => link.channelId === channel.id)
  );

  for (const canvas of relevantCanvases) {
    const selectedLink = canvas.config.channels.find((link) => link.channelId === channel.id)
      ?? canvas.config.channels[0];
    if (!selectedLink) continue;

    if (channel.type === 'ble' && selectedLink.bleTarget) {
      const bleState = useBleStore.getState();
      const channelState = bleState.getChannelState(channel.id);
      const channelReady =
        channel.state === 'connected'
        && bleState.connectedChannelId === channel.id
        && channelState.subscribedCharacteristics.some(
          (item) => item.serviceUuid === selectedLink.bleTarget!.serviceUuid && item.charUuid === selectedLink.bleTarget!.charUuid
        );
      canvasStore.syncCanvasChannelState(canvas.id, channelReady);
      continue;
    }

    canvasStore.syncCanvasChannelState(canvas.id, channel.state === 'connected');
  }
}

export const CenterPanel: React.FC = () => {
  const { channels, activeChannelId } = useChannelStore();
  const activeChannel = channels.find(c => c.id === activeChannelId);
  const {
    centerSplitRatio,
    setCenterSplitRatio,
    showReceived,
    centerTopVisible,
    centerBottomVisible,
  } = useUIStore();
  const { setLinkedChannel } = useProtocolStore();

  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      setCenterSplitRatio(Math.max(0.15, Math.min(0.85, ratio)));
    };
    const handleMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, setCenterSplitRatio]);

  const showReceivedRef = useRef(showReceived);
  useEffect(() => {
    showReceivedRef.current = showReceived;
  }, [showReceived]);

  useEffect(() => {
    return useTerminalStore.subscribe(state => {
      const focusedPane = state.focusedPaneId ? state.panes[state.focusedPaneId] : null;
      const activeTab = focusedPane?.tabs.find(t => t.id === focusedPane.activeTabId);
      const channelId = activeTab?.channelId ?? null;
      setLinkedChannel(channelId);
    });
  }, [setLinkedChannel]);

  useEffect(() => {
    for (const channel of channels) {
      syncCanvasesForChannel(channel);
    }
  }, [channels]);

  useEffect(() => {
    const events = createEventSubscriptions();

    events.listen('serial-connection-error', (event) => {
      const { connectionId, error } = event.payload;
      const channelId = useSerialStore.getState().connectionMap[connectionId];
      appendTerminalSystem(
        channelId ?? null,
        `Connection error: ${error}`,
        undefined,
        channelId ? channelLabel(channelId, 'SERIAL') : `SERIAL · ${connectionId}`,
      );
    });

    events.listen('serial-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const { connectionMap } = useSerialStore.getState();

      // Push to canvases (always, regardless of showReceived toggle)
      const serialChannelId = connectionMap[connectionId];
      if (serialChannelId) {
        pushDataToCanvases(serialChannelId, data);
        for (const canvas of useCanvasStore.getState().canvases) {
          if (canvas.config.type === 'script') {
            ingestScriptPacket(canvas.id, { channelId: serialChannelId, data, timestamp: Date.now(), source: 'serial', connectionId });
          } else if (hasCanvasLifecycleScript(canvas)) {
            ingestCanvasLifecyclePacket(canvas.id, { channelId: serialChannelId, data, timestamp: Date.now(), source: 'serial', connectionId });
          }
        }
      }

      const hex = toHex(data);
      const text = `RX: ${hex}`;
      const routeChannelId = showReceivedRef.current ? (serialChannelId ?? null) : null;
      appendTerminalRx(
        routeChannelId,
        text,
        data,
        undefined,
        timestamp,
        serialChannelId ? channelLabel(serialChannelId, 'SERIAL') : `SERIAL · ${connectionId}`,
      );
    });

    events.listen('serial-connection-closed', (event) => {
      const { connectionId } = event.payload;
      const { connectionMap } = useSerialStore.getState();
      const channelId = connectionMap[connectionId];
      if (channelId) {
        useChannelStore.getState().updateChannelState(channelId, 'disconnected');
        unregisterChannelConnection(channelId);
        const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
        if (channel) {
          syncCanvasesForChannel({ ...channel, state: 'disconnected' });
        }
      }
      useSerialStore.getState().removeConnection(connectionId);
    });

    return events.dispose;
  }, []);

  useEffect(() => {
    const events = createEventSubscriptions();

    events.listen('tcp-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const tcpState = useTcpStore.getState();

      // Push to canvases
      const tcpChannelId = tcpState.connectionMap[connectionId];
      if (tcpChannelId) {
        pushDataToCanvases(tcpChannelId, data);
        for (const canvas of useCanvasStore.getState().canvases) {
          if (canvas.config.type === 'script') {
            ingestScriptPacket(canvas.id, { channelId: tcpChannelId, data, timestamp: Date.now(), source: 'tcp', connectionId });
          } else if (hasCanvasLifecycleScript(canvas)) {
            ingestCanvasLifecyclePacket(canvas.id, { channelId: tcpChannelId, data, timestamp: Date.now(), source: 'tcp', connectionId });
          }
        }
      }

      const hex = toHex(data);
      const text = `RX: ${hex}`;
      appendTerminalRx(
        showReceivedRef.current ? (tcpChannelId ?? null) : null,
        text,
        data,
        undefined,
        timestamp,
        tcpChannelId ? channelLabel(tcpChannelId, 'TCP') : `TCP · ${connectionId}`,
      );
    });

    events.listen('tcp-client-connected', (event) => {
      const { id, addr } = event.payload;
      const tcpState = useTcpStore.getState();
      const serverChannelId = tcpState.serverAddr
        ? tcpState.connectionMap[`server:${tcpState.serverAddr}`]
        : undefined;

      tcpState.addServerClient({ id, addr });

      if (serverChannelId) tcpState.setConnectionChannel(id, serverChannelId);
      appendTerminalSystem(
        serverChannelId ?? null,
        `Client connected: ${addr}`,
        undefined,
        serverChannelId ? channelLabel(serverChannelId, 'TCP SERVER') : `TCP SERVER · ${addr}`,
      );
    });

    events.listen('tcp-client-disconnected', (event) => {
      const { id, addr } = event.payload;
      const tcpState = useTcpStore.getState();
      const channelId = tcpState.connectionMap[id];

      tcpState.removeServerClient(id);
      tcpState.removeConnectionMapping(id);

      appendTerminalSystem(
        channelId ?? null,
        `Client disconnected: ${addr}`,
        undefined,
        channelId ? channelLabel(channelId, 'TCP SERVER') : `TCP SERVER · ${addr}`,
      );
    });

    events.listen('udp-data-received', (event) => {
      const { localAddr, remoteAddr, data, timestamp } = event.payload;

      // Push to canvases
      const udpChannelId = useTcpStore.getState().connectionMap['udp:' + localAddr];
      if (udpChannelId) {
        pushDataToCanvases(udpChannelId, data);
        for (const canvas of useCanvasStore.getState().canvases) {
          if (canvas.config.type === 'script') {
            ingestScriptPacket(canvas.id, { channelId: udpChannelId, data, timestamp: Date.now(), source: 'udp', localAddr, remoteAddr });
          } else if (hasCanvasLifecycleScript(canvas)) {
            ingestCanvasLifecyclePacket(canvas.id, { channelId: udpChannelId, data, timestamp: Date.now(), source: 'udp', localAddr, remoteAddr });
          }
        }
      }

      const hex = toHex(data);
      const prefix = `[${remoteAddr}]`;
      const text = `${prefix} RX: ${hex}`;
      appendTerminalRx(
        showReceivedRef.current ? (udpChannelId ?? null) : null,
        text,
        data,
        undefined,
        timestamp,
        udpChannelId ? channelLabel(udpChannelId, 'UDP') : `UDP · ${localAddr}`,
      );
    });

    events.listen('tcp-connection-error', (event) => {
      const { connectionId, error } = event.payload;
      // "Client disconnected" already gets its own line from the dedicated
      // tcp-client-disconnected handler; only surface real error details.
      if (error === 'Client disconnected') return;
      const channelId = useTcpStore.getState().connectionMap[connectionId];
      appendTerminalSystem(
        channelId ?? null,
        `Connection error: ${error}`,
        undefined,
        channelId ? channelLabel(channelId, 'TCP') : `TCP · ${connectionId}`,
      );
    });

    events.listen('tcp-connection-closed', (event) => {
      const { connectionId } = event.payload;
      const { connectionMap } = useTcpStore.getState();
      const channelId = connectionMap[connectionId];
      if (channelId) {
        useChannelStore.getState().updateChannelState(channelId, 'disconnected');
        unregisterChannelConnection(channelId);
        const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
        if (channel) {
          syncCanvasesForChannel({ ...channel, state: 'disconnected' });
        }
      }
      useTcpStore.getState().removeClientConnection(connectionId);
    });

    return events.dispose;
  }, []);

  useEffect(() => {
    const events = createEventSubscriptions();

    events.listen('ble-notification-received', (event) => {
      const { deviceId, serviceUuid, charUuid, data, timestamp } = event.payload;
      const bleState = useBleStore.getState();
      const bleChannelId = bleState.getChannelIdForDevice(deviceId);
      const subs = bleChannelId
        ? (bleState.channelStates[bleChannelId]?.subscribedCharacteristics ?? [])
        : [];
      const isSubscribed = subs.some(s => s.serviceUuid === serviceUuid && s.charUuid === charUuid);

      // Push to canvases
      if (bleChannelId && isSubscribed) {
        pushDataToCanvases(bleChannelId, data, serviceUuid, charUuid);
        for (const canvas of useCanvasStore.getState().canvases) {
          if (canvas.config.type === 'script') {
            ingestScriptPacket(canvas.id, {
              channelId: bleChannelId,
              data,
              timestamp: Date.now(),
              source: 'ble',
              deviceId,
              serviceUuid,
              charUuid,
            });
          } else if (hasCanvasLifecycleScript(canvas)) {
            ingestCanvasLifecyclePacket(canvas.id, {
              channelId: bleChannelId,
              data,
              timestamp: Date.now(),
              source: 'ble',
              deviceId,
              serviceUuid,
              charUuid,
            });
          }
        }
      }

      const hex = toHex(data);
      appendTerminalRx(
        showReceivedRef.current ? (bleChannelId ?? null) : null,
        `RX: ${hex}`,
        data,
        { serviceUuid, charUuid },
        timestamp,
        bleChannelId ? channelLabel(bleChannelId, `BLE · ${deviceId}`) : `BLE · ${deviceId}`,
      );
    });

    events.listen('ble-connection-closed', (event) => {
      const { deviceId } = event.payload;
      const bleStore = useBleStore.getState();
      const connectedChannelId = bleStore.getChannelIdForDevice(deviceId);
      if (connectedChannelId) {
        useChannelStore.getState().updateChannelState(connectedChannelId, 'disconnected');
        unregisterChannelConnection(connectedChannelId);
        const channel = useChannelStore.getState().channels.find((item) => item.id === connectedChannelId);
        if (channel) {
          syncCanvasesForChannel({ ...channel, state: 'disconnected' });
        }
        bleStore.clearChannelConnection(connectedChannelId);
      }
    });

    return events.dispose;
  }, []);

  useEffect(() => {
    const events = createEventSubscriptions();

    events.listen('channel-activity', (event) => {
      const activity = event.payload;
      const sourceLabel = channelActivitySourceLabel(activity);
      const activeChannelId = useChannelStore.getState().activeChannelId;
      const mappedChannelId = mappedActivityChannelId(activity);
      const channelId = mappedChannelId && mappedChannelId === activeChannelId
        ? mappedChannelId
        : exactActiveActivityChannelId(activity);

      if (channelId && (activity.kind === 'connected' || activity.kind === 'disconnected')) {
        syncActivityConnection(activity, channelId);
      }
      if (!shouldDisplayChannelActivity(activity)) return;

      const endpoint = activity.endpoint;
      const bleMetadata = endpoint?.serviceUuid && endpoint.charUuid
        ? { serviceUuid: endpoint.serviceUuid, charUuid: endpoint.charUuid }
        : undefined;
      if ((activity.kind === 'tx' || activity.kind === 'rx') && activity.data) {
        const kind = activity.kind;
        const text = `${kind.toUpperCase()}: ${toHex(activity.data)}`;
        const terminal = useTerminalStore.getState();
        if (channelId) {
          terminal.appendEntryToChannel(
            channelId,
            kind,
            text,
            activity.timestamp,
            activity.data,
            bleMetadata,
            sourceLabel,
          );
        } else {
          terminal.appendEntryToTerminal(
            kind,
            text,
            activity.timestamp,
            activity.data,
            bleMetadata,
            sourceLabel,
          );
        }
        return;
      }

      let detail = activity.text ?? activity.kind;
      if (activity.protocol) {
        try {
          detail = `${detail}\n${JSON.stringify(activity.protocol, null, 2)}`;
        } catch {
          detail = `${detail}\n[protocol detail could not be serialized]`;
        }
      }
      appendTerminalSystem(channelId, detail, activity.timestamp, sourceLabel);
    });

    return events.dispose;
  }, []);

  useEffect(() => {
    const events = createEventSubscriptions();
    events.listen('detached-terminal-entry', (event) => {
      const entry = event.payload;
      useTerminalStore.getState().appendEntryToChannel(
        entry.channelId,
        entry.kind,
        entry.text,
        entry.timestamp,
        entry.data,
        entry.bleMetadata,
        `${entry.channelName} · ${entry.channelType.toUpperCase()} · DETACHED`,
      );
    });
    return events.dispose;
  }, []);

  const root = useTerminalStore(s => s.root);
  const showTop = centerTopVisible;
  const showBottom = centerBottomVisible;

  const topPanelContent = !activeChannel ? (
    <div className="flex-1 flex flex-col items-center justify-center">
      <div className="empty-state text-text-muted">
        <TerminalIcon size={48} className="opacity-20 mb-4" />
        <p>Select a channel to configure</p>
      </div>
    </div>
  ) : (
    <div className="animate-fade-in w-full h-full flex flex-col items-stretch overflow-hidden">
      {activeChannel.type === 'ble' && <BlePanel channelId={activeChannel.id} />}
      {activeChannel.type === 'serial' && <UartPanel channelId={activeChannel.id} />}
      {activeChannel.type === 'tcp' && <TcpPanel channelId={activeChannel.id} />}
    </div>
  );

  return (
    <div ref={containerRef} className="relative h-full bg-surface overflow-hidden">
      {showTop && (
        <div
          className={`${showBottom ? 'absolute top-0 left-0 right-0' : 'h-full'} overflow-hidden p-3 flex flex-col`}
          style={showBottom ? { bottom: `calc(${(1 - centerSplitRatio) * 100}% - 18px)` } : undefined}
        >
          {topPanelContent}
        </div>
      )}

      {showBottom && (
        <div
          className={`${showTop ? 'absolute left-0 right-0 bottom-0 pt-px' : 'h-full'} flex flex-col bg-surface`}
          style={showTop ? { height: `${(1 - centerSplitRatio) * 100}%` } : undefined}
        >
          {showTop && (
            <div
              className="relative h-0 cursor-row-resize shrink-0 group"
              onMouseDown={handleMouseDown}
            >
              <div className={`absolute inset-x-0 -top-px h-px origin-bottom scale-y-50 transition-colors ${isDragging ? 'bg-accent-mauve/50' : 'bg-[var(--divider-default)] group-hover:bg-[var(--layer-active)]'}`} />
              <div className="absolute inset-x-0 -top-2 h-4" />
            </div>
          )}

          <div className="flex flex-row flex-1 min-h-0">
            <PaneTreeRenderer node={root} />
          </div>
        </div>
      )}

      {!showTop && !showBottom && (
        <div className="h-full flex items-center justify-center text-text-muted text-sm">
          Center panels hidden
        </div>
      )}
    </div>
  );
};
