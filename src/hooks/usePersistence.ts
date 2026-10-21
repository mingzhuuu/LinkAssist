import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, PhysicalPosition, PhysicalSize } from '@tauri-apps/api/window';
import { LEFT_PANEL_MIN_WIDTH, useChannelStore, useUIStore, useProtocolStore, useBleStore, useSerialStore, useTcpStore, useTerminalStore, useCommandStore, useCanvasStore, useMcpStore, normalizeSerialConfig } from '../stores';
import { ChannelType, ParserMode, normalizeMcpToolsConfig, getPersistedMcpToolsConfig } from '../types';
import { normalizeFileDialogDirs, isTerminalDataFormat, normalizeTerminalChannelSettings, isTerminalLayoutSnapshot, isLastConnectedBleDevice } from '../lib';
import type { AppConfig, WindowStateEntry } from '../types';
import type { TerminalChannelSettings, ThemeMode } from '../stores/uiStore';
import { normalizeBleUuidNames } from '../stores/bleStore';
import type { BleFilterSettings } from '../stores/bleStore';
import type { TcpChannelConfig } from '../stores/tcpStore';
import type { CommandSet } from '../stores/commandStore';
import { validateCanvases } from '../lib/layoutValidation';
import { terminalLayoutChanged } from '../lib/terminalLayoutChange';

const LEGACY_COLLAPSED_LEFT_PANEL_WIDTHS: number[] = [32, 36, 38, 48];

interface SaveConfigOptions {
  captureWindowState?: boolean;
}

const CLOSE_SAVE_TIMEOUT_MS = 500;
const CLOSE_MODE_TIMEOUT_MS = 250;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function usePersistence() {
  const loadRunRef = useRef(0);
  const lastWindowStateRef = useRef<WindowStateEntry | null>(null);
  const destroyingWindowRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);

  const isDataViewMode = (mode: string): mode is 'text' | 'table' | 'image' => (
    mode === 'text' || mode === 'table' || mode === 'image'
  );

  useEffect(() => {
    const runId = loadRunRef.current + 1;
    loadRunRef.current = runId;
    let cancelled = false;
    const isCurrentRun = () => !cancelled && loadRunRef.current === runId;

    invoke<AppConfig>('load_app_config')
      .then(async (config) => {
        if (!isCurrentRun()) return;

        const rawPersistedChannels = config.channels ?? [];
        const uniqueChannelIds = new Set<string>();
        const persistedChannels = rawPersistedChannels.filter((channel) => {
          if (uniqueChannelIds.has(channel.id)) return false;
          uniqueChannelIds.add(channel.id);
          return true;
        });

        // Repair older configs that were polluted by append-style hydration.
        // Only later occurrences of an already restored channel ID are removed.
        if (persistedChannels.length !== rawPersistedChannels.length) {
          await invoke('save_app_config', {
            config: { ...config, channels: persistedChannels },
          }).catch((error) => {
            console.warn('Failed to repair duplicate persisted channels:', error);
          });
          if (!isCurrentRun()) return;
        }

        // Replace rather than append so remounts/Fast Refresh cannot duplicate
        // channels already held by the module-scoped Zustand store.
        useChannelStore.getState().restoreChannels(persistedChannels.map((ch) => ({
          id: ch.id,
          type: ch.channel_type as ChannelType,
          name: ch.name,
        })));

        useBleStore.getState().replaceCustomUuidNames(normalizeBleUuidNames(config.ble_uuid_names));

        // The first occurrence also owns the restored per-channel settings.
        persistedChannels.forEach((ch) => {
          const channelId = ch.id;

          if (ch.settings && Object.keys(ch.settings).length > 0) {
            if (ch.channel_type === 'ble') {
              const lastDeviceId = ch.settings.lastConnectedDeviceId;
              const lastDevice = ch.settings.lastConnectedDevice;
              const { lastConnectedDeviceId: _lastConnectedDeviceId, lastConnectedDevice: _lastConnectedDevice, ...filterSettings } = ch.settings;
              useBleStore.getState().setBleFilters(channelId, filterSettings as unknown as Partial<BleFilterSettings>);
              if (typeof lastDeviceId === 'string') {
                useBleStore.getState().setLastConnectedDeviceId(channelId, lastDeviceId);
              }
              if (isLastConnectedBleDevice(lastDevice)) {
                useBleStore.getState().setLastConnectedDevice(channelId, lastDevice);
              }
            } else if (ch.channel_type === 'serial') {
              useSerialStore.getState().setChannelConfig(channelId, normalizeSerialConfig(ch.settings));
            } else if (ch.channel_type === 'tcp') {
              useTcpStore.getState().setChannelConfig(channelId, ch.settings as unknown as Partial<TcpChannelConfig>);
            }
          }
        });

        // Restore UI settings
        if (config.ui) {
          const ui = useUIStore.getState();
          if (typeof config.ui.left_panel_width === 'number') {
            ui.setLeftPanelWidth(
              LEGACY_COLLAPSED_LEFT_PANEL_WIDTHS.includes(config.ui.left_panel_width)
                ? LEFT_PANEL_MIN_WIDTH
                : config.ui.left_panel_width
            );
          }
          if (typeof config.ui.center_panel_width === 'number') {
            ui.setCenterPanelWidth(config.ui.center_panel_width);
          } else if (typeof config.ui.right_panel_width === 'number') {
            ui.setCenterPanelWidth(Math.max(300, 1000 - config.ui.right_panel_width));
          }
          if (typeof config.ui.right_panel_width === 'number') ui.setRightPanelWidth(config.ui.right_panel_width);
          if (typeof config.ui.center_split_ratio === 'number') ui.setCenterSplitRatio(config.ui.center_split_ratio);
          if (typeof config.ui.center_top_visible === 'boolean') ui.setCenterTopVisible(config.ui.center_top_visible);
          if (typeof config.ui.center_bottom_visible === 'boolean') ui.setCenterBottomVisible(config.ui.center_bottom_visible);
          if (typeof config.ui.right_panel_visible === 'boolean') ui.setRightPanelVisible(config.ui.right_panel_visible);
          if (typeof config.ui.simple_mode === 'boolean') ui.setSimpleMode(config.ui.simple_mode);
          if (isDataViewMode(config.ui.data_view_mode)) ui.setDataViewMode(config.ui.data_view_mode);
          if (config.ui.theme_mode) ui.setThemeMode(config.ui.theme_mode as ThemeMode);
          if (config.ui.send_format && isTerminalDataFormat(config.ui.send_format)) ui.setSendFormat(config.ui.send_format);
          if (config.ui.receive_format && isTerminalDataFormat(config.ui.receive_format)) ui.setReceiveFormat(config.ui.receive_format);
          if (typeof config.ui.channel_panel_visible === 'boolean') ui.setChannelPanelVisible(config.ui.channel_panel_visible);
          if (typeof config.ui.show_input_prefix === 'boolean') ui.setShowInputPrefix(config.ui.show_input_prefix);
          if (typeof config.ui.show_timestamp === 'boolean') ui.setShowTimestamp(config.ui.show_timestamp);
          if (typeof config.ui.show_received === 'boolean') ui.setShowReceived(config.ui.show_received);
          const channelSettings = normalizeTerminalChannelSettings(config.ui.terminal_channel_settings);
          if (channelSettings) {
            ui.replaceTerminalChannelSettings(channelSettings);
          } else {
            const legacySettings: TerminalChannelSettings = {
              sendFormat: ui.sendFormat,
              receiveFormat: ui.receiveFormat,
              showInputPrefix: ui.showInputPrefix,
              showTimestamp: ui.showTimestamp,
            };
            ui.replaceTerminalChannelSettings(Object.fromEntries(
              useChannelStore.getState().channels.map((channel) => [channel.id, { ...legacySettings }])
            ));
          }
          if (isTerminalLayoutSnapshot(config.ui.terminal_layout)) {
            useTerminalStore.getState().restoreLayoutSnapshot(config.ui.terminal_layout);
          }
          if (typeof config.ui.restore_canvas_layout === 'boolean') {
            ui.setRestoreCanvasLayout(config.ui.restore_canvas_layout);
          }
          if (Array.isArray(config.ui.channel_quick_open_selected_ids)) {
            ui.setChannelQuickOpenSelectedIds(config.ui.channel_quick_open_selected_ids.filter((id): id is string => typeof id === 'string'));
          }
          if (config.ui.file_dialog_dirs) {
            const dirs = normalizeFileDialogDirs(config.ui.file_dialog_dirs);
            ui.setFileDialogDir('layout', dirs.layout);
            ui.setFileDialogDir('mcp', dirs.mcp);
            ui.setFileDialogDir('protocol', dirs.protocol);
            ui.setFileDialogDir('script', dirs.script);
          }
          if (typeof config.ui.active_channel_id === 'string') {
            const channelExists = useChannelStore.getState().channels.some((channel) => channel.id === config.ui.active_channel_id);
            if (channelExists) {
              useChannelStore.getState().setActiveChannel(config.ui.active_channel_id);
            }
          } else if (config.ui.active_channel_id === null) {
            useChannelStore.getState().setActiveChannel(null);
          }

          if (config.ui.window_state) {
            const appWindow = getCurrentWindow();
            const { x, y, width, height, maximized } = config.ui.window_state;

            // Validate saved state: Windows moves minimized windows to (-32000, -32000)
            // and may save collapsed sizes. Discard clearly invalid values.
            const minW = 1024;
            const minH = 680;
            const hasValidSize = typeof width === 'number' && typeof height === 'number'
              && width >= minW && height >= minH;
            const hasValidPosition = typeof x === 'number' && typeof y === 'number'
              && x > -10000 && y > -10000;

            if (hasValidSize) {
              await appWindow.setSize(new PhysicalSize(width, height)).catch(() => {});
            }

            if (!isCurrentRun()) return;

            if (hasValidPosition) {
              await appWindow.setPosition(new PhysicalPosition(x, y)).catch(() => {});
            }

            if (!isCurrentRun()) return;

            if (maximized) {
              await appWindow.maximize().catch(() => {});
            }

            if (!isCurrentRun()) return;

            // Only cache valid state for future saves
            if (hasValidSize && hasValidPosition) {
              lastWindowStateRef.current = config.ui.window_state;
            }
          }
        }

        // Restore protocol settings including linked channel
        if (config.protocol) {
          const proto = useProtocolStore.getState();
          proto.setMode(config.protocol.mode as ParserMode);
          if (config.protocol.lua_script) {
            proto.setLuaScript(config.protocol.lua_script);
          }
          if (config.protocol.linked_channel_id) {
            proto.setLinkedChannel(config.protocol.linked_channel_id);
            if (config.protocol.linked_service_uuid) {
              proto.setLinkedService(config.protocol.linked_service_uuid);
            }
            if (config.protocol.linked_char_uuid) {
              proto.setLinkedChar(config.protocol.linked_char_uuid);
            }
          }
        }

        if (config.saved_commands) {
          useCommandStore.getState().restoreSnapshot({
            commandSets: config.saved_commands.commandSets as Record<string, CommandSet>,
            expandedGroups: config.saved_commands.expandedGroups,
            savedConfigs: config.saved_commands.savedConfigs ?? {},
          });
        }

        const mcpToolsConfig = normalizeMcpToolsConfig(config.mcp_tools);
        if (mcpToolsConfig) {
          useMcpStore.getState().setEnabled(mcpToolsConfig.enabled);
          useMcpStore.getState().setScripts(mcpToolsConfig.scripts.map((script) => ({
            id: crypto.randomUUID(),
            luaPath: script.luaPath,
            exposeToMcp: script.exposeToMcp,
            protocolFile: script.protocolFile,
            protocolResourceRoot: script.protocolResourceRoot,
          })));
        }

        // Restore canvases
        if (
          config.canvases &&
          Array.isArray(config.canvases) &&
          config.canvases.length > 0 &&
          useUIStore.getState().restoreCanvasLayout !== false
        ) {
          useCanvasStore.getState().replaceCanvases(validateCanvases(config.canvases, false));
        }
      })
      .catch((e) => {
        if (isCurrentRun()) {
          console.warn('Failed to load config:', e);
        }
      })
      .finally(() => {
        // A hidden WebView may suspend animation frames indefinitely. Mark
        // hydration complete directly so a headless Core can later reveal this
        // already-loaded window when /ui/show is requested.
        if (isCurrentRun()) {
          setHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const saveConfig = useCallback(async ({ captureWindowState = true }: SaveConfigOptions = {}) => {
    const channels = useChannelStore.getState().channels.map((ch) => {
      let settings: Record<string, unknown> = {};
      if (ch.type === 'ble') {
        const bleState = useBleStore.getState();
        settings = {
          ...(bleState.bleFilters[ch.id] ?? {}),
          ...(bleState.lastConnectedDeviceIds[ch.id] ? { lastConnectedDeviceId: bleState.lastConnectedDeviceIds[ch.id] } : {}),
          ...(bleState.lastConnectedDevices[ch.id] ? { lastConnectedDevice: bleState.lastConnectedDevices[ch.id] } : {}),
        } as Record<string, unknown>;
      } else if (ch.type === 'serial') {
        settings = (useSerialStore.getState().channelConfigs[ch.id] ?? {}) as unknown as Record<string, unknown>;
      } else if (ch.type === 'tcp') {
        settings = (useTcpStore.getState().channelConfigs[ch.id] ?? {}) as unknown as Record<string, unknown>;
      }
      return {
        id: ch.id,
        name: ch.name,
        channel_type: ch.type,
        settings,
      };
    });

    const ui = useUIStore.getState();
    const proto = useProtocolStore.getState();
    const terminal = useTerminalStore.getState();
    const commandSnapshot = useCommandStore.getState().getSnapshot();
    let windowState = lastWindowStateRef.current;

    if (captureWindowState) {
      const appWindow = getCurrentWindow();
      const [position, size, maximized] = await Promise.all([
        appWindow.outerPosition().catch(() => null),
        appWindow.innerSize().catch(() => null),
        appWindow.isMaximized().catch(() => false),
      ]);

      const positionValid = position && position.x > -10000 && position.y > -10000;
      const sizeValid = size && size.width >= 1024 && size.height >= 680;

      if (positionValid && sizeValid && (!maximized || !windowState)) {
        windowState = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          maximized,
        };
      }

      if (windowState) {
        windowState = {
          ...windowState,
          maximized,
        };
        lastWindowStateRef.current = windowState;
      }
    }

    const config: AppConfig = {
      channels,
      ui: {
        left_panel_width: ui.leftPanelWidth,
        center_panel_width: ui.centerPanelWidth,
        right_panel_width: ui.rightPanelWidth,
        center_split_ratio: ui.centerSplitRatio,
        center_top_visible: ui.centerTopVisible,
        center_bottom_visible: ui.centerBottomVisible,
        right_panel_visible: ui.rightPanelVisible,
        simple_mode: ui.simpleMode,
        active_channel_id: useChannelStore.getState().activeChannelId,
        data_view_mode: ui.dataViewMode,
        theme_mode: ui.themeMode,
        send_format: ui.sendFormat,
        receive_format: ui.receiveFormat,
        channel_panel_visible: ui.channelPanelVisible,
        show_input_prefix: ui.showInputPrefix,
        show_timestamp: ui.showTimestamp,
        show_received: ui.showReceived,
        terminal_channel_settings: ui.terminalChannelSettings,
        window_state: windowState,
        terminal_layout: terminal.getLayoutSnapshot(),
        restore_canvas_layout: ui.restoreCanvasLayout,
        channel_quick_open_selected_ids: ui.channelQuickOpenSelectedIds,
        file_dialog_dirs: ui.fileDialogDirs,
      },
      protocol: {
        mode: proto.mode,
        field_definitions: proto.fieldDefinitions,
        lua_script: proto.luaScript,
        linked_channel_id: proto.linkedChannelId,
        linked_service_uuid: proto.linkedServiceUuid,
        linked_char_uuid: proto.linkedCharUuid,
      },
      saved_commands: commandSnapshot,
      canvases: useCanvasStore.getState().canvases,
      mcp_tools: getPersistedMcpToolsConfig(
        useMcpStore.getState().enabled,
        useMcpStore.getState().scripts,
      ),
      ble_uuid_names: useBleStore.getState().customUuidNames,
    };

    await invoke('save_app_config', { config });
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    let timeout: number | undefined;

    function scheduleSave() {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        saveConfig().catch((e) => {
          console.warn('Failed to save config:', e);
        });
      }, 300);
    }

    const unsubChannel = useChannelStore.subscribe(() => scheduleSave());
    const unsubUI = useUIStore.subscribe(() => scheduleSave());
    const unsubProtocol = useProtocolStore.subscribe(() => scheduleSave());
    // High-churn stores: only persisted slices may trigger a save. Live data
    // and scan results update these stores constantly, and the trailing
    // debounce would otherwise be reset forever while data streams in.
    const unsubBle = useBleStore.subscribe((state, prev) => {
      if (
        state.bleFilters !== prev.bleFilters
        || state.lastConnectedDeviceIds !== prev.lastConnectedDeviceIds
        || state.lastConnectedDevices !== prev.lastConnectedDevices
        || state.customUuidNames !== prev.customUuidNames
      ) {
        scheduleSave();
      }
    });
    const unsubSerial = useSerialStore.subscribe((state, prev) => {
      if (state.channelConfigs !== prev.channelConfigs) scheduleSave();
    });
    const unsubTcp = useTcpStore.subscribe((state, prev) => {
      if (state.channelConfigs !== prev.channelConfigs) scheduleSave();
    });
    const unsubTerminal = useTerminalStore.subscribe((state, previous) => {
      if (terminalLayoutChanged(state, previous)) scheduleSave();
    });
    const unsubCommand = useCommandStore.subscribe(() => scheduleSave());
    const unsubCanvas = useCanvasStore.subscribe((state, prev) => {
      if (state.canvases !== prev.canvases) scheduleSave();
    });
    const unsubMcp = useMcpStore.subscribe(() => scheduleSave());

    let closeUnlisten: (() => void) | null = null;
    let closeListenerCancelled = false;
    const appWindow = getCurrentWindow();

    appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (destroyingWindowRef.current) return;
      destroyingWindowRef.current = true;
      window.clearTimeout(timeout);

      try {
        await withTimeout(
          saveConfig({ captureWindowState: false }),
          CLOSE_SAVE_TIMEOUT_MS,
          'Timed out while saving config before close',
        );
      } catch (e) {
        console.warn('Failed to save config before close:', e);
      } finally {
        let launchMode: 'ui' | 'headless' = 'headless';
        try {
          launchMode = await withTimeout(
            invoke<'ui' | 'headless'>('get_launch_mode'),
            CLOSE_MODE_TIMEOUT_MS,
            'Timed out while resolving launch mode before close',
          );
        } catch (e) {
          console.warn('Failed to resolve launch mode before close:', e);
        }

        if (launchMode === 'ui') {
          try {
            await appWindow.destroy();
          } catch {
            destroyingWindowRef.current = false;
          }
        } else {
          await appWindow.hide().catch(() => {});
          destroyingWindowRef.current = false;
        }
      }
    })
      .then((unlisten) => {
        if (closeListenerCancelled) {
          unlisten();
        } else {
          closeUnlisten = unlisten;
        }
      })
      .catch((e) => {
        console.warn('Failed to listen for close requested:', e);
      });

    const handleBeforeUnload = () => {
      if (destroyingWindowRef.current) return;
      window.clearTimeout(timeout);
      saveConfig({ captureWindowState: false }).catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      closeListenerCancelled = true;
      closeUnlisten?.();
      window.clearTimeout(timeout);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unsubChannel();
      unsubUI();
      unsubProtocol();
      unsubBle();
      unsubSerial();
      unsubTcp();
      unsubTerminal();
      unsubCommand();
      unsubCanvas();
      unsubMcp();
    };
  }, [hydrated, saveConfig]);

  return hydrated;
}
