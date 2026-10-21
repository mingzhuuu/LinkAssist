import { useUIStore, useChannelStore, useTerminalStore, useCommandStore, useProtocolStore, useBleStore, useSerialStore, useTcpStore, useCanvasStore, useMcpStore, normalizeSerialConfig } from '../../stores';
import type { TerminalLayoutSnapshot } from '../../stores/terminalStore';
import type { CommandSet } from '../../stores/commandStore';
import type { ThemeMode, TerminalChannelSettings } from '../../stores/uiStore';
import type { BleFilterSettings } from '../../stores/bleStore';
import type { TcpChannelConfig } from '../../stores/tcpStore';
import type { ChannelType, ParserMode } from '../../types';
import { normalizeMcpToolsConfig } from '../../types';
import { parseLayoutImport } from '../../lib/layoutValidation';
import { normalizeTerminalChannelSettings } from '../../lib/persistenceValidation';
import { resolveLayoutPaths } from '../../lib/layoutPaths';

/** Missing sections preserve state; explicit empty arrays clear that section. */
export function importLayout(content: string, layoutFile?: string): void {
  const parsed = parseLayoutImport(content);
  const config = layoutFile ? resolveLayoutPaths(parsed, layoutFile) : parsed;
  // Validate references against retained channels when importing only part of a layout.
  const ids = new Set(config.channels?.map(c => c.id) ?? useChannelStore.getState().channels.map(c => c.id));
  for (const canvas of config.canvases ?? []) {
    for (const link of canvas.config.channels) {
      if (!ids.has(link.channelId)) throw new Error(`Unknown channel "${link.channelId}" in canvas "${canvas.name}"`);
    }
    // Importing a layout must not start device operations before the user reviews its scripts.
    if (canvas.config.script) canvas.config.script.autoRun = false;
    if (canvas.config.lifecycleScript) canvas.config.lifecycleScript.enabled = false;
  }
      // Clear existing channels first
      const existingIds = config.channels ? useChannelStore.getState().channels.map((c) => c.id) : [];
      for (const id of existingIds) {
        useChannelStore.getState().removeChannel(id);
      }

      // Restore channels
      if (config.channels && Array.isArray(config.channels)) {
        for (const ch of config.channels) {
          const channelId = useChannelStore.getState().addChannel(
            ch.channel_type as ChannelType,
            ch.name,
            ch.id,
          );
          if (ch.settings && Object.keys(ch.settings).length > 0) {
            if (ch.channel_type === 'ble') {
              useBleStore.getState().setBleFilters(channelId, ch.settings as unknown as Partial<BleFilterSettings>);
            } else if (ch.channel_type === 'serial') {
              useSerialStore.getState().setChannelConfig(channelId, normalizeSerialConfig(ch.settings));
            } else if (ch.channel_type === 'tcp') {
              useTcpStore.getState().setChannelConfig(channelId, ch.settings as unknown as Partial<TcpChannelConfig>);
            }
          }
        }
      }

      // Restore UI
      if (config.ui) {
        const ui = useUIStore.getState();
        const uiData = config.ui;
        if (typeof uiData.left_panel_width === 'number') ui.setLeftPanelWidth(uiData.left_panel_width);
        if (typeof (uiData as { center_panel_width?: number }).center_panel_width === 'number') {
          ui.setCenterPanelWidth((uiData as { center_panel_width: number }).center_panel_width);
        }
        if (typeof uiData.right_panel_width === 'number') ui.setRightPanelWidth(uiData.right_panel_width);
        if (typeof uiData.center_split_ratio === 'number') ui.setCenterSplitRatio(uiData.center_split_ratio);
        if (typeof uiData.center_top_visible === 'boolean') ui.setCenterTopVisible(uiData.center_top_visible);
        if (typeof uiData.center_bottom_visible === 'boolean') ui.setCenterBottomVisible(uiData.center_bottom_visible);
        if (typeof uiData.right_panel_visible === 'boolean') ui.setRightPanelVisible(uiData.right_panel_visible);
        if (typeof uiData.simple_mode === 'boolean') ui.setSimpleMode(uiData.simple_mode);
        const dvm = uiData.data_view_mode;
        if (dvm === 'text' || dvm === 'table' || dvm === 'image') ui.setDataViewMode(dvm);
        if (typeof uiData.theme_mode === 'string') ui.setThemeMode(uiData.theme_mode as ThemeMode);
        const sf = uiData.send_format;
        if (sf === 'ascii' || sf === 'hex') ui.setSendFormat(sf);
        const rf = uiData.receive_format;
        if (rf === 'ascii' || rf === 'hex') ui.setReceiveFormat(rf);
        if (typeof uiData.channel_panel_visible === 'boolean') ui.setChannelPanelVisible(uiData.channel_panel_visible);
        if (typeof uiData.show_input_prefix === 'boolean') ui.setShowInputPrefix(uiData.show_input_prefix);
        if (typeof uiData.show_timestamp === 'boolean') ui.setShowTimestamp(uiData.show_timestamp);
        if (typeof uiData.show_received === 'boolean') ui.setShowReceived(uiData.show_received);
        const terminalChannelSettings = normalizeTerminalChannelSettings(uiData.terminal_channel_settings);
        if (terminalChannelSettings) {
          ui.replaceTerminalChannelSettings(terminalChannelSettings);
        } else if (['send_format', 'receive_format', 'show_input_prefix', 'show_timestamp'].some(key => key in uiData)) {
          const currentUi = useUIStore.getState();
          const legacySettings: TerminalChannelSettings = {
            sendFormat: currentUi.sendFormat,
            receiveFormat: currentUi.receiveFormat,
            showInputPrefix: currentUi.showInputPrefix,
            showTimestamp: currentUi.showTimestamp,
          };
          ui.replaceTerminalChannelSettings(Object.fromEntries(
            useChannelStore.getState().channels.map((channel) => [channel.id, { ...legacySettings }])
          ));
        }
        if (typeof uiData.restore_canvas_layout === 'boolean') ui.setRestoreCanvasLayout(uiData.restore_canvas_layout);
        if (Array.isArray(uiData.channel_quick_open_selected_ids)) {
          ui.setChannelQuickOpenSelectedIds(uiData.channel_quick_open_selected_ids.filter((id): id is string => typeof id === 'string'));
        }
        if (typeof uiData.active_channel_id === 'string') {
          const channelExists = useChannelStore.getState().channels.some((channel) => channel.id === uiData.active_channel_id);
          if (channelExists) {
            useChannelStore.getState().setActiveChannel(uiData.active_channel_id);
          }
        } else if (uiData.active_channel_id === null) {
          useChannelStore.getState().setActiveChannel(null);
        }

        // Restore terminal layout
        const tl = uiData.terminal_layout;
        if (tl && typeof tl === 'object' && 'root' in (tl as object) && 'panes' in (tl as object)) {
          useTerminalStore.getState().restoreLayoutSnapshot(tl as TerminalLayoutSnapshot);
        }
      }

      // Restore protocol
      if (config.protocol) {
        const proto = useProtocolStore.getState();
        const pd = config.protocol;
        if (typeof pd.mode === 'string') proto.setMode(pd.mode as ParserMode);
        if (typeof pd.lua_script === 'string') proto.setLuaScript(pd.lua_script);
        if (typeof pd.linked_channel_id === 'string') {
          proto.setLinkedChannel(pd.linked_channel_id);
          if (typeof pd.linked_service_uuid === 'string') proto.setLinkedService(pd.linked_service_uuid);
          if (typeof pd.linked_char_uuid === 'string') proto.setLinkedChar(pd.linked_char_uuid);
        } else {
          proto.setLinkedChannel(null);
        }
      }

      // Restore saved commands
      if (config.saved_commands) {
        useCommandStore.getState().restoreSnapshot({
          commandSets: config.saved_commands.commandSets as Record<string, CommandSet>,
          expandedGroups: config.saved_commands.expandedGroups,
          savedConfigs: config.saved_commands.savedConfigs ?? {},
        });
      }

      if (config.canvases) useCanvasStore.getState().replaceCanvases(config.canvases);

      // Restore MCP tool scripts
      const mcpToolsConfig = normalizeMcpToolsConfig(config.mcp_tools);
      if (mcpToolsConfig) {
        useMcpStore.getState().setEnabled(false);
        useMcpStore.getState().setScripts(mcpToolsConfig.scripts.map((script) => ({
          id: crypto.randomUUID(),
          luaPath: script.luaPath,
          exposeToMcp: false,
          protocolFile: script.protocolFile,
          protocolResourceRoot: script.protocolResourceRoot,
        })));
      }
      useUIStore.getState().resetCanvasViewport();
}
