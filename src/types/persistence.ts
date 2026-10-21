import type { Canvas } from './canvas';
import type { McpToolsConfig } from './mcp';
import type { FileDialogDirectories } from '../lib/fileDialogPaths';
import type { TerminalChannelSettings } from '../stores/uiStore';
import type { BleUuidNames } from '../stores/bleStore';
import type { CommandGroup, SavedCommand, SavedConfig } from '../stores/commandStore';
import type { TerminalLayoutSnapshot } from '../stores/terminalStore';

/** Persisted JSON contract; mirror src-tauri/src/persistence.rs without renaming keys. */
export interface ChannelEntry {
  id: string;
  name: string;
  channel_type: string;
  settings: Record<string, unknown>;
}

export interface UiEntry {
  left_panel_width: number;
  center_panel_width?: number | null;
  right_panel_width: number;
  center_split_ratio: number;
  center_top_visible?: boolean;
  center_bottom_visible?: boolean;
  right_panel_visible?: boolean;
  simple_mode?: boolean;
  active_channel_id?: string | null;
  data_view_mode: string;
  theme_mode: string;
  send_format?: string;
  receive_format?: string;
  channel_panel_visible?: boolean;
  show_input_prefix?: boolean;
  show_timestamp?: boolean;
  show_received?: boolean;
  terminal_channel_settings?: Record<string, TerminalChannelSettings> | null;
  window_state?: WindowStateEntry | null;
  terminal_layout?: TerminalLayoutSnapshot | null;
  restore_canvas_layout?: boolean;
  channel_quick_open_selected_ids?: string[];
  file_dialog_dirs?: FileDialogDirectories;
}

export interface WindowStateEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface ProtocolEntry {
  mode: string;
  field_definitions: unknown;
  lua_script: string;
  linked_channel_id: string | null;
  linked_service_uuid: string | null;
  linked_char_uuid: string | null;
}

export interface AppConfig {
  channels: ChannelEntry[];
  ui: UiEntry;
  protocol: ProtocolEntry;
  saved_commands?: {
    commandSets: Record<string, { groups: CommandGroup[]; commands: SavedCommand[] }>;
    expandedGroups: Record<string, boolean>;
    savedConfigs?: Record<string, SavedConfig[]>;
  } | null;
  canvases?: Canvas[] | null;
  mcp_tools?: McpToolsConfig | null;
  ble_uuid_names?: BleUuidNames | null;
}

