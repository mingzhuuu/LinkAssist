import React, { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useChannelStore, useProtocolStore, useBleStore, useTcpStore, useUIStore, toast } from '../../stores';
import { useTerminalStore, visibleTerminalEntries, receiveChannelsFor, DropZone } from '../../stores/terminalStore';
import { PlusIcon, BluetoothIcon, UsbIcon, WifiIcon, CloseIcon, SplitIcon, BookmarkIcon, PopOutIcon } from '../common/Icons';
import { ChannelSelectionCircle } from '../common/ChannelSelectionCircle';
import { detachTabToWindow } from '../../lib/detachWindow';
import { prepareTerminalNetworkSend, sendWithImmediateTxEcho } from '../../lib/terminalSend';
import { SavedCommandsPanel } from './SavedCommandsPanel';
import { SavedCommandsDialog } from './SavedCommandsDialog';
import { ResizeHandle } from './ResizeHandle';
import { resolveTerminalLink, useValidTerminalChannels, TerminalChannelPicker, terminalChannels, terminalTabColor, terminalTabLabel } from './TerminalChannels';
import { TerminalContextMenu } from './TerminalContextMenu';
import type { TerminalChannelSettings } from '../../stores/uiStore';
import { TerminalTabMenu } from './TerminalTabMenu';
import { buildBleWriteSelectionMenu, coalesceTerminalEntries, entryEndsWithLineBreak, formatBleUuid, formatInputTimestamp, formatTerminalEntryParts, formatTerminalEntryText, parseTerminalPayload, toHex } from './terminalUtils';
import { useInteractiveTerminalInput } from './InteractiveTerminal';

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

function channelIconStateClass(type: string, state: string, isActive: boolean) {
  if (state === 'connecting') return 'text-accent-yellow animate-pulse';
  if (state === 'error') return 'text-accent-red';
  if (isActive) return 'text-inherit';
  if (state !== 'connected') return 'text-text-faint';

  if (type === 'ble') return 'text-accent-blue';
  if (type === 'serial') return 'text-accent-mauve';
  return 'text-accent-green';
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
    configureTab,
    removeTab,
    selectPaneTab,
    splitPane,
    toggleCommandsPanel,
    reorderTab,
    dropTabOnZone,
  } = useTerminalStore.getState();

  const isFocused = focusedPaneId === paneId;

  const activeTab = pane?.tabs.find(t => t.id === pane.activeTabId);
  useValidTerminalChannels(paneId, pane?.tabs, channels);
  const selectedChannels = activeTab ? terminalChannels(activeTab, channels) : [];
  const connectedSelectedChannels = selectedChannels.filter(c => c.state === 'connected');
  const linkedChannel = selectedChannels.find(c => c.id === activeTab?.channelId)
    ?? (connectedSelectedChannels.length === 1 ? connectedSelectedChannels[0] : undefined);
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

  const prevChannelStateRef = useRef(linkedChannel?.state);
  useEffect(() => {
    if (prevChannelStateRef.current !== 'connected' && linkedChannel?.state === 'connected') {
      inputRef.current?.focus();
    }
    prevChannelStateRef.current = linkedChannel?.state;
  }, [linkedChannel?.state]);

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
        if (!activeTab) return;
        const result = resolveTerminalLink(activeTab, channels, args.join(' '));
        if (result.error) { appendEntry(paneId, 'system', result.error); return; }
        configureTab(paneId, activeTab.id, result.receive, result.target.id);
        setLinkedChannel(result.target.id);
        appendEntry(paneId, 'system', `Send target: ${result.target.name}`);
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
        const clients = tcpState.serverClients.filter(c => tcpState.connectionMap[c.id] === linkedChannel.id);
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
        const tcp = useTcpStore.getState();
        const clients = tcp.serverClients.filter(c => tcp.connectionMap[c.id] === linkedChannel.id);
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
          '/link <name|index>    — choose one send target for this tab',
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
  }, [activeTab, appendEntry, configureTab, channels, linkedChannel, linkedServiceUuid, linkedCharUuid, connectedDeviceId, addEntry, paneId, setLinkedChannel, setLinkedService, setLinkedChar, updateTerminalSettings, setShowReceived, showSelectMenu, clearEntries, setUdpTargetAddr, setSelectedTcpClient]);

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
      if (
        linkedChannel?.type === 'serial'
        && linkedChannel.state === 'connected'
        && !currentPane.selectMode
      ) {
        try {
          const send = prepareTerminalNetworkSend(linkedChannel, currentPane, [0x0d], message => addEntry('system', message));
          await send();
        } catch (error) {
          addEntry('system', `Send error: ${error}`);
        }
        setCmdInput(paneId, '');
        return;
      }
      addEntry('system', ' ');
      setCmdInput(paneId, '');
      return;
    }

    if (!linkedChannel && !raw.startsWith('/') && !currentPane.selectMode) {
      appendEntry(paneId, 'system', 'Use /link <channel-name-or-index> to select a send target.');
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
      if (linkedChannel.type !== 'ble') {
        const send = prepareTerminalNetworkSend(linkedChannel, currentPane, bytes, message => addEntry('system', message));
        await send();
      } else {
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
  }, [appendEntry, paneId, linkedChannel, connectedDeviceId, addEntry, processCommand, pushCmdHistory, setCmdInput, setSelectedWriteTarget, setSelectMode, showSelectMenu]);

  const historyIndexRef = useRef(-1);
  const {
    handleInteractiveKeyDown,
    handleInteractivePaste,
    handleInteractiveCompositionStart,
    handleInteractiveCompositionEnd,
    handleInteractiveBlur,
  } = useInteractiveTerminalInput({
    paneId,
    channelId: linkedChannel?.id ?? null,
    enabled: Boolean(terminalSettings.interactiveMode),
  });

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (handleInteractiveKeyDown(e)) {
      return;
    }
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
  }, [handleInteractiveKeyDown, handleSend, paneId, setCmdInput]);

  const renderInteractiveInputCursor = () => (
    <span
      data-testid="terminal-inline-cursor"
      className="inline-block w-[7px] h-[14px] translate-y-[2px] bg-accent-green animate-pulse select-none"
      aria-hidden="true"
    />
  );

  const renderEntryContent = (
    entry: { kind: 'rx' | 'tx' | 'system'; timestamp: number; text: string; data?: number[]; bleMetadata?: { serviceUuid: string; charUuid: string } },
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
    const payloadClass = entry.kind === 'rx' ? toneClasses.rx : toneClasses.tx;
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
  const inputPromptBase = visiblePromptText.endsWith('>')
    ? visiblePromptText.slice(0, -1)
    : visiblePromptText;

  const [channelPicker, setChannelPicker] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const pickerTab = pane?.tabs.find(tab => tab.id === channelPicker?.tabId);
  const [commandsDialogAnchor, setCommandsDialogAnchor] = useState<HTMLButtonElement | null>(null);
  const [commandsPanelWidth, setCommandsPanelWidth] = useState(280);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number } | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [hiddenTabIds, setHiddenTabIds] = useState<string[]>([]);
  const [tabMenuAnchor, setTabMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const closeTabMenu = useCallback(() => setTabMenuAnchor(null), []);

  useLayoutEffect(() => {
    const strip = tabBarRef.current;
    if (!strip || !pane) return;
    const tabs = Array.from(strip.querySelectorAll<HTMLButtonElement>('[data-terminal-tab]'));
    const measure = () => {
      // Reserve 28px for the trailing action button (+ when all tabs fit, or ⋯ when tabs overflow).
      let remaining = strip.clientWidth - 28;
      const visible = new Set<string>();
      // Keep the selected tab visible, then fill the remaining space in tab order.
      const active = tabs.find(tab => tab.dataset.terminalTab === pane.activeTabId);
      for (const tab of active ? [active, ...tabs.filter(tab => tab !== active)] : tabs) {
        const width = tab.getBoundingClientRect().width;
        if (width <= remaining && width > 0) {
          visible.add(tab.dataset.terminalTab!);
          remaining -= width;
        }
      }
      const hidden = tabs.map(tab => tab.dataset.terminalTab!).filter(id => !visible.has(id));
      setHiddenTabIds(previous => previous.length === hidden.length && previous.every((id, index) => id === hidden[index]) ? previous : hidden);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    tabs.forEach(tab => observer.observe(tab));
    return () => observer.disconnect();
  }, [pane?.tabs, pane?.activeTabId, channels]);

  const commandsTagId = activeTab?.channelId ?? activeChannelId ?? '__global_saved_commands__';

  const closeCommandsDialog = useCallback(() => {
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
    inputRef.current?.focus();
  }, [paneId, selectPaneTab, setFocusedPane]);

  const handleAddTab = useCallback(() => {
    const { activeChannelId: selectedId, channels: currentChannels } = useChannelStore.getState();
    if (!selectedId) {
      toast.error('No active channel selected — select a channel in the left panel first');
      return;
    }
    const channel = currentChannels.find(item => item.id === selectedId);
    if (!channel) {
      toast.error('Active channel not found');
      return;
    }
    setFocusedPane(paneId);
    addTab(paneId, channel.id, channel.name);
  }, [paneId, addTab, setFocusedPane]);

  const handleRemoveTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeTab(paneId, tabId);
  }, [paneId, removeTab]);

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
        tab: { ...tab, label: terminalTabLabel(terminalChannels(tab, channels), channels.length) },
        writeTarget: pane?.tabWriteTargets[tab.id], udpTargetAddr: pane?.udpTargetAddr,
        entries,
        channelType: ch?.type,
        terminalSettings: getTerminalSettingsForTab(tab),
      },
      e.screenX,
      e.screenY,
    );

    if (label) {
      removeTab(paneId, tabId);
    }
  }, [paneId, pane, channels, removeTab, getTerminalSettingsForTab]);

  const handlePopOut = useCallback(async () => {
    if (!activeTab || activeTab.isPinned) {
      toast.error('Cannot pop out the pinned terminal tab');
      return;
    }

    const ch = channels.find(c => c.id === activeTab.channelId);
    const entries = pane?.tabEntries[activeTab.id] ?? pane?.entries ?? [];

    const label = await detachTabToWindow(
      { tab: { ...activeTab, label: terminalTabLabel(terminalChannels(activeTab, channels), channels.length) }, writeTarget: pane?.selectedWriteTarget, udpTargetAddr: pane?.udpTargetAddr, entries, channelType: ch?.type, terminalSettings },
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
      className="flex flex-col h-full min-h-0 min-w-0 relative"
      onMouseDown={() => setFocusedPane(paneId)}
    >
      <div
        className="flex items-stretch shrink-0 min-w-0 bg-surface border-b border-border h-7"
        onDragOver={e => { if (hasDragMime(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; } }}
        onDrop={handleTabBarDrop}
        onDragLeave={handleTabBarDragLeave}
      >
        <div ref={tabBarRef} className="relative flex flex-1 min-w-0 overflow-hidden">
          {pane.tabs.map((tab, idx) => {
            const isActive = isFocused && tab.id === pane.activeTabId;
            const selected = terminalChannels(tab, channels);
            const label = terminalTabLabel(selected, channels.length);
            const ch = selected.length === 1 ? selected[0] : undefined;
            const isDragInsert = tabDropIndex === idx;
            const isGroupTab = !ch || selected.length === channels.length;
            return (
              <button
                key={tab.id}
                data-terminal-tab={tab.id}
                aria-hidden={hiddenTabIds.includes(tab.id) || undefined}
                tabIndex={hiddenTabIds.includes(tab.id) ? -1 : 0}
                aria-pressed={isActive}
                draggable={!tab.isPinned}
                onDragStart={e => handleTabDragStart(tab.id, e)}
                onDragEnd={e => handleTabDragEnd(tab.id, e)}
                onDragOver={e => handleTabBarDragOver(e, idx)}
                onClick={() => handleSelectTab(tab.id)}
                onContextMenu={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setChannelPicker({ tabId: tab.id, x: event.clientX, y: event.clientY });
                }}
                style={{
                  color: isActive ? terminalTabColor(selected) : undefined,
                  ...(hiddenTabIds.includes(tab.id) ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } as const : {}),
                }}
                className={[
                  'flex w-max min-w-[64px] max-w-[min(240px,calc(100%_-_28px))] h-full gap-1.5 items-center relative text-[11px] font-mono shrink-0 border-r border-border transition-colors select-none group/tab',
                  tab.isPinned ? 'px-2.5' : 'pl-2.5 pr-0.5',
                  'bg-surface',
                  isActive ? 'font-semibold text-text-primary' : 'text-text-muted hover:text-text-primary',
                  isDragInsert ? 'ring-1 ring-inset ring-accent-blue/50' : '',
                ].join(' ')}
              >
                {isGroupTab ? (
                  <ChannelSelectionCircle selected={selected.length} total={channels.length} className="size-2 shrink-0 translate-y-px" />
                ) : !tab.isPinned && ch && (
                  <span className={`shrink-0 translate-y-px transition-colors duration-150 ${channelIconStateClass(ch.type, ch.state, isActive)}`}>
                    {channelIcon(ch.type)}
                  </span>
                )}
                <span
                  className={`min-w-0 translate-y-[2px] truncate text-left ${isGroupTab || tab.isPinned ? 'text-[10px] tracking-wider' : ''}`}
                  title={label}
                >
                  {label}
                </span>

                {!tab.isPinned && (
                  <span
                    role="button"
                    aria-label={`Close ${label}`}
                    tabIndex={-1}
                    onClick={e => handleRemoveTab(tab.id, e)}
                    className="ml-auto flex shrink-0 translate-y-px items-center justify-center w-4 h-4 rounded opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100 hover:bg-[var(--layer-active)] transition-opacity text-text-muted hover:text-text-primary"
                  >
                    <CloseIcon size={10} />
                  </span>
                )}
              </button>
            );
          })}
          {hiddenTabIds.length === 0 ? (
            <button
              onClick={handleAddTab}
              className="flex items-center justify-center w-7 shrink-0 text-text-muted hover:text-text-primary hover:bg-[var(--layer-hover)] transition-colors"
              title="Add tab for active channel"
              aria-label="Add tab for active channel"
            >
              <PlusIcon size={11} />
            </button>
          ) : (
            <button
              onClick={event => setTabMenuAnchor(tabMenuAnchor ? null : event.currentTarget)}
              className="flex items-center justify-center w-7 shrink-0 text-text-muted hover:text-text-primary hover:bg-[var(--layer-hover)] transition-colors"
              title="More channels"
              aria-label="More channels"
              aria-haspopup="dialog"
              aria-expanded={!!tabMenuAnchor}
            >
              <span className="text-base leading-none" aria-hidden="true">⋯</span>
            </button>
          )}
        </div>

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
            setCommandsDialogAnchor(e.currentTarget);
          }}
          className={[
            'flex items-center justify-center w-7 shrink-0 hover:bg-[var(--layer-hover)] transition-colors border-l border-border',
            pane.showCommandsPanel ? `${toneClasses.prompt}` : 'text-text-muted hover:text-text-primary',
          ].join(' ')}
          title="Saved commands"
        >
          <BookmarkIcon size={11} />
        </button>
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
          {visibleEntries.length === 0 ? (
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
                {renderEntryContent(entry, index === visibleEntries.length - 1)}
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
              value={pane.cmdInput}
              onChange={e => {
                if (!terminalSettings.interactiveMode) {
                  setCmdInput(paneId, e.target.value);
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
              placeholder={pane.selectMode
                ? 'Enter number to select characteristic…'
                : linkedChannel
                  ? "hex: 01 02 FF   'ASCII'   \"ASCII+NUL\"   /help"
                  : '/link <channel-name-or-index>'}
              className={terminalSettings.interactiveMode
                ? 'w-0 h-0 opacity-0 outline-none border-0 p-0 m-0'
                : `flex-1 bg-transparent font-mono text-[12px] leading-relaxed text-text-primary outline-none placeholder:text-text-muted/40 ${toneClasses.caret}`}
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

      {tabMenuAnchor && hiddenTabIds.length > 0 && <TerminalTabMenu
        anchor={tabMenuAnchor}
        hiddenTabs={pane.tabs.filter(tab => hiddenTabIds.includes(tab.id))}
        channels={channels}
        onSelectTab={handleSelectTab}
        onAddTab={handleAddTab}
        onClose={closeTabMenu}
      />}
      {channelPicker && pickerTab && <TerminalChannelPicker {...channelPicker} paneId={paneId} tab={pickerTab} channels={channels} onClose={() => setChannelPicker(null)} />}
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

      {commandsDialogAnchor && (
        <SavedCommandsDialog
          onClose={closeCommandsDialog}
          anchor={commandsDialogAnchor}
          tagId={commandsTagId}
        />
      )}
    </div>
  );
};
