import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DEFAULT_SERIAL_CONFIG, DEFAULT_TCP_CONFIG, useBleStore, useChannelStore, useSerialStore, useTcpStore, useUIStore } from '../../stores';
import { useBle, useSerial, useTcp } from '../../hooks';
import {
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  CloseIcon,
  SidebarIcon,
  RightPanelIcon,
} from '../common/Icons';

const CHANNEL_BUTTON_IDLE_BORDER_COLOR = 'var(--text-muted)';
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
        left: Math.min(Math.max(rect.left, 8), window.innerWidth - 248),
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

  const hasSelectedChannels = selectedChannelIds.length > 0;
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
  const channelButtonColor = mixedOpenColor ?? 'transparent';
  const channelButtonBorderColor = hasSelectedChannels
    ? mixedOpenColor ?? mixedSelectedColor ?? CHANNEL_BUTTON_IDLE_BORDER_COLOR
    : CHANNEL_BUTTON_IDLE_BORDER_COLOR;
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
        className="h-3.5 w-3.5 translate-y-0.5 rounded-full border transition-all duration-150 hover:brightness-125"
        style={{ backgroundColor: channelButtonColor, borderColor: channelButtonBorderColor ?? 'transparent', boxShadow: channelButtonShadow }}
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
      />

      {channelButtonTooltip && !channelPickerOpen && (
        <div
          className="pointer-events-none fixed z-[75] -translate-y-1/2 animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-text-primary shadow-xl shadow-black/30 backdrop-blur-sm whitespace-nowrap"
          style={{ top: channelButtonTooltip.y, left: channelButtonTooltip.x }}
        >
          Left-click to open, right-click to choose
        </div>
      )}

      {channelPickerOpen && channelPickerPos && (
        <div
          ref={channelPickerRef}
          data-no-drag
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          className="animate-fade-in fixed z-[70] w-60 overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{ top: channelPickerPos.top, left: channelPickerPos.left }}
        >
          <div className="border-b border-border px-3 py-2">
            <div className="text-xs font-semibold text-text-secondary">Open channels</div>
            <div className="mt-0.5 text-[10px] text-text-muted">Left-click the round button to open or close them.</div>
          </div>
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
                  <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
};

/** Combined center-panel toggle using the former channel-toggle appearance. */
export const TitleBarCenterToggle: React.FC = () => {
  const {
    centerTopVisible,
    centerBottomVisible,
    setCenterTopVisible,
    setCenterBottomVisible,
  } = useUIStore();
  const centerPanelsVisible = centerTopVisible || centerBottomVisible;

  const handleToggleCenterPanels = useCallback(() => {
    const nextVisible = !centerPanelsVisible;
    setCenterTopVisible(nextVisible);
    setCenterBottomVisible(nextVisible);
  }, [centerPanelsVisible, setCenterBottomVisible, setCenterTopVisible]);

  return (
    <button
      className="window-control main-window-control w-6 hover:bg-[var(--layer-selected)]"
      onClick={handleToggleCenterPanels}
      title={centerPanelsVisible ? 'Hide center panels' : 'Show center panels'}
    >
      <SidebarIcon size={14} />
    </button>
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
  const {
    rightPanelVisible,
    toggleRightPanelVisible,
    simpleMode,
  } = useUIStore();
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
      <div className="flex-1 h-full select-none" />

      {/* Right: Window controls */}
      <div className="flex items-center h-full shrink-0">
        {!simpleMode && (
          <>
            <TitleBarCenterToggle />
            <button
              className="window-control main-window-control w-6 hover:bg-[var(--layer-selected)]"
              onClick={toggleRightPanelVisible}
              title={rightPanelVisible ? 'Hide right panel' : 'Show right panel'}
            >
              <RightPanelIcon size={14} className={rightPanelVisible ? '' : 'opacity-55'} />
            </button>
          </>
        )}
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
