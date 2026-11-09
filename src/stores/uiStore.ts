import type { UiEntry } from '../types/persistence';
import { create } from 'zustand';
import type { FileDialogDirectories, FileDialogDirectoryKind } from '../lib';
import { DEFAULT_FILE_DIALOG_DIRS } from '../lib';

export type ThemeMode = 'dark' | 'light' | 'system' | 'high-contrast' | 'high-contrast-light';
export type TerminalDataFormat = 'ascii' | 'hex';
export type SendFormat = TerminalDataFormat;

export const LEFT_PANEL_MIN_WIDTH = 40;
export const LEFT_PANEL_MAX_WIDTH = 150;
export const CENTER_PANEL_MIN_WIDTH = 300;
export const CENTER_PANEL_DEFAULT_WIDTH = 670;

const clampLeftPanelWidth = (width: number) => (
  Math.min(LEFT_PANEL_MAX_WIDTH, Math.max(LEFT_PANEL_MIN_WIDTH, width))
);

const clampCenterPanelWidth = (width: number) => Math.max(CENTER_PANEL_MIN_WIDTH, width);

export interface TerminalChannelSettings {
  /** Missing in older configurations; defaults to OFF. */
  interactiveMode?: boolean;
  sendFormat: TerminalDataFormat;
  receiveFormat: TerminalDataFormat;
  showInputPrefix: boolean;
  showTimestamp: boolean;
}

type DataViewMode = 'text' | 'table' | 'chart';
type LegacyDataViewMode = DataViewMode | 'image';

interface UIStore {
  closeBehavior: 'exit' | 'background' | null;
  leftPanelWidth: number;
  centerPanelWidth: number;
  rightPanelWidth: number;
  centerSplitRatio: number;
  centerTopVisible: boolean;
  /** Temporary channel settings overlay; never saved to the layout. */
  channelConfigPreview: boolean;
  centerBottomVisible: boolean;
  rightPanelVisible: boolean;
  dataViewMode: DataViewMode;
  showAddChannelMenu: boolean;
  themeMode: ThemeMode;
  sendFormat: SendFormat;
  receiveFormat: TerminalDataFormat;
  channelPanelVisible: boolean;
  showInputPrefix: boolean;
  showTimestamp: boolean;
  showReceived: boolean;
  terminalChannelSettings: Record<string, TerminalChannelSettings>;
  restoreCanvasLayout: boolean;
  channelQuickOpenSelectedIds: string[];
  fileDialogDirs: FileDialogDirectories;
  /** Non-persisted signal used to rebase canvas coordinates after a layout replacement. */
  canvasViewportResetVersion: number;
  setLeftPanelWidth: (width: number) => void;
  setCenterPanelWidth: (width: number) => void;
  setRightPanelWidth: (width: number) => void;
  setCenterSplitRatio: (ratio: number) => void;
  restorePanelVisibility: (ui: Partial<UiEntry>) => void;
  setCenterTopVisible: (visible: boolean) => void;
  openChannelConfig: () => void;
  closeChannelConfig: () => void;
  setCenterBottomVisible: (visible: boolean) => void;
  setRightPanelVisible: (visible: boolean) => void;
  setDataViewMode: (mode: LegacyDataViewMode) => void;
  setShowAddChannelMenu: (show: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setSendFormat: (format: SendFormat) => void;
  setReceiveFormat: (format: TerminalDataFormat) => void;
  setChannelPanelVisible: (visible: boolean) => void;
  setShowInputPrefix: (show: boolean) => void;
  setShowTimestamp: (show: boolean) => void;
  setShowReceived: (show: boolean) => void;
  setTerminalChannelSettings: (channelId: string, settings: TerminalChannelSettings) => void;
  replaceTerminalChannelSettings: (settings: Record<string, TerminalChannelSettings>) => void;
  setRestoreCanvasLayout: (restore: boolean) => void;
  setChannelQuickOpenSelectedIds: (ids: string[]) => void;
  setFileDialogDir: (kind: FileDialogDirectoryKind, directory: string) => void;
  resetCanvasViewport: () => void;
  toggleChannelPanel: () => void;
  toggleCenterTopVisible: () => void;
  toggleCenterBottomVisible: () => void;
  toggleRightPanelVisible: () => void;
}

const THEME_MODES: ThemeMode[] = ['dark', 'light', 'system', 'high-contrast', 'high-contrast-light'];

/**
 * Detached windows do not run persistence, so they receive the current theme
 * via the `?theme=` query param and initialize the store from it. The main
 * window has no such param and falls back to 'light' until persistence loads.
 */
function getInitialThemeMode(): ThemeMode {
  try {
    const theme = new URLSearchParams(window.location.search).get('theme');
    if (theme && (THEME_MODES as string[]).includes(theme)) {
      return theme as ThemeMode;
    }
  } catch {
    /* noop */
  }
  return 'light';
}

export const useUIStore = create<UIStore>((set) => ({
  closeBehavior: null,
  leftPanelWidth: LEFT_PANEL_MIN_WIDTH,
  centerPanelWidth: CENTER_PANEL_DEFAULT_WIDTH,
  rightPanelWidth: 444,
  centerSplitRatio: 0.5,
  centerTopVisible: true,
  channelConfigPreview: false,
  centerBottomVisible: true,
  rightPanelVisible: true,
  dataViewMode: 'text',
  showAddChannelMenu: false,
  themeMode: getInitialThemeMode(),
  sendFormat: 'ascii',
  receiveFormat: 'hex',
  channelPanelVisible: true,
  showInputPrefix: true,
  showTimestamp: false,
  showReceived: true,
  terminalChannelSettings: {},
  restoreCanvasLayout: true,
  channelQuickOpenSelectedIds: [],
  fileDialogDirs: { ...DEFAULT_FILE_DIALOG_DIRS },
  canvasViewportResetVersion: 0,
  setLeftPanelWidth: (width) => set({ leftPanelWidth: clampLeftPanelWidth(width) }),
  setCenterPanelWidth: (width) => set({ centerPanelWidth: clampCenterPanelWidth(width) }),
  setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
  setCenterSplitRatio: (ratio) => set({ centerSplitRatio: ratio }),
  restorePanelVisibility: (ui) => set((state) => {
    if (ui.simple_mode === true) {
      return { rightPanelVisible: true, centerTopVisible: false, centerBottomVisible: false, channelPanelVisible: false, channelConfigPreview: false };
    }
    return {
      rightPanelVisible: typeof ui.right_panel_visible === 'boolean' ? ui.right_panel_visible : state.rightPanelVisible,
      centerTopVisible: typeof ui.center_top_visible === 'boolean' ? ui.center_top_visible : state.centerTopVisible,
      centerBottomVisible: typeof ui.center_bottom_visible === 'boolean' ? ui.center_bottom_visible : state.centerBottomVisible,
      channelPanelVisible: typeof ui.channel_panel_visible === 'boolean' ? ui.channel_panel_visible : state.channelPanelVisible,
      channelConfigPreview: false,
    };
  }),
  setCenterTopVisible: (visible) => set({ centerTopVisible: visible, channelConfigPreview: false }),
  openChannelConfig: () => set((state) => ({ channelConfigPreview: !state.centerTopVisible })),
  closeChannelConfig: () => set({ channelConfigPreview: false }),
  setCenterBottomVisible: (visible) => set({ centerBottomVisible: visible }),
  setRightPanelVisible: (visible) => set({ rightPanelVisible: visible }),
  setDataViewMode: (mode) => set({ dataViewMode: mode === 'image' ? 'chart' : mode }),
  setShowAddChannelMenu: (show) => set({ showAddChannelMenu: show }),
  setThemeMode: (mode) => set({ themeMode: mode }),
  setSendFormat: (format) => set({ sendFormat: format }),
  setReceiveFormat: (format) => set({ receiveFormat: format }),
  setChannelPanelVisible: (visible) => set({ channelPanelVisible: visible, channelConfigPreview: false }),
  setShowInputPrefix: (show) => set({ showInputPrefix: show }),
  setShowTimestamp: (show) => set({ showTimestamp: show }),
  setShowReceived: (show) => set({ showReceived: show }),
  setTerminalChannelSettings: (channelId, settings) => set((state) => ({
    terminalChannelSettings: {
      ...state.terminalChannelSettings,
      [channelId]: settings,
    },
  })),
  replaceTerminalChannelSettings: (settings) => set({ terminalChannelSettings: settings }),
  setRestoreCanvasLayout: (restore) => set({ restoreCanvasLayout: restore }),
  setChannelQuickOpenSelectedIds: (ids) => set({ channelQuickOpenSelectedIds: ids }),
  setFileDialogDir: (kind, directory) => set((state) => ({
    fileDialogDirs: {
      ...state.fileDialogDirs,
      [kind]: directory,
    },
  })),
  resetCanvasViewport: () => set((state) => ({
    canvasViewportResetVersion: state.canvasViewportResetVersion + 1,
  })),
  toggleChannelPanel: () => set((state) => ({ channelPanelVisible: !state.channelPanelVisible, channelConfigPreview: false })),
  toggleCenterTopVisible: () => set((state) => ({ centerTopVisible: !state.centerTopVisible, channelConfigPreview: false })),
  toggleCenterBottomVisible: () => set((state) => ({ centerBottomVisible: !state.centerBottomVisible })),
  toggleRightPanelVisible: () => set((state) => ({ rightPanelVisible: !state.rightPanelVisible })),
}));
