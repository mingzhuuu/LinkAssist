import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { isRemoteWorkspace, useRemoteStore } from '../../stores/remoteStore';
import { endRemoteWorkspace, flushRemoteLayout, remoteChannelAction } from '../../lib/remoteClient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_SERIAL_CONFIG, DEFAULT_TCP_CONFIG, useBleStore, useChannelStore, useSerialStore, useTcpStore, useUIStore } from '../../stores';
import { useBle, useSerial, useTcp } from '../../hooks';
import { ChannelSelectionCircle } from '../common/ChannelSelectionCircle';
import {
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
} from '../common/Icons';

const CHANNEL_BUTTON_UNSELECTED_COLOR = 'rgb(var(--text-muted) / 35%)';
const CHANNEL_TYPE_COLORS = {
  ble: { r: 91, g: 155, b: 245 },
  serial: { r: 167, g: 139, b: 250 },
  tcp: { r: 74, g: 222, b: 128 },
} as const;

const clampColor = (value: number) => Math.max(0, Math.min(255, Math.round(value)));

const toChannelColor = (channelType: keyof typeof CHANNEL_TYPE_COLORS) => {
  const color = CHANNEL_TYPE_COLORS[channelType];
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
};

const toMixedChannelColor = (channelTypes: Array<keyof typeof CHANNEL_TYPE_COLORS>) => {
  if (channelTypes.length === 0) return null;

  const counts = channelTypes.reduce<Record<keyof typeof CHANNEL_TYPE_COLORS, number>>(
    (result, type) => ({ ...result, [type]: result[type] + 1 }),
    { ble: 0, serial: 0, tcp: 0 }
  );
  const dominantType = (Object.keys(counts) as Array<keyof typeof CHANNEL_TYPE_COLORS>).reduce((best, type) => (
    counts[type] > counts[best] ? type : best
  ), 'ble');
  const dominantRatio = counts[dominantType] / channelTypes.length;
  const total = channelTypes.reduce(
    (sum, type) => {
      const color = CHANNEL_TYPE_COLORS[type];
      return {
        r: sum.r + color.r,
        g: sum.g + color.g,
        b: sum.b + color.b,
      };
    },
    { r: 0, g: 0, b: 0 }
  );
  const average = {
    r: total.r / channelTypes.length,
    g: total.g / channelTypes.length,
    b: total.b / channelTypes.length,
  };
  const dominantColor = CHANNEL_TYPE_COLORS[dominantType];
  const dominanceBoost = Math.max(0, dominantRatio - (1 / Object.keys(CHANNEL_TYPE_COLORS).length));
  const dominantBlend = Math.min(0.55, dominanceBoost * 0.9);
  const shade = 1 - dominanceBoost * 0.18;
  const mixed = {
    r: (average.r * (1 - dominantBlend) + dominantColor.r * dominantBlend) * shade,
    g: (average.g * (1 - dominantBlend) + dominantColor.g * dominantBlend) * shade,
    b: (average.b * (1 - dominantBlend) + dominantColor.b * dominantBlend) * shade,
  };

  return `rgb(${clampColor(mixed.r)}, ${clampColor(mixed.g)}, ${clampColor(mixed.b)})`;
};

export const ChannelQuickOpenButton: React.FC = () => {
  const channelPickerButtonRef = useRef<HTMLButtonElement>(null);
  const channelPickerRef = useRef<HTMLDivElement>(null);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [channelPickerPos, setChannelPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [channelButtonTooltip, setChannelButtonTooltip] = useState<{ x: number; y: number } | null>(null);
  const { channels } = useChannelStore();
  const { channelQuickOpenSelectedIds: selectedChannelIds, setChannelQuickOpenSelectedIds } = useUIStore();
  const { openPort, closePort } = useSerial();
  const { reconnectLastDevice, disconnectDevice } = useBle();
  const { connectTcp, disconnectTcp, startServer, stopServer, bindUdp, unbindUdp } = useTcp();

  useEffect(() => {
    const validIds = selectedChannelIds.filter((id) => channels.some((channel) => channel.id === id));
    if (validIds.length !== selectedChannelIds.length) {
      setChannelQuickOpenSelectedIds(validIds);
    }
  }, [channels, selectedChannelIds, setChannelQuickOpenSelectedIds]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        channelPickerOpen &&
        channelPickerRef.current &&
        !channelPickerRef.current.contains(event.target as Node) &&
        channelPickerButtonRef.current &&
        !channelPickerButtonRef.current.contains(event.target as Node)
      ) {
        setChannelPickerOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [channelPickerOpen]);

  const openChannelPicker = useCallback(() => {
    const rect = channelPickerButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setChannelPickerPos({
        top: rect.bottom + 8,
        left: Math.max(rect.left, 8),
      });
    }
    setChannelPickerOpen(true);
    setChannelButtonTooltip(null);
  }, []);

  const toggleChannelSelection = useCallback((channelId: string) => {
    setChannelQuickOpenSelectedIds(
      selectedChannelIds.includes(channelId)
        ? selectedChannelIds.filter((id) => id !== channelId)
        : [...selectedChannelIds, channelId]
    );
  }, [selectedChannelIds, setChannelQuickOpenSelectedIds]);

  const connectSelectedChannel = useCallback(async (channelId: string) => {
    const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
    if (!channel || channel.state === 'connected' || channel.state === 'connecting') return;
    if (isRemoteWorkspace()) { await remoteChannelAction('channel.connect', channelId).catch(() => {}); return; }

    try {
      if (channel.type === 'serial') {
        const serialState = useSerialStore.getState();
        const config = serialState.channelConfigs[channelId] ?? serialState.activeConfig ?? DEFAULT_SERIAL_CONFIG;
        if (!config.path) return;
        await openPort(config, channelId);
        return;
      }

      if (channel.type === 'ble') {
        await reconnectLastDevice(channelId);
        return;
      }

      if (channel.type === 'tcp') {
        const config = useTcpStore.getState().channelConfigs[channelId] ?? DEFAULT_TCP_CONFIG;
        if (config.mode === 'client') {
          await connectTcp(config.clientAddress, channelId);
        } else if (config.mode === 'server') {
          await startServer(config.serverAddress, channelId);
        } else {
          await bindUdp(config.udpBindAddress, channelId);
        }
      }
    } catch (error) {
      console.error('Error opening selected channel connection:', error);
    }
  }, [bindUdp, connectTcp, openPort, reconnectLastDevice, startServer]);

  const disconnectSelectedChannel = useCallback(async (channelId: string) => {
    const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
    if (!channel || channel.state !== 'connected') return;
    if (isRemoteWorkspace()) { await remoteChannelAction('channel.disconnect', channelId).catch(() => {}); return; }

    try {
      if (channel.type === 'serial') {
        const connectionId = Object.entries(useSerialStore.getState().connectionMap)
          .find(([, mappedChannelId]) => mappedChannelId === channelId)?.[0];
        if (connectionId) {
          await closePort(connectionId, channelId);
        }
        return;
      }

      if (channel.type === 'ble') {
        const deviceId = useBleStore.getState().getConnectedDeviceIdForChannel(channelId);
        if (deviceId) {
          await disconnectDevice(deviceId, channelId);
        }
        return;
      }

      if (channel.type === 'tcp') {
        const tcpState = useTcpStore.getState();
        const clientConnectionId = Object.entries(tcpState.connectionMap)
          .find(([connectionId, mappedChannelId]) => mappedChannelId === channelId && !connectionId.startsWith('server:') && !connectionId.startsWith('udp:'))?.[0];
        if (clientConnectionId) {
          await disconnectTcp(clientConnectionId, channelId);
          return;
        }

        const serverConnectionId = Object.entries(tcpState.connectionMap)
          .find(([connectionId, mappedChannelId]) => mappedChannelId === channelId && connectionId.startsWith('server:'))?.[0];
        if (serverConnectionId) {
          await stopServer(channelId);
          return;
        }

        const udpConnectionId = Object.entries(tcpState.connectionMap)
          .find(([connectionId, mappedChannelId]) => mappedChannelId === channelId && connectionId.startsWith('udp:'))?.[0];
        if (udpConnectionId) {
          await unbindUdp(channelId);
        }
      }
    } catch (error) {
      console.error('Error closing selected channel connection:', error);
    }
  }, [closePort, disconnectDevice, disconnectTcp, stopServer, unbindUdp]);

  const selectedChannelsHaveOpenConnection = useCallback(() => {
    if (selectedChannelIds.length === 0) return false;

    return selectedChannelIds.some((channelId) => {
      const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
      return channel?.state === 'connected' || channel?.state === 'connecting';
    });
  }, [selectedChannelIds]);

  const selectedChannelTypes = selectedChannelIds.flatMap((channelId) => {
    const channel = channels.find((item) => item.id === channelId);
    return channel ? [channel.type] : [];
  });
  const openSelectedChannelTypes = selectedChannelIds.flatMap((channelId) => {
    const channel = channels.find((item) => item.id === channelId);
    if (!channel || (channel.state !== 'connected' && channel.state !== 'connecting')) return [];
    return [channel.type];
  });
  const mixedOpenColor = toMixedChannelColor(openSelectedChannelTypes);
  const mixedSelectedColor = toMixedChannelColor(selectedChannelTypes);
  const channelButtonShadow = mixedOpenColor
    ? `0 0 14px ${mixedOpenColor}55`
    : '0 1px 4px rgba(0, 0, 0, 0.2)';

  const closeSelectedChannels = useCallback(() => {
    if (selectedChannelIds.length === 0) return;

    for (const channelId of selectedChannelIds) {
      void disconnectSelectedChannel(channelId);
    }

    setChannelPickerOpen(false);
  }, [disconnectSelectedChannel, selectedChannelIds]);

  const toggleSelectedChannels = useCallback(() => {
    if (selectedChannelIds.length === 0) {
      openChannelPicker();
      return;
    }

    if (selectedChannelsHaveOpenConnection()) {
      closeSelectedChannels();
      return;
    }

    for (const channelId of selectedChannelIds) {
      const channel = useChannelStore.getState().channels.find((item) => item.id === channelId);
      if (!channel) continue;

      void connectSelectedChannel(channel.id);
    }

    setChannelPickerOpen(false);
  }, [closeSelectedChannels, connectSelectedChannel, openChannelPicker, selectedChannelIds, selectedChannelsHaveOpenConnection]);

  return (
    <>
      <button
        ref={channelPickerButtonRef}
        className="h-3.5 w-3.5 translate-y-0.5 rounded-full transition-all duration-150 hover:brightness-125"
        style={{ color: mixedOpenColor ?? mixedSelectedColor ?? undefined, boxShadow: channelButtonShadow }}
        aria-label="Open channels"
        onClick={toggleSelectedChannels}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (channelPickerOpen) {
            setChannelPickerOpen(false);
          } else {
            openChannelPicker();
          }
        }}
        onMouseEnter={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setChannelButtonTooltip({ x: rect.right + 10, y: rect.top + rect.height / 2 });
        }}
        onMouseLeave={() => setChannelButtonTooltip(null)}
      >
        <ChannelSelectionCircle selected={selectedChannelTypes.length} total={channels.length} filled={!!mixedOpenColor}
          unselectedColor={CHANNEL_BUTTON_UNSELECTED_COLOR} className="size-full" />
      </button>

      {channelButtonTooltip && !channelPickerOpen && (
        <div
          className="pointer-events-none fixed z-[75] -translate-y-1/2 animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-text-primary window-shadow-tooltip shadow-xl backdrop-blur-sm whitespace-nowrap"
          style={{ top: channelButtonTooltip.y, left: channelButtonTooltip.x }}
        >
          Left-click to open, right-click to choose
        </div>
      )}

      {channelPickerOpen && channelPickerPos && (
        <div
          ref={channelPickerRef}
          role="group"
          aria-label="Open channels"
          data-no-drag
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          className="animate-fade-in fixed z-[70] w-max overflow-hidden rounded-xl border border-border bg-surface-overlay window-shadow-popover backdrop-blur-sm"
          style={{ ...channelPickerPos, maxWidth: `calc(100vw - ${channelPickerPos.left + 8}px)` }}
        >
          <div className="max-h-72 overflow-y-auto p-1.5">
            {channels.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-text-muted">No channels created</div>
            ) : channels.map((channel) => {
              const selected = selectedChannelIds.includes(channel.id);
              const channelColor = toChannelColor(channel.type);

              return (
                <button
                  type="button"
                  key={channel.id}
                  role="checkbox"
                  aria-checked={selected}
                  onClick={() => toggleChannelSelection(channel.id)}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${selected ? 'text-text-primary' : 'text-text-secondary hover:bg-[var(--layer-selected)] hover:text-text-primary'}`}
                  style={selected ? { backgroundColor: `${channelColor.replace('rgb', 'rgba').replace(')', ', 0.12)')}` } : undefined}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${selected ? 'text-road' : 'border-border bg-surface-tertiary'}`}
                    style={selected ? { backgroundColor: channelColor, borderColor: channelColor } : undefined}
                  >
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                  </span>
                  <span className="shrink-0 text-text-muted">{channel.type.toUpperCase()}</span>
                  <span className="min-w-0 truncate" title={channel.name}>{channel.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

/** The rest of the title bar: drag region + window controls */
interface TitleBarContentProps {
  isMaximized: boolean;
  onToggleMaximize: () => void | Promise<void>;
}

export const TitleBarContent: React.FC<TitleBarContentProps> = ({
  isMaximized,
  onToggleMaximize,
}) => {
  const remote = useRemoteStore();
  const [disconnectPeer, setDisconnectPeer] = useState<{ name: string; id?: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState('');
  const disconnectDialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!disconnectPeer) return;
    const previous = document.activeElement;
    disconnectDialog.current?.querySelector('button')?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [disconnectPeer]);
  const disconnect = async () => {
    if (!disconnectPeer || disconnecting) return;
    setDisconnecting(true);
    try {
      if (disconnectPeer.id) {
        if (useRemoteStore.getState().controller?.id === disconnectPeer.id) await invoke('remote_enable', { enabled: false });
      } else {
        await flushRemoteLayout();
        await invoke('remote_disconnect');
        endRemoteWorkspace();
      }
      setDisconnectPeer(null);
    } catch (error) { setDisconnectError(String(error)); }
    finally { setDisconnecting(false); }
  };
  const appWindow = getCurrentWindow();

  const handleMinimize = useCallback(() => {
    appWindow.minimize();
  }, [appWindow]);

  const handleClose = useCallback(() => {
    appWindow.close();
  }, [appWindow]);

  return (
    <>
      {/* Center: Drag region */}
      <div className="flex min-w-0 flex-1 h-full items-center select-none">
        {(remote.active || remote.controller) && <button data-no-drag
          className={`min-w-0 truncate rounded px-3 py-1 text-xs hover:bg-[var(--layer-hover)] focus-visible:outline focus-visible:outline-1 ${remote.active ? 'text-accent-green' : 'text-accent-blue'}`}
          title={remote.active ? remote.name : remote.controller?.name}
          onMouseDown={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
          onClick={() => { setDisconnectError(''); setDisconnectPeer(remote.active ? { name: remote.name } : remote.controller); }}>
          {remote.active ? remote.name : remote.controller?.name}
        </button>}
      </div>

      {disconnectPeer && createPortal(<div data-no-drag className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/40 p-4" onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <div ref={disconnectDialog} role="dialog" aria-modal="true" aria-labelledby="disconnect-title" className="w-full max-w-md rounded-2xl border border-border bg-surface-overlay p-5 text-sm text-text-primary window-shadow-dialog-sm" onKeyDown={event => {
          if (event.key === 'Escape' && !disconnecting) setDisconnectPeer(null);
          if (event.key === 'Tab') {
            const buttons = [...(disconnectDialog.current?.querySelectorAll('button') ?? [])];
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1]?.focus(); }
            else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0]?.focus(); }
          }
        }}>
          <h2 id="disconnect-title" className="font-semibold">Disconnect remote device?</h2>
          <p className="mt-3 break-words text-text-secondary">Disconnect from {disconnectPeer.name}?</p>
          {disconnectError && <p role="alert" className="mt-3 text-accent-red">{disconnectError}</p>}
          <div className="mt-5 flex justify-end gap-2" aria-busy={disconnecting}>
            <button className="btn-channel-action px-3" aria-disabled={disconnecting} onClick={() => { if (!disconnecting) setDisconnectPeer(null); }}>Cancel</button>
            <button className="btn-channel-action px-3" aria-disabled={disconnecting} onClick={() => void disconnect()}>Disconnect</button>
          </div>
        </div>
      </div>, document.body)}

      {/* Right: Window controls */}
      <div className="flex items-center h-full shrink-0">
        <button className="window-control main-window-control ml-2 w-10 hover:bg-[var(--layer-selected)]" onClick={handleMinimize}>
          <MinimizeIcon size={14} />
        </button>
        <button className="window-control main-window-control w-10 hover:bg-[var(--layer-selected)]" onClick={onToggleMaximize}>
          {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
        <button className="window-control main-window-control window-control-close w-10" onClick={handleClose}>
          <CloseIcon size={14} />
        </button>
      </div>

    </>
  );
};
