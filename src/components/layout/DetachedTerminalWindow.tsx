import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useChannelStore, useBleStore, useSerialStore, useTcpStore, useUIStore } from '../../stores';
import { useTerminalStore, visibleTerminalEntries, receiveChannelsFor, ChannelTab } from '../../stores/terminalStore';
import { MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, DockIcon, BluetoothIcon, UsbIcon, WifiIcon } from '../common/Icons';
import { applyDetachedConnections, type DetachedConnections } from '../../lib/detachWindow';
import { resolveTerminalLink, useValidTerminalChannels, TerminalChannelPicker, terminalChannels, terminalTabLabel, terminalTabColor } from './TerminalChannels';
import type { DetachPayload, ReattachPayload, TerminalSettingsChangedPayload } from '../../lib/detachWindow';
import {
  channelActivitySourceLabel,
  shouldDisplayChannelActivity,
} from '../../lib/channelActivity';
import type { DetachedTerminalEntryEvent } from '../../types';
import { prepareTerminalNetworkSend, sendWithImmediateTxEcho } from '../../lib/terminalSend';
import { createEventSubscriptions } from './eventSubscriptions';
import { ChannelSelectionCircle } from '../common/ChannelSelectionCircle';
import { TerminalContextMenu } from './TerminalContextMenu';
import type { TerminalChannelSettings } from '../../stores/uiStore';
import { coalesceTerminalEntries, entryEndsWithLineBreak, formatInputTimestamp, formatTerminalEntryParts, formatTerminalEntryText, toHex } from './terminalUtils';
import { useInteractiveTerminalInput } from './InteractiveTerminal';

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
  useValidTerminalChannels(focusedPaneId, pane?.tabs, channels);
  const selectedChannels = activeTab ? terminalChannels(activeTab, channels) : [];
  const linkedChannel = selectedChannels.find(c => c.id === activeTab?.channelId);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);

  // Subscribe to receive initial state
  useEffect(() => {
    let cancelled = false;

    let gotInit = false;

    const setup = async () => {
      const stopSync = await listen<DetachedConnections>('terminal-connections', event => {
        if (!cancelled) applyDetachedConnections(event.payload);
      });
      const unlisten = await listen<DetachPayload>('detach-init', (event) => {
        if (cancelled || gotInit) return;
        gotInit = true;
        if (event.payload.connections) applyDetachedConnections(event.payload.connections);
        const { tab, entries, terminalSettings: initialTerminalSettings } = event.payload;

        // Build a single-pane terminal store from the received tab
        const paneId = crypto.randomUUID();
        const newTab: ChannelTab = {
          ...tab,
          id: crypto.randomUUID(),
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
              tabWriteTargets: { [newTab.id]: event.payload.writeTarget ?? null },
              cmdInput: '',
              cmdHistory: [],
              historyIndex: -1,
              autoScroll: true,
              selectedWriteTarget: event.payload.writeTarget ?? null,
              selectMode: false,
              selectOptions: [],
              udpTargetAddr: event.payload.udpTargetAddr ?? null,
              selectedTcpClientId: null,
            },
          },
          focusedPaneId: paneId,
        });
        useUIStore.getState().setTerminalChannelSettings(
          tab.id ? `tab:${tab.id}` : (tab.channelId ?? '__terminal__'),
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

      return () => { unlisten(); stopSync(); };
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

  useEffect(() => {
    if (ready && pane && pane.tabs.length === 0) {
      void appWindow.close().catch(() => {});
    }
  }, [ready, pane, appWindow]);

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
    const currentTerminalSettings = (tab.id ? ui.terminalChannelSettings[`tab:${tab.id}`] : undefined)
      ?? ui.terminalChannelSettings[tab.channelId ?? '__terminal__'] ?? {
      sendFormat: ui.sendFormat,
      receiveFormat: ui.receiveFormat,
      showInputPrefix: ui.showInputPrefix,
      showTimestamp: ui.showTimestamp,
    };

    const payload: ReattachPayload = {
      tab: { ...tab, isPinned: false },
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
  const terminalSettingsKey = activeTab?.id
    ? `tab:${activeTab.id}`
    : (activeTab?.channelId ?? '__terminal__');
  const getTerminalSettingsForTab = useCallback((tab: typeof activeTab): TerminalChannelSettings => {
    const byTab = tab?.id ? terminalChannelSettings[`tab:${tab.id}`] : undefined;
    const byChannel = terminalChannelSettings[tab?.channelId ?? '__terminal__'];
    return byTab ?? byChannel ?? {
      sendFormat,
      receiveFormat,
      showInputPrefix,
      showTimestamp,
    };
  }, [receiveFormat, sendFormat, showInputPrefix, showTimestamp, terminalChannelSettings]);
  const terminalSettings = getTerminalSettingsForTab(activeTab);
  const visibleEntries = useMemo(
    () => coalesceTerminalEntries(
      visibleTerminalEntries(activeTab, pane?.entries ?? []),
      terminalSettings.receiveFormat,
    ),
    [activeTab, pane?.entries, terminalSettings.receiveFormat],
  );
  const updateTerminalSettings = useCallback((changes: Partial<typeof terminalSettings>) => {
    const nextSettings = { ...terminalSettings, ...changes };
    setTerminalChannelSettings(terminalSettingsKey, nextSettings);
    void emit('terminal-channel-settings-changed', {
      channelId: terminalSettingsKey,
      settings: nextSettings,
    });
  }, [setTerminalChannelSettings, terminalSettings, terminalSettingsKey]);

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

    if (!linkedChannel && !raw.startsWith('/')) {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'Use /link <channel-name-or-index> to select a send target.');
      return;
    }
    useTerminalStore.getState().pushCmdHistory(focusedPaneId, raw);
    useTerminalStore.getState().setCmdInput(focusedPaneId, '');

    if (raw.startsWith('/')) {
      useTerminalStore.getState().appendEntry(focusedPaneId, 'tx', raw);
      // Simple command handling for detached window
      const [command, ...args] = raw.split(/\s+/);
      if (command.toLowerCase() === '/link') {
        if (!activeTab) return;
        const result = resolveTerminalLink(activeTab, channels, args.join(' '));
        const store = useTerminalStore.getState();
        if (result.error) { store.appendEntry(focusedPaneId, 'system', result.error); return; }
        store.configureTab(focusedPaneId, activeTab.id, result.receive, result.target.id);
        store.appendEntry(focusedPaneId, 'system', `Send target: ${result.target.name}`);
      } else if (raw === '/clear') {
        useTerminalStore.getState().clearEntries(focusedPaneId);
      } else if (raw === '/help') {
        useTerminalStore.getState().appendEntry(focusedPaneId, 'system', 'Detached commands: /link <channel-name-or-index>, /clear, /help');
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
        linkedChannel.name,
        linkedChannel.id,
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
      if (linkedChannel.type !== 'ble') {
        const send = prepareTerminalNetworkSend(linkedChannel, currentPane, bytes, message => useTerminalStore.getState().appendEntry(focusedPaneId, 'system', message));
        await send();
      } else {
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
  }, [focusedPaneId, activeTab, channels, linkedChannel, connectedDeviceId]);

  const {
    handleInteractiveKeyDown,
    handleInteractivePaste,
    handleInteractiveCompositionStart,
    handleInteractiveCompositionEnd,
    handleInteractiveBlur,
  } = useInteractiveTerminalInput({
    paneId: focusedPaneId,
    channelId: linkedChannel?.id ?? null,
    enabled: Boolean(terminalSettings.interactiveMode),
  });

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!focusedPaneId) return;
    if (handleInteractiveKeyDown(e)) {
      return;
    }
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
  }, [focusedPaneId, handleInteractiveKeyDown, handleSend]);

  // ─── Event listeners for incoming data (mirrors CenterPanel logic) ─
  useEffect(() => {
    if (!focusedPaneId) return;
    const events = createEventSubscriptions();
    const receive = activeTab ? receiveChannelsFor(activeTab) : [];
    const accepts = (id?: string | null) => receive === 'all' || (!!id && receive.includes(id));

    // Serial data
    events.listen('serial-monitor-data', (event) => {
      for (const record of event.payload) {
        if (!accepts(record.channelId)) continue;
        const hex = record.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        useTerminalStore.getState().appendEntry(focusedPaneId, record.direction,
          `${record.direction.toUpperCase()}: ${hex}${(record.flags & 3) ? ' [incomplete capture]' : ''}${record.status ? ` [status 0x${record.status.toString(16)}]` : ''}`,
          record.timestamp, record.data, undefined, record.source, record.channelId);
      }
    });
    events.listen('serial-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const mappedChannelId = useSerialStore.getState().connectionMap[connectionId];
      if (!accepts(mappedChannelId)) return;
      if (receive !== 'all' && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `SERIAL · ${connectionId}`,
        mappedChannelId,
      );
    });

    // TCP data
    events.listen('tcp-data-received', (event) => {
      const { connectionId, data, timestamp } = event.payload;
      const mappedChannelId = useTcpStore.getState().connectionMap[connectionId];
      if (!accepts(mappedChannelId)) return;
      if (receive !== 'all' && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `TCP · ${connectionId}`,
        mappedChannelId,
      );
    });

    // UDP data
    events.listen('udp-data-received', (event) => {
      const { localAddr, remoteAddr, data, timestamp } = event.payload;
      const mappedChannelId = useTcpStore.getState().connectionMap[`udp:${localAddr}`];
      if (!accepts(mappedChannelId)) return;
      if (receive !== 'all' && !showReceivedRef.current) return;
      const hex = data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `[${remoteAddr}] RX: ${hex}`,
        timestamp,
        data,
        undefined,
        `UDP · ${localAddr}`,
        mappedChannelId,
      );
    });

    // BLE notifications
    events.listen('ble-notification-received', (event) => {
      const { deviceId, serviceUuid, charUuid, data, timestamp } = event.payload;
      const mappedChannelId = useBleStore.getState().getChannelIdForDevice(deviceId);
      if (!accepts(mappedChannelId)) return;
      if (receive !== 'all' && !showReceivedRef.current) return;
      useTerminalStore.getState().appendEntry(
        focusedPaneId,
        'rx',
        `RX: ${toHex(data)}`,
        timestamp,
        data,
        { serviceUuid, charUuid },
        `BLE · ${deviceId}`,
        mappedChannelId ?? undefined,
      );
    });

    events.listen('channel-activity', (event) => {
      const activity = event.payload;
      const mappedChannelId = activity.transport === 'ble' && activity.endpoint?.deviceId
        ? useBleStore.getState().getChannelIdForDevice(activity.endpoint.deviceId)
        : activity.transport === 'serial' && activity.connectionId
          ? useSerialStore.getState().connectionMap[activity.connectionId]
          : activity.connectionId
            ? useTcpStore.getState().connectionMap[activity.connectionId]
            : undefined;
      if (!accepts(mappedChannelId ?? activity.channelId)) return;
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
          mappedChannelId ?? activity.channelId ?? undefined,
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
        mappedChannelId ?? activity.channelId ?? undefined,
      );
    });

    return events.dispose;
  }, [focusedPaneId, activeTab]);

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

  const renderInteractiveInputCursor = () => (
    <span
      data-testid="terminal-inline-cursor"
      className="inline-block w-[7px] h-[14px] translate-y-[2px] bg-accent-green animate-pulse select-none"
      aria-hidden="true"
    />
  );

  const renderEntry = (
    entry: { kind: 'rx' | 'tx' | 'system'; timestamp: number; text: string; data?: number[]; bleMetadata?: { serviceUuid: string; charUuid: string }; sourceLabel?: string },
    isLastEntry = false,
  ): React.ReactNode => {
    const options = {
      promptText: selectedChannels.length > 1 ? '>' : promptText,
      showTimestamp: terminalSettings.showTimestamp,
      showInputPrefix: terminalSettings.showInputPrefix,
      sendFormat: terminalSettings.sendFormat,
      receiveFormat: terminalSettings.receiveFormat,
      aggregate: selectedChannels.length > 1 || (activeTab && receiveChannelsFor(activeTab) === 'all'),
    };
    const parts = formatTerminalEntryParts(entry, options);
    if (!parts) {
      return (
        <span className="text-text-muted italic">
          {formatTerminalEntryText(entry, options)}
          {terminalSettings.interactiveMode && isLastEntry ? renderInteractiveInputCursor() : null}
        </span>
      );
    }
    const payloadClass = entry.kind === 'rx' ? channelTone.rx : channelTone.tx;
    if (terminalSettings.interactiveMode) {
      const trailingBreak = isLastEntry && entryEndsWithLineBreak(entry, terminalSettings.receiveFormat) ? '\n' : '';
      return (
        <span className={payloadClass}>
          {parts.leadingText ? <span className="text-text-muted">{parts.leadingText} </span> : null}
          {parts.metadata ? (
            <>
              <span className="text-text-secondary">{parts.metadata}</span>
              {'\n'}
            </>
          ) : null}
          {parts.rawPayload}
          {trailingBreak}
          {isLastEntry ? renderInteractiveInputCursor() : null}
        </span>
      );
    }
    if (parts.metadata) {
      return (
        <div className="flex items-start">
          <span className="shrink-0 whitespace-pre">
            <span className="text-text-muted">{parts.leadingText}</span>
            <span className="font-semibold text-text-secondary">{parts.marker}</span>
            {' '}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-text-secondary">{parts.metadata}</span>
            {'\n'}
            <span className={payloadClass}>{parts.rawPayload}</span>
          </span>
        </div>
      );
    }
    return (
      <div className="flex items-start">
        <span className="shrink-0 whitespace-pre">
          <span className="text-text-muted">{parts.leadingText}</span>
          <span className="font-semibold text-text-secondary">{parts.marker}</span>
          {' '}
        </span>
        <span className={`min-w-0 flex-1 ${payloadClass}`}>{parts.rawPayload}</span>
      </div>
    );
  };
  const inputPromptBase = visiblePrompt.endsWith('>')
    ? visiblePrompt.slice(0, -1)
    : visiblePrompt;

  const tabLabel = activeTab ? terminalTabLabel(selectedChannels, channels.length) : 'Terminal';

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
            <button className="flex max-w-[300px] items-center justify-center gap-1.5 font-mono text-[11px] font-semibold" style={{ color: terminalTabColor(selectedChannels) }}
              onContextMenu={event => { event.preventDefault(); setPicker({ x: event.clientX, y: event.clientY }); }}>
              {activeTab && (selectedChannels.length !== 1 || channels.length === 1) && (
                <ChannelSelectionCircle selected={selectedChannels.length} total={channels.length} className="size-2" />
              )}
              <span className="truncate">{tabLabel}</span>
            </button>
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
              {pane && visibleEntries.length === 0 ? (
                terminalSettings.interactiveMode ? (
                  <div className="whitespace-pre-wrap break-all">
                    {renderInteractiveInputCursor()}
                  </div>
                ) : (
                  <div className="text-text-muted italic px-1 select-none">
                    {selectedChannels.length ? 'Waiting for channel data…' : 'Create a channel to receive data.'}
                  </div>
                )
              ) : (
                visibleEntries.map((entry, index) => (
                  <div key={entry.id} className="whitespace-pre-wrap break-all">
                    {renderEntry(entry, index === visibleEntries.length - 1)}
                  </div>
                ))
              )}

              {!terminalSettings.interactiveMode && <div className="h-3 shrink-0" />}

              <div className={terminalSettings.interactiveMode ? 'h-0 overflow-hidden opacity-0 pointer-events-none' : 'flex items-center'}>
                {!terminalSettings.interactiveMode && terminalSettings.showTimestamp && (
                  <span className={`shrink-0 select-none font-mono text-[12px] leading-relaxed text-text-muted ${terminalSettings.showInputPrefix ? 'mr-1.5' : ''}`}>
                    {inputTimestamp}
                  </span>
                )}
                {!terminalSettings.interactiveMode && (
                  <>
                    <span className="shrink-0 select-none font-mono text-[12px] leading-relaxed text-text-muted">
                      {inputPromptBase}
                    </span>
                    <span className="mr-1.5 shrink-0 select-none font-mono text-[12px] font-semibold leading-relaxed text-text-secondary">
                      &gt;
                    </span>
                  </>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={pane?.cmdInput ?? ''}
                  onChange={e => {
                    if (focusedPaneId && !terminalSettings.interactiveMode) {
                      useTerminalStore.getState().setCmdInput(focusedPaneId, e.target.value);
                    }
                  }}
                  onKeyDown={handleKeyDown}
                  onPaste={handleInteractivePaste}
                  onCompositionStart={handleInteractiveCompositionStart}
                  onCompositionEnd={handleInteractiveCompositionEnd}
                  onBlur={handleInteractiveBlur}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder={linkedChannel ? "hex: 01 02 FF   'ASCII'   \"ASCII+NUL\"" : 'No channel'}
                  className={terminalSettings.interactiveMode
                    ? 'w-0 h-0 opacity-0 outline-none border-0 p-0 m-0'
                    : `flex-1 bg-transparent font-mono text-[12px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted/40 ${channelTone.caret}`}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {picker && activeTab && focusedPaneId && <TerminalChannelPicker {...picker} paneId={focusedPaneId} tab={activeTab} channels={channels} onClose={() => setPicker(null)} />}
      {terminalContextMenu && (
        <TerminalContextMenu
          x={terminalContextMenu.x}
          y={terminalContextMenu.y}
          showReceived={showReceived}
          sendFormat={terminalSettings.sendFormat}
          receiveFormat={terminalSettings.receiveFormat}
          showInputPrefix={terminalSettings.showInputPrefix}
          showTimestamp={terminalSettings.showTimestamp}
          interactiveMode={terminalSettings.interactiveMode ?? false}
          onToggleInteractiveMode={() => {
            updateTerminalSettings({ interactiveMode: !terminalSettings.interactiveMode });
            inputRef.current?.focus();
          }}
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
