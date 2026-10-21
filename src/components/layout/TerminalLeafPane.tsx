import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useChannelStore, useProtocolStore, useBleStore, useSerialStore, useTcpStore, useUIStore, toast } from '../../stores';
import { useTerminalStore, DropZone } from '../../stores/terminalStore';
import { PlusIcon, BluetoothIcon, UsbIcon, WifiIcon, TerminalIcon, CloseIcon, SplitIcon, BookmarkIcon, PopOutIcon } from '../common/Icons';
import { detachTabToWindow } from '../../lib/detachWindow';
import { sendWithImmediateTxEcho } from '../../lib/terminalSend';
import { SavedCommandsPanel } from './SavedCommandsPanel';
import { SavedCommandsDialog } from './SavedCommandsDialog';
import { ResizeHandle } from './ResizeHandle';
import { TerminalContextMenu } from './TerminalContextMenu';
import { buildBleWriteSelectionMenu, formatBleUuid, formatInputTimestamp, formatTerminalEntryParts, formatTerminalEntryText, parseTerminalPayload, toHex } from './terminalUtils';

class PanelErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[SavedCommandsPanel crash]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 h-full text-text-muted text-xs gap-2 p-4">
          <div>Panel crashed: {this.state.error.message}</div>
          <button className="btn-icon px-3 text-[10px]" onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const DRAG_MIME = 'application/x-terminal-tab';
const DRAG_FALLBACK_MIME = 'text/plain';
const DRAG_FALLBACK_PREFIX = '__linkassist_terminal_tab__:';

function hasDragMime(e: React.DragEvent): boolean {
  const typeList = Array.from(e.dataTransfer.types);
  return typeList.includes(DRAG_MIME) || typeList.includes(DRAG_FALLBACK_MIME);
}

function encodeDragData(data: { paneId: string; tabId: string }): string {
  return JSON.stringify(data);
}

function decodeDragData(raw: string): { paneId: string; tabId: string } | null {
  try {
    return JSON.parse(raw) as { paneId: string; tabId: string };
  } catch {
    return null;
  }
}


function channelIcon(type: string, size = 12) {
  if (type === 'ble') return <BluetoothIcon size={size} />;
  if (type === 'serial') return <UsbIcon size={size} />;
  return <WifiIcon size={size} />;
}

function channelIconStateClass(type: string, state?: string) {
  if (state === 'connecting') return 'text-accent-yellow animate-pulse';
  if (state === 'error') return 'text-accent-red';
  if (state !== 'connected') return 'text-text-faint';

  if (type === 'ble') return 'text-accent-blue';
  if (type === 'serial') return 'text-accent-mauve';
  return 'text-accent-green';
}

function channelAccentClasses(type?: string) {
  switch (type) {
    case 'ble':
      return {
        line: 'bg-accent-blue',
        tab: 'terminal-tab-accent-blue',
      };
    case 'serial':
      return {
        line: 'bg-accent-mauve',
        tab: 'terminal-tab-accent-mauve',
      };
    case 'tcp':
      return {
        line: 'bg-accent-green',
        tab: 'terminal-tab-accent-green',
      };
    default:
      return {
        line: 'bg-[var(--text-faint)]',
        tab: 'bg-[var(--layer-hover)] shadow-[inset_0_-2px_0_0_var(--border-default)]',
      };
  }
}

function channelToneClasses(type?: string) {
  switch (type) {
    case 'ble':
      return {
        prompt: 'text-accent-blue',
        rx: 'text-accent-blue/80',
        tx: 'text-accent-blue/90',
        caret: 'caret-accent-blue',
      };
    case 'serial':
      return {
        prompt: 'text-accent-mauve',
        rx: 'text-accent-mauve/80',
        tx: 'text-accent-mauve/90',
        caret: 'caret-accent-mauve',
      };
    case 'tcp':
      return {
        prompt: 'text-accent-green',
        rx: 'text-accent-green/80',
        tx: 'text-accent-green/90',
        caret: 'caret-accent-green',
      };
    default:
      return {
        prompt: 'text-text-secondary',
        rx: 'text-text-secondary',
        tx: 'text-text-primary',
        caret: 'caret-text-secondary',
      };
  }
}

interface Props {
  paneId: string;
}

export const TerminalLeafPane: React.FC<Props> = ({ paneId }) => {
  const { channels, activeChannelId } = useChannelStore();
  const {
    sendFormat,
    receiveFormat,
    showTimestamp,
    showReceived,
    showInputPrefix,
    setShowReceived,
    terminalChannelSettings,
    setTerminalChannelSettings,
  } = useUIStore();
  const { linkedServiceUuid, linkedCharUuid, setLinkedChannel, setLinkedService, setLinkedChar } = useProtocolStore();
  const { channelStates } = useBleStore();

  const pane = useTerminalStore(s => s.panes[paneId]);
  const focusedPaneId = useTerminalStore(s => s.focusedPaneId);
  const {
    setFocusedPane,
    appendEntry,
    appendEntryToChannel,
    clearEntries,
    setCmdInput,
    pushCmdHistory,
    setAutoScroll,
    setSelectedWriteTarget,
    setSelectMode,
    setUdpTargetAddr,
    setSelectedTcpClient,
    addTab,
    renameTab,
    removeTab,
    selectPaneTab,
    splitPane,
    toggleCommandsPanel,
    reorderTab,
    dropTabOnZone,
  } = useTerminalStore.getState();

  const isFocused = focusedPaneId === paneId;

  const activeTab = pane?.tabs.find(t => t.id === pane.activeTabId);
  const linkedChannel = channels.find(c => c.id === (activeTab?.channelId ?? null));
  const terminalSettingsKey = activeTab?.channelId ?? '__terminal__';
  const getTerminalSettingsForChannel = useCallback((channelId: string | null | undefined) => (
    terminalChannelSettings[channelId ?? '__terminal__'] ?? {
      sendFormat,
      receiveFormat,
      showInputPrefix,
      showTimestamp,
    }
  ), [receiveFormat, sendFormat, showInputPrefix, showTimestamp, terminalChannelSettings]);
  const terminalSettings = getTerminalSettingsForChannel(activeTab?.channelId);
  const updateTerminalSettings = useCallback((changes: Partial<typeof terminalSettings>) => {
    const nextSettings = { ...terminalSettings, ...changes };
    setTerminalChannelSettings(terminalSettingsKey, nextSettings);
    void emit('terminal-channel-settings-changed', {
      channelId: activeTab?.channelId ?? null,
      settings: nextSettings,
    });
  }, [activeTab?.channelId, setTerminalChannelSettings, terminalSettings, terminalSettingsKey]);
  const connectedDeviceId = linkedChannel?.type === 'ble'
    ? (channelStates[linkedChannel.id]?.connectedDeviceId ?? null)
    : null;
  const toneClasses = channelToneClasses(linkedChannel?.type);
  const writeTarget = pane?.selectedWriteTarget;
  const udpAddr = pane?.udpTargetAddr;
  const tcpMode = useTcpStore.getState().mode;

  let promptText: string;
  if (pane?.selectMode) {
    promptText = '#?>';
  } else if (linkedChannel?.type === 'ble' && writeTarget) {
    promptText = `BLE:${formatBleUuid(writeTarget.serviceUuid)}/${formatBleUuid(writeTarget.charUuid)}>`;
  } else if (linkedChannel?.type === 'tcp' && tcpMode === 'udp' && udpAddr) {
    promptText = `UDP:${udpAddr}>`;
  } else if (linkedChannel) {
    promptText = `${linkedChannel.name}>`;
  } else {
    promptText = '>';
  }
  const visiblePromptText = terminalSettings.showInputPrefix ? promptText : '>';

  const receiveRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputTimestamp, setInputTimestamp] = useState(() => formatInputTimestamp(Date.now()));

  const showReceivedRef = useRef(showReceived);
  useEffect(() => { showReceivedRef.current = showReceived; }, [showReceived]);
  useEffect(() => {
    if (!terminalSettings.showTimestamp) return;
    const updateTimestamp = () => setInputTimestamp(formatInputTimestamp(Date.now()));
    updateTimestamp();
    const intervalId = window.setInterval(updateTimestamp, 1000);
    return () => window.clearInterval(intervalId);
  }, [terminalSettings.showTimestamp]);

  const addEntry = useCallback((kind: 'rx' | 'tx' | 'system', text: string, data?: number[]) => {
    if (linkedChannel) {
      appendEntryToChannel(
        linkedChannel.id,
        kind,
        text,
        undefined,
        data,
        undefined,
        `${linkedChannel.name} · ${linkedChannel.type.toUpperCase()}`,
      );
    } else {
      appendEntry(paneId, kind, text, undefined, data);
    }
  }, [paneId, linkedChannel, appendEntry, appendEntryToChannel]);

  useEffect(() => {
    if (!pane?.autoScroll || !receiveRef.current) return;
    receiveRef.current.scrollTop = receiveRef.current.scrollHeight;
  }, [pane?.entries, pane?.autoScroll]);

  const handleReceiveScroll = useCallback(() => {
    if (!receiveRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = receiveRef.current;
    setAutoScroll(paneId, scrollHeight - scrollTop - clientHeight < 40);
  }, [paneId, setAutoScroll]);

  const handleReceiveClick = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    inputRef.current?.focus();
  }, []);

  const showSelectMenu = useCallback((leadingMessage?: string) => {
    if (!linkedChannel || linkedChannel.type !== 'ble') {
      addEntry('system', '/select is only available for BLE channels');
      return false;
    }
    const services = useBleStore.getState().channelStates[linkedChannel.id]?.gattServices ?? [];
    const { options, lines } = buildBleWriteSelectionMenu(services);
    if (options.length === 0) {
      addEntry('system', [
        ...(leadingMessage ? [leadingMessage] : []),
        'No writable characteristics found. Discover GATT services first.',
      ].join('\n'));
      return false;
    }
    addEntry('system', [...(leadingMessage ? [leadingMessage] : []), ...lines].join('\n'));
    setSelectMode(paneId, true, options);
    return true;
  }, [addEntry, linkedChannel, paneId, setSelectMode]);

  const processCommand = useCallback((input: string) => {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/link': {
        const target = args.join(' ').toLowerCase();
        if (!target) { addEntry('system', 'Usage: /link <channel-name-or-index>'); return; }
        const ch = channels.find(c =>
          c.name.toLowerCase() === target ||
          c.id === target ||
          channels.indexOf(c).toString() === target
        );
        if (!ch) {
          addEntry('system', `Channel not found: ${target}. Available: ${channels.map(c => c.name).join(', ')}`);
          return;
        }
        setLinkedChannel(ch.id);
        const currentPane = useTerminalStore.getState().panes[paneId];
        if (currentPane?.activeTabId) {
          useTerminalStore.setState(state => ({
            panes: {
              ...state.panes,
              [paneId]: {
                ...state.panes[paneId],
                tabs: state.panes[paneId].tabs.map(t =>
                  t.id === currentPane.activeTabId ? { ...t, channelId: ch.id, label: ch.name } : t
                ),
              },
            },
          }));
        }
        addEntry('system', `Linked to channel: ${ch.name}`);
        break;
      }
      case '/ts': {
        const val = args[0]?.toLowerCase();
        if (val === 'on') { updateTerminalSettings({ showTimestamp: true }); addEntry('system', 'Timestamps: ON'); }
        else if (val === 'off') { updateTerminalSettings({ showTimestamp: false }); addEntry('system', 'Timestamps: OFF'); }
        else addEntry('system', 'Usage: /ts on|off');
        break;
      }
      case '/rx': {
        const val = args[0]?.toLowerCase();
        if (val === 'on') { setShowReceived(true); addEntry('system', 'Receive display: ON'); }
        else if (val === 'off') { setShowReceived(false); addEntry('system', 'Receive display: OFF'); }
        else addEntry('system', 'Usage: /rx on|off');
        break;
      }
      case '/notify': {
        const val = args[0]?.toLowerCase();
        if (!connectedDeviceId || !linkedServiceUuid || !linkedCharUuid) {
          addEntry('system', 'BLE not linked — use /service and /char first');
          return;
        }
        if (val === 'on') {
          invoke('subscribe_ble_notifications', { deviceId: connectedDeviceId, serviceUuid: linkedServiceUuid, charUuid: linkedCharUuid })
            .then(() => addEntry('system', 'BLE notifications: ON'))
            .catch(e => addEntry('system', `Notify error: ${e}`));
        } else if (val === 'off') {
          invoke('unsubscribe_ble_notifications', { deviceId: connectedDeviceId, serviceUuid: linkedServiceUuid, charUuid: linkedCharUuid })
            .then(() => addEntry('system', 'BLE notifications: OFF'))
            .catch(e => addEntry('system', `Notify error: ${e}`));
        } else {
          addEntry('system', 'Usage: /notify on|off');
        }
        break;
      }
      case '/indicate': {
        const val = args[0]?.toLowerCase();
        if (!connectedDeviceId || !linkedServiceUuid || !linkedCharUuid) {
          addEntry('system', 'BLE not linked — use /service and /char first');
          return;
        }
        if (val === 'on') {
          invoke('subscribe_ble_notifications', { deviceId: connectedDeviceId, serviceUuid: linkedServiceUuid, charUuid: linkedCharUuid })
            .then(() => addEntry('system', 'BLE indications: ON'))
            .catch(e => addEntry('system', `Indicate error: ${e}`));
        } else if (val === 'off') {
          invoke('unsubscribe_ble_notifications', { deviceId: connectedDeviceId, serviceUuid: linkedServiceUuid, charUuid: linkedCharUuid })
            .then(() => addEntry('system', 'BLE indications: OFF'))
            .catch(e => addEntry('system', `Indicate error: ${e}`));
        } else {
          addEntry('system', 'Usage: /indicate on|off');
        }
        break;
      }
      case '/service': {
        const uuid = args[0];
        if (!uuid) { addEntry('system', 'Usage: /service <uuid>'); return; }
        setLinkedService(uuid);
        addEntry('system', `Service set: ${uuid}`);
        break;
      }
      case '/char': {
        const uuid = args[0];
        if (!uuid) { addEntry('system', 'Usage: /char <uuid>'); return; }
        setLinkedChar(uuid);
        addEntry('system', `Characteristic set: ${uuid}`);
        break;
      }
      case '/select': {
        if (!linkedChannel || linkedChannel.type !== 'ble') {
          addEntry('system', '/select is only available for BLE channels');
          break;
        }
        if (!connectedDeviceId) {
          addEntry('system', 'BLE not connected');
          break;
        }
        showSelectMenu();
        break;
      }
      case '/clients': {
        if (!linkedChannel || linkedChannel.type !== 'tcp') {
          addEntry('system', '/clients is only available for TCP channels');
          break;
        }
        const tcpState = useTcpStore.getState();
        const clients = tcpState.serverClients;
        if (clients.length === 0) {
          addEntry('system', 'No TCP clients connected');
          break;
        }
        const selected = useTerminalStore.getState().panes[paneId]?.selectedTcpClientId;
        addEntry('system', `Connected clients (target: ${selected === 'all' ? 'all' : selected ?? 'first'}):`);
        clients.forEach((client, index) => {
          const marker = client.id === selected ? ' *' : '';
          addEntry('system', `  ${index + 1}) ${client.addr}${marker}`);
        });
        addEntry('system', 'Use /client <n|all> to choose the send target');
        break;
      }
      case '/client': {
        if (!linkedChannel || linkedChannel.type !== 'tcp') {
          addEntry('system', '/client is only available for TCP channels');
          break;
        }
        const value = args[0]?.toLowerCase();
        const clients = useTcpStore.getState().serverClients;
        if (!value) {
          addEntry('system', 'Usage: /client <n|all>  (see /clients for the list)');
          break;
        }
        if (value === 'all') {
          setSelectedTcpClient(paneId, 'all');
          addEntry('system', 'Send target: all clients (broadcast)');
          break;
        }
        const index = parseInt(value, 10);
        const client = Number.isFinite(index) ? clients[index - 1] : undefined;
        if (!client) {
          addEntry('system', `Invalid client: "${args[0]}". Enter 1–${clients.length} or "all"`);
          break;
        }
        setSelectedTcpClient(paneId, client.id);
        addEntry('system', `Send target: ${client.addr}`);
        break;
      }
      case '/udptarget': {
        const raw = args[0];
        const currentUdpAddr = useTerminalStore.getState().panes[paneId]?.udpTargetAddr;
        if (!raw) {
          if (currentUdpAddr) {
            addEntry('system', `Current UDP target: ${currentUdpAddr}`);
          } else {
            addEntry('system', 'Usage: /udptarget <ip:port>  (e.g. /udptarget 127.0.0.1:8081)');
          }
          return;
        }
        const addr = raw.replace(/^[<\s]+|[>\s]+$/g, '');
        if (!addr || !addr.includes(':')) {
          addEntry('system', `Invalid address format: "${raw}". Expected ip:port (e.g. 127.0.0.1:8081)`);
          return;
        }
        setUdpTargetAddr(paneId, addr);
        addEntry('system', `UDP target set: ${addr}`);
        break;
      }
      case '/clear': {
        clearEntries(paneId);
        break;
      }
      case '/help': {
        const helpLines = [
          '━━━ Available Commands ━━━',
          '/link <name|index>    — link active tab to a channel',
          '/select               — choose BLE write characteristic',
          '/clients              — list TCP server clients',
          '/client <n|all>       — choose TCP server send target',
          '/udptarget <ip:port>  — set UDP send target address',
          '/ts on|off            — toggle timestamps',
          '/rx on|off            — toggle receive display',
          '/notify on|off        — toggle BLE notifications',
          '/indicate on|off      — toggle BLE indications',
          '/service <uuid>       — set BLE service UUID',
          '/char <uuid>          — set BLE characteristic UUID',
          '/clear                — clear terminal',
          '/help                 — show this help',
          '━━━ Send Formats ━━━',
          'Default              — hex bytes: 01 02 FF',
          "Single quotes        — ASCII: 'Hello'",
          "Double quotes        — ASCII + NUL: \"Hello\"",
        ];
        helpLines.forEach(l => addEntry('system', l));
        break;
      }
      default:
        addEntry('system', `Unknown command: ${cmd}  (type /help for help)`);
    }
  }, [channels, linkedChannel, linkedServiceUuid, linkedCharUuid, connectedDeviceId, addEntry, paneId, setLinkedChannel, setLinkedService, setLinkedChar, updateTerminalSettings, setShowReceived, showSelectMenu, clearEntries, setUdpTargetAddr, setSelectedTcpClient]);

  const handleSend = useCallback(async () => {
    const currentPane = useTerminalStore.getState().panes[paneId];
    if (!currentPane) return;
    const raw = currentPane.cmdInput.trim();
    if (!raw) {
      if (
        linkedChannel?.type === 'ble'
        && connectedDeviceId
        && !currentPane.selectedWriteTarget
        && !currentPane.selectMode
      ) {
        showSelectMenu('No write characteristic selected — opening selection…');
        return;
      }
      addEntry('system', ' ');
      setCmdInput(paneId, '');
      return;
    }

    pushCmdHistory(paneId, raw);
    setCmdInput(paneId, '');

    if (currentPane.selectMode) {
      const num = parseInt(raw, 10);
      const match = currentPane.selectOptions.find(o => o.idx === num);
      if (!match) {
        addEntry('system', `Invalid selection: "${raw}". Enter a number 1–${currentPane.selectOptions.length}`);
        return;
      }
      setSelectedWriteTarget(paneId, { serviceUuid: match.serviceUuid, charUuid: match.charUuid });
      setSelectMode(paneId, false);
      addEntry('system', `Selected: ${match.label}`);
      return;
    }

    if (raw.startsWith('/')) {
      addEntry('tx', raw);
      processCommand(raw);
      return;
    }

    const parsedPayload = parseTerminalPayload(raw);
    if (!parsedPayload) {
      addEntry('system', `Invalid hex: "${raw}"  (use spaces: 01 02 FF, or quotes for ASCII)`);
      return;
    }

    const { bytes, modeLabel } = parsedPayload;

    if (!linkedChannel) {
      addEntry('system', 'No channel linked — use /link <name> or add a tab');
      return;
    }

    const hexStr = toHex(bytes);
    const txLine = `TX(${modeLabel}): ${hexStr}`;

    try {
      if (linkedChannel.type === 'serial') {
        // Route to the connection belonging to THIS channel, not just the
        // first open port — multiple serial channels can be open at once.
        const { connectionMap } = useSerialStore.getState();
        const connectionId = Object.keys(connectionMap).find(
          (id) => connectionMap[id] === linkedChannel.id,
        );
        if (!connectionId) { addEntry('system', 'No serial port open for this channel'); return; }
        await invoke('send_serial_data', { connectionId, data: bytes });
      } else if (linkedChannel.type === 'tcp') {
        const tcpState = useTcpStore.getState();
        // Use this channel's configured mode; the global store mode reflects
        // whichever TCP panel was touched last, not this tab's channel.
        const mode = tcpState.channelConfigs[linkedChannel.id]?.mode ?? tcpState.mode;
        if (mode === 'client') {
          const connection = tcpState.clientConnections.find(
            (c) => tcpState.connectionMap[c.id] === linkedChannel.id,
          );
          if (!connection) { addEntry('system', 'No active TCP connection for this channel'); return; }
          await invoke('tcp_send', { connectionId: connection.id, data: bytes });
        } else if (mode === 'server') {
          const channelClients = tcpState.serverClients.filter(
            (c) => tcpState.connectionMap[c.id] === linkedChannel.id,
          );
          const candidates = channelClients.length > 0 ? channelClients : tcpState.serverClients;
          if (candidates.length === 0) { addEntry('system', 'No TCP client connected'); return; }

          const selectedTcpClientId = currentPane.selectedTcpClientId;
          if (selectedTcpClientId === 'all') {
            const results = await Promise.allSettled(
              candidates.map((c) => invoke('tcp_server_send', { clientId: c.id, data: bytes })),
            );
            const failed = results.filter((r) => r.status === 'rejected').length;
            if (failed === candidates.length) {
              addEntry('system', 'Broadcast failed for every client');
              return;
            }
            if (failed > 0) {
              addEntry('system', `Broadcast: ${candidates.length - failed}/${candidates.length} clients reached`);
            }
          } else {
            const selected = selectedTcpClientId
              ? candidates.find((c) => c.id === selectedTcpClientId)
              : undefined;
            if (selectedTcpClientId && !selected) {
              addEntry('system', 'Selected client disconnected — use /clients to pick a new target');
              return;
            }
            const target = selected ?? candidates[0];
            if (!selectedTcpClientId && candidates.length > 1) {
              addEntry('system', `Multiple clients connected; sending to ${target.addr} (use /client <n|all> to change)`);
            }
            await invoke('tcp_server_send', { clientId: target.id, data: bytes });
          }
        } else if (mode === 'udp' && tcpState.udpBound) {
          const udpAddr = useTerminalStore.getState().panes[paneId]?.udpTargetAddr;
          if (!udpAddr) {
            addEntry('system', 'No UDP target set — use /udptarget <ip:port> first');
            return;
          }
          await invoke('udp_send', { addr: udpAddr, data: bytes });
        } else {
          addEntry('system', 'No active TCP connection');
          return;
        }
      } else if (linkedChannel.type === 'ble') {
        if (!connectedDeviceId) { addEntry('system', 'BLE not connected'); return; }
        const writeTarget = useTerminalStore.getState().panes[paneId]?.selectedWriteTarget;
        if (!writeTarget) {
          showSelectMenu('No write characteristic selected — opening selection…');
          return;
        }
        await sendWithImmediateTxEcho(
          () => {
            addEntry('tx', txLine, bytes);
          },
          () => invoke('write_ble_characteristic', {
            deviceId: connectedDeviceId,
            serviceUuid: writeTarget.serviceUuid,
            charUuid: writeTarget.charUuid,
            data: bytes,
          })
        );
        return;
      }

      addEntry('tx', txLine, bytes);
    } catch (error) {
      addEntry('system', `Send error: ${error}`);
    }
  }, [paneId, linkedChannel, connectedDeviceId, addEntry, processCommand, pushCmdHistory, setCmdInput, setSelectedWriteTarget, setSelectMode, showSelectMenu]);

  const historyIndexRef = useRef(-1);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      historyIndexRef.current = -1;
      handleSend();
      return;
    }
    const currentPane = useTerminalStore.getState().panes[paneId];
    const history = currentPane?.cmdHistory ?? [];
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(historyIndexRef.current + 1, history.length - 1);
      historyIndexRef.current = next;
      if (next >= 0 && history[next] !== undefined) setCmdInput(paneId, history[next]);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = historyIndexRef.current - 1;
      if (next < 0) { historyIndexRef.current = -1; setCmdInput(paneId, ''); return; }
      historyIndexRef.current = next;
      if (history[next] !== undefined) setCmdInput(paneId, history[next]);
      return;
    }
  }, [handleSend, paneId, setCmdInput]);

  const renderEntryContent = (entry: { kind: 'rx' | 'tx' | 'system'; timestamp: number; text: string; data?: number[]; bleMetadata?: { serviceUuid: string; charUuid: string } }): React.ReactNode => {
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
    const payloadClass = entry.kind === 'rx' ? toneClasses.rx : toneClasses.tx;
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
  const inputPromptBase = visiblePromptText.endsWith('>')
    ? visiblePromptText.slice(0, -1)
    : visiblePromptText;

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [showCommandsDialog, setShowCommandsDialog] = useState(false);
  const [commandsDialogAnchor, setCommandsDialogAnchor] = useState<{ top: number; left: number } | null>(null);
  const [commandsPanelWidth, setCommandsPanelWidth] = useState(280);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);

  const commandsTagId = activeTab?.channelId ?? activeChannelId ?? '__global_saved_commands__';

  const closeCommandsDialog = useCallback(() => {
    setShowCommandsDialog(false);
    setCommandsDialogAnchor(null);
  }, []);

  const handleCommandsPanelResize = useCallback((deltaX: number) => {
    setCommandsPanelWidth(prev => Math.max(160, Math.min(600, prev - deltaX)));
  }, []);

  const closeTerminalContextMenu = useCallback(() => {
    setTerminalContextMenu(null);
  }, []);

  const handleReceiveContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setFocusedPane(paneId);
    setTerminalContextMenu({ x: event.clientX, y: event.clientY });
  }, [paneId, setFocusedPane]);

  const handleClearTerminal = useCallback(() => {
    clearEntries(paneId);
    inputRef.current?.focus();
  }, [clearEntries, paneId]);

  const handleToggleReceived = useCallback(() => {
    setShowReceived(!showReceived);
    inputRef.current?.focus();
  }, [setShowReceived, showReceived]);

  const handleSelectTab = useCallback((tabId: string) => {
    setFocusedPane(paneId);
    selectPaneTab(paneId, tabId);
  }, [paneId, selectPaneTab, setFocusedPane]);

  const handleAddTab = useCallback(() => {
    const { activeChannelId, channels: currentChannels } = useChannelStore.getState();
    if (!activeChannelId) {
      toast.error('No active channel selected — select a channel in the left panel first');
      return;
    }
    const ch = currentChannels.find(c => c.id === activeChannelId);
    if (!ch) {
      toast.error('Active channel not found');
      return;
    }
    addTab(paneId, ch.id, ch.name);
  }, [paneId, addTab]);

  const handleRemoveTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeTab(paneId, tabId);
  }, [paneId, removeTab]);

  const startEditing = useCallback((tabId: string, label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTabId(tabId);
    setEditingLabel(label);
    setTimeout(() => editInputRef.current?.select(), 0);
  }, []);

  const confirmEditing = useCallback(() => {
    if (!editingTabId) return;
    const trimmed = editingLabel.trim();
    if (trimmed) renameTab(paneId, editingTabId, trimmed);
    setEditingTabId(null);
    setEditingLabel('');
  }, [editingTabId, editingLabel, paneId, renameTab]);

  const cancelEditing = useCallback(() => {
    setEditingTabId(null);
    setEditingLabel('');
  }, []);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmEditing(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
  }, [confirmEditing, cancelEditing]);

  const handleSplit = useCallback(() => {
    splitPane(paneId);
  }, [paneId, splitPane]);

  // ─── Drag & Drop ──────────────────────────────────────────────────────────
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [tabDropIndex, setTabDropIndex] = useState<number | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);

  const handleTabDragStart = useCallback((tabId: string, e: React.DragEvent) => {
    const tab = pane?.tabs.find(t => t.id === tabId);
    if (!tab || tab.isPinned) { e.preventDefault(); return; }
    const dragData = encodeDragData({ paneId, tabId });
    e.dataTransfer.setData(DRAG_MIME, dragData);
    e.dataTransfer.setData(DRAG_FALLBACK_MIME, `${DRAG_FALLBACK_PREFIX}${dragData}`);
    e.dataTransfer.effectAllowed = 'move';
    dragStartPos.current = { x: e.screenX, y: e.screenY };
  }, [paneId, pane?.tabs]);

  const handleTabDragEnd = useCallback(async (tabId: string, e: React.DragEvent) => {
    // If the drop was handled by an in-app target, dropEffect will be 'move'.
    // 'none' means the drag ended without hitting any valid drop zone — treat as detach.
    if (e.dataTransfer.dropEffect !== 'none') {
      dragStartPos.current = null;
      return;
    }

    const tab = pane?.tabs.find(t => t.id === tabId);
    if (!tab || tab.isPinned) { dragStartPos.current = null; return; }

    // Require minimum drag distance to prevent accidental detach from click/cancel
    const MIN_DRAG_DISTANCE = 40;
    if (dragStartPos.current) {
      const dx = e.screenX - dragStartPos.current.x;
      const dy = e.screenY - dragStartPos.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      dragStartPos.current = null;
      if (distance < MIN_DRAG_DISTANCE) return;
    } else {
      dragStartPos.current = null;
      return;
    }

    const ch = channels.find(c => c.id === tab.channelId);
    const entries = pane?.tabEntries[tabId] ?? pane?.entries ?? [];

    const label = await detachTabToWindow(
      {
        tab,
        entries,
        channelType: ch?.type,
        terminalSettings: getTerminalSettingsForChannel(tab.channelId),
      },
      e.screenX,
      e.screenY,
    );

    if (label) {
      removeTab(paneId, tabId);
    }
  }, [paneId, pane, channels, removeTab, getTerminalSettingsForChannel]);

  const handlePopOut = useCallback(async () => {
    if (!activeTab || activeTab.isPinned) {
      toast.error('Cannot pop out the pinned terminal tab');
      return;
    }

    const ch = channels.find(c => c.id === activeTab.channelId);
    const entries = pane?.tabEntries[activeTab.id] ?? pane?.entries ?? [];

    const label = await detachTabToWindow(
      { tab: activeTab, entries, channelType: ch?.type, terminalSettings },
    );

    if (label) {
      removeTab(paneId, activeTab.id);
    }
  }, [activeTab, pane, paneId, channels, removeTab, terminalSettings]);

  const parseDragData = useCallback((e: React.DragEvent): { paneId: string; tabId: string } | null => {
    const customRaw = e.dataTransfer.getData(DRAG_MIME);
    if (customRaw) {
      const parsed = decodeDragData(customRaw);
      if (parsed) return parsed;
    }

    const fallbackRaw = e.dataTransfer.getData(DRAG_FALLBACK_MIME);
    if (!fallbackRaw.startsWith(DRAG_FALLBACK_PREFIX)) return null;
    return decodeDragData(fallbackRaw.slice(DRAG_FALLBACK_PREFIX.length));
  }, []);

  const computeDropZone = useCallback((e: React.DragEvent<HTMLDivElement>): DropZone => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const edgeThreshold = 0.25;
    if (x < edgeThreshold) return 'left';
    if (x > 1 - edgeThreshold) return 'right';
    if (y < edgeThreshold) return 'top';
    if (y > 1 - edgeThreshold) return 'bottom';
    return 'center';
  }, []);

  const handlePaneDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDragMime(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropZone(computeDropZone(e));
  }, [computeDropZone]);

  const handlePaneDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // Only clear if leaving the pane entirely (not entering a child)
    if (dropRef.current && !dropRef.current.contains(e.relatedTarget as Node)) {
      setDropZone(null);
    }
  }, []);

  const handlePaneDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = dropZone ?? computeDropZone(e);
    setDropZone(null);
    const data = parseDragData(e);
    if (!data) return;
    dropTabOnZone(data.paneId, data.tabId, paneId, zone);
  }, [dropZone, computeDropZone, parseDragData, paneId, dropTabOnZone]);

  // Tab bar drop handling (reorder within same pane or move to this pane)
  const handleTabBarDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (!hasDragMime(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setTabDropIndex(index);
  }, []);

  const handleTabBarDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setTabDropIndex(null);
    setDropZone(null);
    const data = parseDragData(e);
    if (!data) return;

    if (data.paneId === paneId) {
      // Reorder within same pane
      const fromIdx = pane?.tabs.findIndex(t => t.id === data.tabId) ?? -1;
      if (fromIdx >= 0 && tabDropIndex !== null && fromIdx !== tabDropIndex) {
        reorderTab(paneId, fromIdx, tabDropIndex);
      }
    } else {
      // Move tab to this pane
      dropTabOnZone(data.paneId, data.tabId, paneId, 'center');
    }
  }, [parseDragData, paneId, pane?.tabs, tabDropIndex, reorderTab, dropTabOnZone]);

  const handleTabBarDragLeave = useCallback(() => {
    setTabDropIndex(null);
  }, []);

  const handleTabBarWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-terminal-tab]')) return;

    const tabBar = tabBarRef.current ?? e.currentTarget;
    const maxScrollLeft = tabBar.scrollWidth - tabBar.clientWidth;
    if (maxScrollLeft <= 0) return;

    const wheelDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (wheelDelta === 0) return;

    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tabBar.clientWidth : 1;
    e.preventDefault();
    e.stopPropagation();
    tabBar.scrollLeft += wheelDelta * unit;
  }, []);

  // Drop zone overlay style
  const dropOverlayStyle = (): React.CSSProperties | undefined => {
    if (!dropZone) return undefined;
    const base: React.CSSProperties = { position: 'absolute', pointerEvents: 'none', zIndex: 20, transition: 'all 0.1s ease' };
    const highlight = 'rgb(var(--accent-blue) / 0.15)';
    switch (dropZone) {
      case 'left':   return { ...base, top: 0, left: 0, bottom: 0, width: '50%', background: highlight };
      case 'right':  return { ...base, top: 0, right: 0, bottom: 0, width: '50%', background: highlight };
      case 'top':    return { ...base, top: 0, left: 0, right: 0, height: '50%', background: highlight };
      case 'bottom': return { ...base, bottom: 0, left: 0, right: 0, height: '50%', background: highlight };
      case 'center': return { ...base, top: 0, left: 0, right: 0, bottom: 0, background: highlight };
    }
  };

  if (!pane) return null;

  return (
    <div
      className="flex flex-col h-full min-h-0 relative"
      onMouseDown={() => setFocusedPane(paneId)}
    >
      {isFocused && <div className="absolute inset-x-0 top-0 h-px bg-border z-10 pointer-events-none" />}

      <div
        ref={tabBarRef}
        className="flex items-stretch shrink-0 bg-surface border-b border-border overflow-x-auto min-h-[28px]"
        onWheel={handleTabBarWheel}
        onDragOver={e => { if (hasDragMime(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } }}
        onDrop={handleTabBarDrop}
        onDragLeave={handleTabBarDragLeave}
      >
        {pane.tabs.map((tab, idx) => {
          const ch = channels.find(c => c.id === tab.channelId);
          const isActive = isFocused && tab.id === pane.activeTabId;
          const isEditing = tab.id === editingTabId;
          const isDragInsert = tabDropIndex === idx;
          const isFloatingTerminal = !tab.isPinned && tab.channelId === null;
          return (
            <button
              key={tab.id}
              data-terminal-tab
              draggable={!tab.isPinned && !isEditing}
              onDragStart={e => handleTabDragStart(tab.id, e)}
              onDragEnd={e => handleTabDragEnd(tab.id, e)}
              onDragOver={e => handleTabBarDragOver(e, idx)}
              onClick={() => handleSelectTab(tab.id)}
              className={[
                'flex w-[84px] items-center justify-start px-2 relative text-[11px] font-mono shrink-0 border-r border-border transition-colors select-none group/tab',
                isActive
                  ? `bg-surface text-text-primary ${channelAccentClasses(ch?.type).tab}`
                  : 'text-text-muted hover:bg-[var(--layer-hover)] hover:text-text-primary',
                isDragInsert ? 'ring-1 ring-inset ring-accent-blue/50' : '',
              ].join(' ')}
            >
              <div className="flex items-center justify-start gap-1.5 min-w-0 max-w-[62px] w-full translate-y-[1px]">
                {!tab.isPinned && !isFloatingTerminal && (
                  <span className={`shrink-0 transition-colors duration-150 ${channelIconStateClass(ch?.type ?? '', ch?.state)}`}>
                    {ch ? channelIcon(ch.type) : <TerminalIcon size={12} />}
                  </span>
                )}
                
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editingLabel}
                    onChange={e => setEditingLabel(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    onBlur={confirmEditing}
                    onClick={e => e.stopPropagation()}
                    spellCheck={false}
                    className="w-full bg-surface border border-accent-blue/50 rounded-sm px-1 text-[11px] font-mono text-text-primary outline-none"
                    autoFocus
                  />
                ) : (
                  <span
                    className={`truncate text-left max-w-full ${tab.isPinned || isFloatingTerminal ? 'text-[10px] font-bold text-text-secondary tracking-wider text-center w-full terminal-tag-text' : 'channel-tag-text-offset'}`}
                    onDoubleClick={e => startEditing(tab.id, tab.label, e)}
                    title="Double-click to rename"
                  >
                    {tab.label}
                  </span>
                )}
              </div>

              <div className="absolute right-0.5 top-1/2 -translate-y-1/2 flex items-center pr-0.5">
                {!tab.isPinned && (
                  <span
                    role="button"
                    tabIndex={-1}
                    onClick={e => handleRemoveTab(tab.id, e)}
                    className="flex items-center justify-center w-4 h-4 rounded opacity-0 group-hover/tab:opacity-60 hover:!opacity-100 hover:bg-[var(--layer-active)] transition-all text-text-muted hover:text-text-primary"
                  >
                    <CloseIcon size={10} />
                  </span>
                )}
              </div>
            </button>
          );
        })}

        <button
          onClick={handleAddTab}
          className="flex items-center justify-center w-7 shrink-0 text-text-muted hover:text-text-primary hover:bg-[var(--layer-hover)] transition-colors"
          title="Add tab for active channel"
        >
          <PlusIcon size={11} />
        </button>

        <div className="flex-1" />

        {isFocused && (
          <>
            <button
              onClick={handlePopOut}
              className="flex items-center justify-center w-7 shrink-0 text-text-muted hover:text-text-primary hover:bg-[var(--layer-hover)] transition-colors border-l border-border"
              title="Pop out to separate window"
            >
              <PopOutIcon size={11} />
            </button>

            <button
              onClick={handleSplit}
              className="flex items-center justify-center w-7 shrink-0 text-text-muted hover:text-text-primary hover:bg-[var(--layer-hover)] transition-colors border-l border-border"
              title="Split pane"
            >
              <SplitIcon size={11} />
            </button>

            <button
              onClick={() => {
                toggleCommandsPanel(paneId);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setCommandsDialogAnchor({ top: rect.top, left: rect.right });
                setShowCommandsDialog(true);
              }}
              className={[
                'flex items-center justify-center w-7 shrink-0 hover:bg-[var(--layer-hover)] transition-colors border-l border-border',
                pane.showCommandsPanel ? `${toneClasses.prompt}` : 'text-text-muted hover:text-text-primary',
              ].join(' ')}
              title="Saved commands"
            >
              <BookmarkIcon size={11} />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 flex min-h-0">
        <div
          ref={dropRef}
          className="flex-1 relative min-h-0"
          onDragOver={handlePaneDragOver}
          onDragLeave={handlePaneDragLeave}
          onDrop={handlePaneDrop}
        >
          {dropZone && <div style={dropOverlayStyle()} />}
          <div
            ref={receiveRef}
            onScroll={handleReceiveScroll}
            onDragOver={handlePaneDragOver}
            onDragLeave={handlePaneDragLeave}
            onDrop={handlePaneDrop}
            className="absolute inset-0 overflow-y-auto bg-surface font-mono text-[12px] leading-relaxed p-2"
            onClick={handleReceiveClick}
            onContextMenu={handleReceiveContextMenu}
          >
          {pane.entries.length === 0 ? (
            <div className="text-text-muted italic px-1 select-none">
              {linkedChannel
                ? `Linked: ${linkedChannel.name} — waiting for data…`
                : 'No channel linked. Type /link <name> or click + to add a tab.'}
            </div>
          ) : (
            pane.entries.map(entry => (
              <div key={entry.id} className="whitespace-pre-wrap break-all">
                {renderEntryContent(entry)}
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
              value={pane.cmdInput}
              onChange={e => setCmdInput(paneId, e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={pane.selectMode
                ? 'Enter number to select characteristic…'
                : linkedChannel
                  ? "hex: 01 02 FF   'ASCII'   \"ASCII+NUL\"   /help"
                  : '/link <channel-name>'}
              className={`flex-1 bg-transparent font-mono text-[12px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted/40 ${toneClasses.caret}`}
            />
          </div>
          </div>
        </div>

        {pane.showCommandsPanel && (
          <>
            <ResizeHandle onResize={handleCommandsPanelResize} />
            <div style={{ width: commandsPanelWidth }} className="min-w-[160px] max-w-[600px] border-l border-border flex flex-col min-h-0 overflow-hidden bg-surface shrink-0">
              <PanelErrorBoundary>
                <SavedCommandsPanel paneId={paneId} />
              </PanelErrorBoundary>
            </div>
          </>
        )}
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

      <SavedCommandsDialog
        open={showCommandsDialog}
        onClose={closeCommandsDialog}
        anchorPosition={commandsDialogAnchor}
        tagId={commandsTagId}
      />
    </div>
  );
};
