import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChannelStore, useBleStore, useSerialStore, useTcpStore, useUIStore } from '../../stores';
import { useTerminalStore, ChannelTab } from '../../stores/terminalStore';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, DockIcon, BluetoothIcon, UsbIcon, WifiIcon } from '../common/Icons';
import type { DetachPayload, ReattachPayload, TerminalSettingsChangedPayload } from '../../lib/detachWindow';
import {
  channelActivitySourceLabel,
  shouldDisplayChannelActivity,
} from '../../lib/channelActivity';
import type { DetachedTerminalEntryEvent } from '../../types';
import { sendWithImmediateTxEcho } from '../../lib/terminalSend';
import { createEventSubscriptions } from './eventSubscriptions';
import { TerminalContextMenu } from './TerminalContextMenu';
import { formatInputTimestamp, formatTerminalEntryParts, formatTerminalEntryText, toHex } from './terminalUtils';

function channelIcon(type: string) {
  if (type === 'ble') return <BluetoothIcon size={12} />;
  if (type === 'serial') return <UsbIcon size={12} />;
  return <WifiIcon size={12} />;
}

function channelIconStateClass(type: string, state: string) {
  if (state === 'connecting') return 'text-accent-yellow animate-pulse';
  if (state === 'error') return 'text-accent-red';
  if (state !== 'connected') return 'text-text-faint';

  if (type === 'ble') return 'text-accent-blue';
  if (type === 'serial') return 'text-accent-mauve';
  return 'text-accent-green';
}

/**
 * Lightweight shell for a detached terminal window.
 * Renders a simplified title bar + single terminal pane.
 * Receives initial state via Tauri 'detach-init' event.
 */
export const DetachedTerminalWindow: React.FC = () => {
  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);
  const [ready, setReady] = useState(false);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Get terminal store state
  const focusedPaneId = useTerminalStore(s => s.focusedPaneId);
  const pane = useTerminalStore(s => focusedPaneId ? s.panes[focusedPaneId] : null);
  const activeTab = pane?.tabs.find(t => t.id === pane.activeTabId);
  const { channels } = useChannelStore();
  const linkedChannel = channels.find(c => c.id === (activeTab?.channelId ?? null));

  // Subscribe to receive initial state
  useEffect(() => {
    let cancelled = false;

    let gotInit = false;

    const setup = async () => {
      const unlisten = await listen<DetachPayload>('detach-init', (event) => {
        if (cancelled) return;
        gotInit = true;
        const { tab, entries, terminalSettings: initialTerminalSettings } = event.payload;

        // Build a single-pane terminal store from the received tab
        const paneId = crypto.randomUUID();
        const newTab: ChannelTab = {
          id: crypto.randomUUID(),
          channelId: tab.channelId,
          label: tab.label,
          isPinned: false,
        };

        useTerminalStore.setState({
          root: { type: 'leaf', paneId },
          panes: {
            [paneId]: {
              tabs: [newTab],
              activeTabId: newTab.id,
              showCommandsPanel: false,
              entries: entries ?? [],
              tabEntries: { [newTab.id]: entries ?? [] },
              tabWriteTargets: { [newTab.id]: null },
              cmdInput: '',
              cmdHistory: [],
              historyIndex: -1,
              autoScroll: true,
              selectedWriteTarget: null,
              selectMode: false,
              selectOptions: [],
              udpTargetAddr: null,
              selectedTcpClientId: null,
            },
          },
          focusedPaneId: paneId,
        });
        useUIStore.getState().setTerminalChannelSettings(
          tab.channelId ?? '__terminal__',
          initialTerminalSettings,
        );

        setReady(true);
      });

      // Announce readiness repeatedly until the parent delivers 'detach-init'.
      // The listener above is now live, so the parent can respond immediately;
      // retrying covers any mount-timing ordering against the parent's handler.
      void (async () => {
        for (let i = 0; i < 30 && !gotInit && !cancelled; i++) {
          await emit('detach-ready', appWindow.label);
          await new Promise(r => setTimeout(r, 150));
        }
      })();

      return unlisten;
    };

    const unlistenPromise = setup();
    return () => {
      cancelled = true;
      unlistenPromise.then(fn => fn());
    };
  }, []);

  // Window maximize state tracking
  useEffect(() => {
    const sync = async () => {
      try { setIsMaximized(await appWindow.isMaximized()); } catch { /* noop */ }
    };
    sync();

    const unlistenPromise = appWindow.onResized(async () => {
      try { setIsMaximized(await appWindow.isMaximized()); } catch { /* noop */ }
    });

    return () => { unlistenPromise.then(fn => fn()); };
  }, [appWindow]);

  const handleMinimize = useCallback(() => { appWindow.minimize(); }, [appWindow]);
  const handleMaximize = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    appWindow.toggleMaximize();
  }, [appWindow]);
  const handleClose = useCallback(() => { appWindow.close(); }, [appWindow]);

  const handleDockToMain = useCallback(async () => {
    if (!focusedPaneId) return;
    const currentPane = useTerminalStore.getState().panes[focusedPaneId];
    if (!currentPane) return;
    const tab = currentPane.tabs.find(t => t.id === currentPane.activeTabId);
    if (!tab) return;

    const ch = channels.find(c => c.id === tab.channelId);
    const entries = currentPane.tabEntries[tab.id] ?? currentPane.entries ?? [];
    const ui = useUIStore.getState();
    const currentTerminalSettings = ui.terminalChannelSettings[tab.channelId ?? '__terminal__'] ?? {
      sendFormat: ui.sendFormat,
      receiveFormat: ui.receiveFormat,
      showInputPrefix: ui.showInputPrefix,
      showTimestamp: ui.showTimestamp,
    };

    const payload: ReattachPayload = {
      tab: { id: tab.id, channelId: tab.channelId, label: tab.label, isPinned: false },
      entries,
      channelType: ch?.type,
      terminalSettings: currentTerminalSettings,
    };

    try {
      await emitTo('main', 'reattach-tab', payload);
      // Close the detached window after successful reattach
      appWindow.close();
    } catch {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'Failed to dock tab back to main window');
    }
  }, [focusedPaneId, channels, appWindow]);

  // ─── Terminal logic (simplified from TerminalLeafPane) ─────────────
  const {
    sendFormat,
    receiveFormat,
    showTimestamp,
    showInputPrefix,
    showReceived,
    setShowReceived,
    terminalChannelSettings,
    setTerminalChannelSettings,
  } = useUIStore();
  const terminalSettingsKey = activeTab?.channelId ?? '__terminal__';
  const terminalSettings = terminalChannelSettings[terminalSettingsKey] ?? {
    sendFormat,
    receiveFormat,
    showInputPrefix,
    showTimestamp,
  };
  const updateTerminalSettings = useCallback((changes: Partial<typeof terminalSettings>) => {
    const nextSettings = { ...terminalSettings, ...changes };
    setTerminalChannelSettings(terminalSettingsKey, nextSettings);
    void emit('terminal-channel-settings-changed', {
      channelId: activeTab?.channelId ?? null,
      settings: nextSettings,
    });
  }, [activeTab?.channelId, setTerminalChannelSettings, terminalSettings, terminalSettingsKey]);

  useEffect(() => {
    const unlistenPromise = listen<TerminalSettingsChangedPayload>(
      'terminal-channel-settings-changed',
      (event) => {
        const eventKey = event.payload.channelId ?? '__terminal__';
        if (eventKey !== terminalSettingsKey) return;
        useUIStore.getState().setTerminalChannelSettings(eventKey, event.payload.settings);
      },
    );

    return () => { unlistenPromise.then(fn => fn()); };
  }, [terminalSettingsKey]);
  const { channelStates } = useBleStore();
  const connectedDeviceId = linkedChannel?.type === 'ble'
    ? (channelStates[linkedChannel.id]?.connectedDeviceId ?? null)
    : null;

  const receiveRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyIndexRef = useRef(-1);
  const showReceivedRef = useRef(showReceived);
  const [inputTimestamp, setInputTimestamp] = useState(() => formatInputTimestamp(Date.now()));

  useEffect(() => {
    showReceivedRef.current = showReceived;
  }, [showReceived]);
  useEffect(() => {
    if (!terminalSettings.showTimestamp) return;
    const updateTimestamp = () => setInputTimestamp(formatInputTimestamp(Date.now()));
    updateTimestamp();
    const intervalId = window.setInterval(updateTimestamp, 1000);
    return () => window.clearInterval(intervalId);
  }, [terminalSettings.showTimestamp]);

  // Auto scroll
  useEffect(() => {
    if (!pane?.autoScroll || !receiveRef.current) return;
    receiveRef.current.scrollTop = receiveRef.current.scrollHeight;
  }, [pane?.entries, pane?.autoScroll]);

  const handleReceiveScroll = useCallback(() => {
    if (!receiveRef.current || !focusedPaneId) return;
    const { scrollTop, scrollHeight, clientHeight } = receiveRef.current;
    useTerminalStore.getState().setAutoScroll(focusedPaneId, scrollHeight - scrollTop - clientHeight < 40);
  }, [focusedPaneId]);

  const handleReceiveClick = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    inputRef.current?.focus();
  }, []);

  const closeTerminalContextMenu = useCallback(() => {
    setTerminalContextMenu(null);
  }, []);

  const handleReceiveContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setTerminalContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const handleClearTerminal = useCallback(() => {
    if (!focusedPaneId) return;
    useTerminalStore.getState().clearEntries(focusedPaneId);
    inputRef.current?.focus();
  }, [focusedPaneId]);

  const handleToggleReceived = useCallback(() => {
    setShowReceived(!showReceived);
    inputRef.current?.focus();
  }, [setShowReceived, showReceived]);

  // Send handler
  const handleSend = useCallback(async () => {
    if (!focusedPaneId) return;
    const currentPane = useTerminalStore.getState().panes[focusedPaneId];
    if (!currentPane) return;
    const raw = currentPane.cmdInput.trim();
    if (!raw) {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'system', ' ');
      useTerminalStore.getState().setCmdInput(focusedPaneId, '');
      return;
    }

    useTerminalStore.getState().pushCmdHistory(focusedPaneId, raw);
    useTerminalStore.getState().setCmdInput(focusedPaneId, '');

    if (raw.startsWith('/')) {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'tx', raw);
      // Simple command handling for detached window
      if (raw === '/clear') {
        useTerminalStore.getState().clearEntries(focusedPaneId);
      } else if (raw === '/help') {
        useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'Detached window — limited commands: /clear, /help');
      } else {
        useTerminalStore.getState().appendEntry(focusedPaneId, 'system', `Command not supported in detached window: ${raw}`);
      }
      return;
    }

    // Parse & send (hex / ASCII)
    let bytes: number[];
    let modeLabel: string;

    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      const content = raw.slice(1, -1);
      bytes = Array.from(new TextEncoder().encode(content));
      modeLabel = 'ASCII';
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      const content = raw.slice(1, -1);
      bytes = [...Array.from(new TextEncoder().encode(content)), 0x00];
      modeLabel = 'ASCII+NUL';
    } else {
      const clean = raw.replace(/\s/g, '');
      if (clean.length === 0 || clean.length % 2 !== 0) {
        useTerminalStore.getState().appendEntry(focusedPaneId, 'system', `Invalid hex: "${raw}"`);
        return;
      }
      bytes = [];
      for (let i = 0; i < clean.length; i += 2) {
        const val = parseInt(clean.slice(i, i + 2), 16);
        if (isNaN(val)) {
          useTerminalStore.getState().appendEntry(focusedPaneId, 'system', `Invalid hex: "${raw}"`);
          return;
        }
        bytes.push(val);
      }
      modeLabel = 'HEX';
    }

    if (!linkedChannel) {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'No channel linked');
      return;
    }

    const hexStr = bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const txLine = `TX(${modeLabel}): ${hexStr}`;
    const appendAndRelay = (
      kind: DetachedTerminalEntryEvent['kind'],
      text: string,
      data?: number[],
      bleMetadata?: DetachedTerminalEntryEvent['bleMetadata'],
    ) => {
      const timestamp = Date.now();
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        kind,
        text,
        timestamp,
        data,
        bleMetadata,
      );
      void emit('detached-terminal-entry', {
        channelId: linkedChannel.id,
        channelName: linkedChannel.name,
        channelType: linkedChannel.type,
        kind,
        timestamp,
        text,
        data,
        bleMetadata,
      } satisfies DetachedTerminalEntryEvent);
    };

    try {
      if (linkedChannel.type === 'serial') {
        const { openConnections } = useSerialStore.getState();
        if (openConnections.length === 0) {
          useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'No serial port open');
          return;
        }
        await invoke('send_serial_data', { connectionId: openConnections[0], data: bytes });
      } else if (linkedChannel.type === 'tcp') {
        const tcpState = useTcpStore.getState();
        if (tcpState.mode === 'client' && tcpState.clientConnections.length > 0) {
          await invoke('tcp_send', { connectionId: tcpState.clientConnections[0].id, data: bytes });
        } else if (tcpState.mode === 'server' && tcpState.serverClients.length > 0) {
          await invoke('tcp_server_send', { clientId: tcpState.serverClients[0].id, data: bytes });
        } else if (tcpState.mode === 'udp' && tcpState.udpBound) {
          const udpAddr = currentPane.udpTargetAddr;
          if (!udpAddr) {
            useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'No UDP target set');
            return;
          }
          await invoke('udp_send', { addr: udpAddr, data: bytes });
        } else {
          useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'No active TCP connection');
          return;
        }
      } else if (linkedChannel.type === 'ble') {
        if (!connectedDeviceId) {
          useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'BLE not connected');
          return;
        }
        const writeTarget = currentPane.selectedWriteTarget;
        if (!writeTarget) {
          useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'No write characteristic selected');
          return;
        }
        await sendWithImmediateTxEcho(
          () => appendAndRelay(
            'tx',
            txLine,
            bytes,
            { serviceUuid: writeTarget.serviceUuid, charUuid: writeTarget.charUuid },
          ),
          () => invoke('write_ble_characteristic', {
            deviceId: connectedDeviceId,
            serviceUuid: writeTarget.serviceUuid,
            charUuid: writeTarget.charUuid,
            data: bytes,
          })
        );
        return;
      }
      appendAndRelay('tx', txLine, bytes);
    } catch (error) {
      appendAndRelay('system', `Send error: ${error}`);
    }
  }, [focusedPaneId, linkedChannel, connectedDeviceId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!focusedPaneId) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      historyIndexRef.current = -1;
      handleSend();
      return;
    }
    const currentPane = useTerminalStore.getState().panes[focusedPaneId];
    const history = currentPane?.cmdHistory ?? [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIndexRef.current + 1, history.length - 1);
      historyIndexRef.current = next;
      if (next >= 0 && history[next] !== undefined) useTerminalStore.getState().setCmdInput(focusedPaneId, history[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndexRef.current - 1;
      if (next < 0) { historyIndexRef.current = -1; useTerminalStore.getState().setCmdInput(focusedPaneId, ''); return; }
      historyIndexRef.current = next;
      if (history[next] !== undefined) useTerminalStore.getState().setCmdInput(focusedPaneId, history[next]);
      return;
    }
  }, [focusedPaneId, handleSend]);

  // ─── Event listeners for incoming data (mirrors CenterPanel logic) ─
  useEffect(() => {
    if (!focusedPaneId) return;
    const events = createEventSubscriptions();

    // Serial data
    events.listen('serial-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const isMaster = !linkedChannel;
      const mappedChannelId = useSerialStore.getState().connectionMap[connectionId];
      if (!isMaster && (linkedChannel.type !== 'serial' || mappedChannelId !== linkedChannel.id)) return;
      if (!isMaster && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `SERIAL · ${connectionId}`,
      );
    });

    // TCP data
    events.listen('tcp-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const isMaster = !linkedChannel;
      const mappedChannelId = useTcpStore.getState().connectionMap[connectionId];
      if (!isMaster && (linkedChannel.type !== 'tcp' || mappedChannelId !== linkedChannel.id)) return;
      if (!isMaster && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `TCP · ${connectionId}`,
      );
    });

    // UDP data
    events.listen('udp-data-received', (event) => {
      const { localAddr, remoteAddr, data, timestamp } = event.payload;
      const isMaster = !linkedChannel;
      const mappedChannelId = useTcpStore.getState().connectionMap[`udp:${localAddr}`];
      if (!isMaster && (linkedChannel.type !== 'tcp' || mappedChannelId !== linkedChannel.id)) return;
      if (!isMaster && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `[${remoteAddr}] RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `UDP · ${localAddr}`,
      );
    });

    // BLE notifications
    events.listen('ble-notification-received', (event) => {
      const { deviceId, serviceUuid, charUuid, data, timestamp } = event.payload;
      const isMaster = !linkedChannel;
      if (!isMaster && linkedChannel.type !== 'ble') return;
      if (!isMaster && useBleStore.getState().getChannelIdForDevice(deviceId) !== linkedChannel.id) return;
      if (!isMaster && !showReceivedRef.current) return;
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${toHex(data)}`,
        timestamp,
        data,
        { serviceUuid, charUuid },
        `BLE · ${deviceId}`,
      );
    });

    events.listen('channel-activity', (event) => {
      const activity = event.payload;
      const isMaster = !linkedChannel;
      const mappedChannelId = activity.transport === 'ble' && activity.endpoint?.deviceId
        ? useBleStore.getState().getChannelIdForDevice(activity.endpoint.deviceId)
        : activity.transport === 'serial' && activity.connectionId
          ? useSerialStore.getState().connectionMap[activity.connectionId]
          : activity.connectionId
            ? useTcpStore.getState().connectionMap[activity.connectionId]
            : undefined;
      const targetsLinkedChannel = !!linkedChannel && (
        activity.channelId === linkedChannel.id || mappedChannelId === linkedChannel.id
      );
      if (!isMaster && !targetsLinkedChannel) return;
      if (!shouldDisplayChannelActivity(activity)) return;

      const sourceLabel = channelActivitySourceLabel(activity);
      const bleMetadata = activity.endpoint?.serviceUuid && activity.endpoint.charUuid
        ? { serviceUuid: activity.endpoint.serviceUuid, charUuid: activity.endpoint.charUuid }
        : undefined;
      if ((activity.kind === 'tx' || activity.kind === 'rx') && activity.data) {
        useTerminalStore.getState().appendEntry(
          focusedPaneId,
          activity.kind,
          `${activity.kind.toUpperCase()}: ${toHex(activity.data)}`,
          activity.timestamp,
          activity.data,
          bleMetadata,
          sourceLabel,
        );
        return;
      }
      let detail = activity.text ?? activity.kind;
      if (activity.protocol) detail = `${detail}\n${JSON.stringify(activity.protocol, null, 2)}`;
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'system',
        detail,
        activity.timestamp,
        undefined,
        undefined,
        sourceLabel,
      );
    });

    return events.dispose;
  }, [focusedPaneId, linkedChannel]);

  // ─── Render ────────────────────────────────────────────────────────

  const channelTone = (() => {
    switch (linkedChannel?.type) {
      case 'ble': return { prompt: 'text-accent-blue', rx: 'text-accent-blue/80', tx: 'text-accent-blue/90', caret: 'caret-accent-blue' };
      case 'serial': return { prompt: 'text-accent-mauve', rx: 'text-accent-mauve/80', tx: 'text-accent-mauve/90', caret: 'caret-accent-mauve' };
      case 'tcp': return { prompt: 'text-accent-green', rx: 'text-accent-green/80', tx: 'text-accent-green/90', caret: 'caret-accent-green' };
      default: return { prompt: 'text-text-secondary', rx: 'text-text-secondary', tx: 'text-text-primary', caret: 'caret-text-secondary' };
    }
  })();

  const promptText = linkedChannel ? `${linkedChannel.name}>` : '>';
  const visiblePrompt = terminalSettings.showInputPrefix ? promptText : '>';

  const renderEntry = (entry: { kind: 'rx' | 'tx' | 'system'; timestamp: number; text: string; data?: number[]; bleMetadata?: { serviceUuid: string; charUuid: string }; sourceLabel?: string }): React.ReactNode => {
    const options = {
      promptText,
      showTimestamp: terminalSettings.showTimestamp,
      showInputPrefix: terminalSettings.showInputPrefix,
      sendFormat: terminalSettings.sendFormat,
      receiveFormat: terminalSettings.receiveFormat,
      aggregate: activeTab?.channelId === null,
    };
    const parts = formatTerminalEntryParts(entry, options);
    if (!parts) {
      return <span className="text-text-muted italic">{formatTerminalEntryText(entry, options)}</span>;
    }
    const payloadClass = entry.kind === 'rx' ? channelTone.rx : channelTone.tx;
    if (parts.metadata) {
      return (
        <>
          <span className="text-text-muted">{parts.leadingText}</span>
          <span className="font-semibold text-text-secondary">{parts.marker}</span>
          <span className="text-text-secondary">{` ${parts.metadata}`}</span>
          {'\n'}
          <span className="text-text-muted">{parts.continuationIndent}</span>
          <span className={payloadClass}>{parts.payload}</span>
        </>
      );
    }
    return (
      <>
        <span className="text-text-muted">{parts.leadingText}</span>
        <span className="font-semibold text-text-secondary">{parts.marker}</span>
        <span className={payloadClass}>{` ${parts.payload}`}</span>
      </>
    );
  };
  const inputPromptBase = visiblePrompt.endsWith('>')
    ? visiblePrompt.slice(0, -1)
    : visiblePrompt;

  const tabLabel = activeTab?.label || 'Terminal';

  return (
    <div className="w-full h-screen bg-transparent">
      <div className={`flex flex-col w-full h-full bg-road text-text-primary overflow-hidden ${isMaximized ? '' : 'rounded-[14px] border border-border'}`}>
        {/* ── Title bar ── */}
        <div className="flex items-center shrink-0 h-8 bg-road border-b border-border">
          <div className="flex items-center gap-2 px-3 shrink-0">
            <button
              onClick={handleDockToMain}
              className="flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-[var(--layer-active)] transition-colors"
              title="Dock back to main window"
            >
              <DockIcon size={11} />
            </button>
            <span className="text-[11px] font-mono text-text-muted truncate max-w-[300px]">{tabLabel}</span>
            {linkedChannel && (
              <span className={`shrink-0 transition-colors duration-150 ${channelIconStateClass(linkedChannel.type, linkedChannel.state)}`}>
                {channelIcon(linkedChannel.type)}
              </span>
            )}
          </div>
          <div className="flex-1 h-full" data-tauri-drag-region onDoubleClick={handleMaximize} />
          <div className="flex items-center h-full shrink-0">
            <button className="window-control hover:bg-[var(--layer-selected)]" onClick={handleMinimize}>
              <MinimizeIcon size={10} />
            </button>
            <button className="window-control hover:bg-[var(--layer-selected)]" onClick={handleMaximize}>
              {isMaximized ? <RestoreIcon size={10} /> : <MaximizeIcon size={10} />}
            </button>
            <button className="window-control window-control-close" onClick={handleClose}>
              <CloseIcon size={10} />
            </button>
          </div>
        </div>

        {/* ── Terminal content ── */}
        <div className="flex-1 relative min-h-0 bg-surface">
          {!ready ? (
            <div className="flex items-center justify-center h-full text-text-muted text-[12px]">
              Initializing…
            </div>
          ) : (
            <div
              ref={receiveRef}
              onScroll={handleReceiveScroll}
              className="absolute inset-0 overflow-y-auto font-mono text-[12px] leading-relaxed p-2"
              onClick={handleReceiveClick}
              onContextMenu={handleReceiveContextMenu}
            >
              {pane && pane.entries.length === 0 ? (
                <div className="text-text-muted italic px-1 select-none">
                  {linkedChannel ? `Linked: ${linkedChannel.name} — waiting for data…` : 'No channel linked.'}
                </div>
              ) : (
                pane?.entries.map(entry => (
                  <div key={entry.id} className="whitespace-pre-wrap break-all">
                    {renderEntry(entry)}
                  </div>
                ))
              )}

              <div className="h-3 shrink-0" />

              <div className="flex items-center">
                {terminalSettings.showTimestamp && (
                  <span className={`shrink-0 select-none font-mono text-[12px] leading-relaxed text-text-muted ${terminalSettings.showInputPrefix ? 'mr-1.5' : ''}`}>
                    {inputTimestamp}
                  </span>
                )}
                <span className="shrink-0 select-none font-mono text-[12px] leading-relaxed text-text-muted">
                  {inputPromptBase}
                </span>
                <span className="mr-1.5 shrink-0 select-none font-mono text-[12px] font-semibold leading-relaxed text-text-secondary">
                  &gt;
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={pane?.cmdInput ?? ''}
                  onChange={e => focusedPaneId && useTerminalStore.getState().setCmdInput(focusedPaneId, e.target.value)}
                  onKeyDown={handleKeyDown}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder={linkedChannel ? "hex: 01 02 FF   'ASCII'   \"ASCII+NUL\"" : 'No channel'}
                  className={`flex-1 bg-transparent font-mono text-[12px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted/40 ${channelTone.caret}`}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {terminalContextMenu && (
        <TerminalContextMenu
          x={terminalContextMenu.x}
          y={terminalContextMenu.y}
          showReceived={showReceived}
          sendFormat={terminalSettings.sendFormat}
          receiveFormat={terminalSettings.receiveFormat}
          showInputPrefix={terminalSettings.showInputPrefix}
          showTimestamp={terminalSettings.showTimestamp}
          onClear={handleClearTerminal}
          onToggleReceived={handleToggleReceived}
          onSetSendFormat={(format) => updateTerminalSettings({ sendFormat: format })}
          onSetReceiveFormat={(format) => updateTerminalSettings({ receiveFormat: format })}
          onToggleInputPrefix={() => updateTerminalSettings({ showInputPrefix: !terminalSettings.showInputPrefix })}
          onToggleTimestamps={() => updateTerminalSettings({ showTimestamp: !terminalSettings.showTimestamp })}
          onClose={closeTerminalContextMenu}
        />
      )}
    </div>
  );
};
