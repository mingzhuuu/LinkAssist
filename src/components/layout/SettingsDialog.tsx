import { importLayout } from './layoutImport';
import { version } from '../../../package.json';
import { toast } from '../../stores/toastStore';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { save, open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { LEFT_PANEL_MIN_WIDTH, useUIStore, useChannelStore, useTerminalStore, useCommandStore, useProtocolStore, useBleStore, useSerialStore, useTcpStore, useCanvasStore, useMcpStore } from '../../stores';
import type { TerminalLayoutSnapshot } from '../../stores/terminalStore';
import type { ThemeMode } from '../../stores/uiStore';
import type { McpToolMetaPreview, McpToolScriptPreview } from '../../types';
import { hasMcpToolLuaPath, getPersistedMcpToolsConfig } from '../../types';
import { getDialogDefaultPath, getParentDirectory } from '../../lib';
import {
  CloseIcon,
  SettingsIcon,
  SignalIcon,
  SaveIcon,
} from '../common/Icons';

type SettingsSection = 'interface' | 'channel' | 'table' | 'layout' | 'mcp';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const SettingGroup: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <div className="mb-8">
    {title && <h3 className="mb-3 text-[13px] font-medium text-text-muted">{title}</h3>}
    <div className="rounded-xl border border-border bg-[var(--layer-hover)] divide-y divide-border">
      {React.Children.map(children, (child, index) => {
        if (React.isValidElement(child)) {
          const isFirst = index === 0;
          const isLast = index === React.Children.count(children) - 1;
          const containerClasses = `transition-colors hover:bg-[var(--layer-hover)] ${isFirst ? 'rounded-t-xl' : ''} ${isLast ? 'rounded-b-xl' : ''}`;
          return (
            <div className={containerClasses}>
              {child}
            </div>
          );
        }
        return child;
      })}
    </div>
  </div>
);

const ToggleSetting: React.FC<{
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}> = ({ title, description, checked, onChange }) => (
  <div className="flex items-center justify-between px-5 py-4 transition-colors">
    <div className="pr-6">
      <div className="text-[14px] font-medium text-text-primary">{title}</div>
      <div className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</div>
    </div>
    <button
      type="button"
      role="switch"
      aria-label={title}
      aria-checked={checked}
      className={`relative shrink-0 h-5 w-9 rounded-full transition-colors cursor-pointer ${
        checked ? 'bg-accent-blue' : 'bg-[var(--layer-active)]'
      }`}
      onClick={() => onChange(!checked)}
    >
      <div
        className={`absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  </div>
);

const DropdownSetting = <T extends string>({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description: string;
  value: T;
  options: Array<{ label: string; value: T }>;
  onChange: (val: T) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="flex items-center justify-between px-5 py-4 transition-colors">
      <div className="pr-6">
        <div className="text-[14px] font-medium text-text-primary">{title}</div>
        <div className="mt-1 text-[13px] leading-relaxed text-text-muted">{description}</div>
      </div>
      <div className="relative shrink-0" ref={containerRef}>
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex cursor-pointer items-center gap-2 text-text-secondary transition-colors hover:text-text-primary"
        >
          <span className="text-[14px]">{options.find((o) => o.value === value)?.label}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="opacity-70">
            <path
              d="M3.5 4.5L6 7L8.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {isOpen && (
          <div className="absolute right-0 top-full mt-2 z-50 w-36 overflow-hidden rounded-xl border border-border bg-surface-overlay p-1 shadow-2xl">
            {options.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  onChange(o.value);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-[13px] transition-colors rounded-lg ${
                  o.value === value 
                    ? 'bg-[var(--layer-active)] text-text-primary font-medium' 
                    : 'text-text-secondary hover:bg-[var(--layer-hover)] hover:text-text-primary'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMcpToolMetaPreview(value: unknown): value is McpToolMetaPreview {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && isRecord(value.inputSchema)
    && (value.protocolFile === undefined || value.protocolFile === null || typeof value.protocolFile === 'string');
}

function isMcpToolScriptPreview(value: unknown): value is McpToolScriptPreview {
  return isRecord(value)
    && Array.isArray(value.tools)
    && value.tools.every((tool) => isMcpToolMetaPreview(tool));
}

export const SettingsDialog: React.FC<SettingsDialogProps> = ({ open, onClose }) => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('interface');
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [luaPathErrors, setLuaPathErrors] = useState<Record<string, string>>({});
  const [mcpMetaPreview, setMcpMetaPreview] = useState<Record<string, McpToolScriptPreview>>({});
  const [mcpMetaErrors, setMcpMetaErrors] = useState<Record<string, string>>({});
  const requestedMcpPathsRef = useRef<Record<string, string>>({});

  const {
    themeMode,
    setThemeMode,
    showReceived,
    setShowReceived,
    restoreCanvasLayout,
    setRestoreCanvasLayout,
    simpleMode,
    setSimpleMode,
    fileDialogDirs,
    setFileDialogDir,
  } = useUIStore();

  const mcpEnabled = useMcpStore((state) => state.enabled);
  const mcpScripts = useMcpStore((state) => state.scripts);
  const setMcpEnabled = useMcpStore((state) => state.setEnabled);
  const addMcpScript = useMcpStore((state) => state.addScript);
  const updateMcpScript = useMcpStore((state) => state.updateScript);
  const removeMcpScript = useMcpStore((state) => state.removeScript);

  const fetchMcpMeta = useCallback(async (scriptId: string, luaPath: string) => {
    const trimmedPath = luaPath.trim();
    const isCurrentPath = () => useMcpStore.getState().scripts.some(
      (script) => script.id === scriptId && script.luaPath.trim() === trimmedPath,
    );
    if (!hasMcpToolLuaPath(trimmedPath)) {
      setMcpMetaPreview((current) => {
        const next = { ...current };
        delete next[scriptId];
        return next;
      });
      setMcpMetaErrors((current) => ({
        ...current,
        [scriptId]: '',
      }));
      return;
    }

    try {
      const meta = await invoke<unknown>('get_mcp_tool_meta', { filePath: trimmedPath });
      if (!isCurrentPath()) return;
      if (!isMcpToolScriptPreview(meta)) {
        throw new Error('Invalid MCP tool metadata');
      }
      setMcpMetaPreview((current) => ({ ...current, [scriptId]: meta }));
      setMcpMetaErrors((current) => ({ ...current, [scriptId]: '' }));
    } catch (error) {
      if (!isCurrentPath()) return;
      setMcpMetaPreview((current) => {
        const next = { ...current };
        delete next[scriptId];
        return next;
      });
      const message = error instanceof Error ? error.message : String(error);
      setMcpMetaErrors((current) => ({
        ...current,
        [scriptId]: message || 'Failed to load MCP tool metadata',
      }));
      const currentScript = useMcpStore.getState().scripts.find((script) => script.id === scriptId);
      if (currentScript?.exposeToMcp) {
        updateMcpScript(scriptId, { exposeToMcp: false });
      }
    }
  }, [updateMcpScript]);

  useEffect(() => {
    if (!open) {
      requestedMcpPathsRef.current = {};
      return;
    }

    const ids = new Set(mcpScripts.map((script) => script.id));
    setLuaPathErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setMcpMetaErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
    setMcpMetaPreview((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));

    requestedMcpPathsRef.current = Object.fromEntries(
      Object.entries(requestedMcpPathsRef.current).filter(([id]) => ids.has(id)),
    );

    mcpScripts.forEach((script) => {
      const luaPath = script.luaPath.trim();
      if (
        hasMcpToolLuaPath(luaPath)
        && requestedMcpPathsRef.current[script.id] !== luaPath
      ) {
        requestedMcpPathsRef.current[script.id] = luaPath;
        void fetchMcpMeta(script.id, luaPath);
      }
    });
  }, [fetchMcpMeta, mcpScripts, open]);

  const handleAddMcpScript = useCallback(() => {
    addMcpScript();
  }, [addMcpScript]);

  const handleMcpLuaPathChange = useCallback((scriptId: string, rawPath: string) => {
    const luaPath = rawPath.trim();
    const valid = hasMcpToolLuaPath(luaPath);

    setLuaPathErrors((current) => ({
      ...current,
      [scriptId]: '',
    }));

    if (!valid) {
      setMcpMetaPreview((current) => {
        const next = { ...current };
        delete next[scriptId];
        return next;
      });
      setMcpMetaErrors((current) => ({
        ...current,
        [scriptId]: '',
      }));
      updateMcpScript(scriptId, { luaPath, exposeToMcp: false });
      return;
    }

    updateMcpScript(scriptId, { luaPath });
  }, [updateMcpScript]);

  const handleSelectMcpFile = useCallback(async (scriptId: string) => {
    const filePath = await openFileDialog({
      multiple: false,
      defaultPath: getDialogDefaultPath(fileDialogDirs.mcp),
      filters: [{ name: 'Lua', extensions: ['lua'] }],
    });
    if (typeof filePath === 'string') {
      setFileDialogDir('mcp', getParentDirectory(filePath));
      handleMcpLuaPathChange(scriptId, filePath);
    }
  }, [fileDialogDirs.mcp, handleMcpLuaPathChange, setFileDialogDir]);

  const handleSaveLayout = useCallback(async () => {
    setIsSaving(true);
    try {
      const filePath = await save({
        defaultPath: getDialogDefaultPath(fileDialogDirs.layout, 'linkassist-layout.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) {
        setIsSaving(false);
        return;
      }
      setFileDialogDir('layout', getParentDirectory(filePath));

      const channels = useChannelStore.getState().channels.map((ch) => {
        let settings: Record<string, unknown> = {};
        if (ch.type === 'ble') {
          settings = (useBleStore.getState().bleFilters[ch.id] ?? {}) as unknown as Record<string, unknown>;
        } else if (ch.type === 'serial') {
          settings = (useSerialStore.getState().channelConfigs[ch.id] ?? {}) as unknown as Record<string, unknown>;
        } else if (ch.type === 'tcp') {
          settings = (useTcpStore.getState().channelConfigs[ch.id] ?? {}) as unknown as Record<string, unknown>;
        }
        return { id: ch.id, name: ch.name, channel_type: ch.type, settings };
      });

      const ui = useUIStore.getState();
      const proto = useProtocolStore.getState();
      const terminal = useTerminalStore.getState();
      const commandSnapshot = useCommandStore.getState().getSnapshot();

      const canvasSnapshot = useCanvasStore.getState().canvases;
      const mcpToolsSnapshot = getPersistedMcpToolsConfig(
        useMcpStore.getState().enabled,
        useMcpStore.getState().scripts,
      );

      const config = {
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
          terminal_layout: terminal.getLayoutSnapshot(),
          restore_canvas_layout: ui.restoreCanvasLayout,
          channel_quick_open_selected_ids: ui.channelQuickOpenSelectedIds,
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
        canvases: canvasSnapshot,
        mcp_tools: mcpToolsSnapshot,
      };

      await invoke('export_to_file', { path: filePath, content: JSON.stringify(config, null, 2) });
    } catch (err) {
      console.warn('Failed to save layout:', err);
    } finally {
      setIsSaving(false);
    }
  }, [fileDialogDirs.layout, setFileDialogDir]);

  const handleResetLayout = useCallback(() => {
    setIsResetting(true);
    try {
      // Remove all channels
      const channelIds = useChannelStore.getState().channels.map((c) => c.id);
      for (const id of channelIds) {
        useChannelStore.getState().removeChannel(id);
      }

      // Reset UI to defaults
      const ui = useUIStore.getState();
      ui.setLeftPanelWidth(LEFT_PANEL_MIN_WIDTH);
      ui.setRightPanelWidth(360);
      ui.setCenterSplitRatio(0.5);
      ui.setCenterTopVisible(true);
      ui.setCenterBottomVisible(true);
      ui.setRightPanelVisible(true);
      ui.setSimpleMode(false);
      ui.setDataViewMode('text' as 'text');
      ui.setThemeMode('dark' as ThemeMode);
      ui.setSendFormat('ascii');
      ui.setReceiveFormat('hex');
      ui.setChannelPanelVisible(true);
      ui.setShowInputPrefix(true);
      ui.setShowTimestamp(true);
      ui.setShowReceived(true);
      ui.replaceTerminalChannelSettings({});

      // Reset terminal layout to single default pane
      const paneId = crypto.randomUUID();
      const tabId = crypto.randomUUID();
      const defaultSnapshot: TerminalLayoutSnapshot = {
        root: { type: 'leaf', paneId },
        panes: {
          [paneId]: {
            tabs: [{ id: tabId, channelId: null, label: 'TERMINAL', isPinned: true }],
            activeTabId: tabId,
            showCommandsPanel: false,
          },
        },
        focusedPaneId: paneId,
      };
      useTerminalStore.getState().restoreLayoutSnapshot(defaultSnapshot);

      // Clear all saved commands
      useCommandStore.getState().restoreSnapshot({ commandSets: {}, expandedGroups: {} });

      // Clear all canvases
      const canvasIds = useCanvasStore.getState().canvases.map((c) => c.id);
      for (const cid of canvasIds) {
        useCanvasStore.getState().removeCanvas(cid);
      }

      // Clear MCP tool scripts
      useMcpStore.getState().reset();

      // Reset protocol
      const proto = useProtocolStore.getState();
      proto.setMode('Passthrough' as 'Passthrough');
      proto.setLuaScript('');
      proto.setFieldDefinitions([]);
      proto.setLinkedChannel(null);
      proto.setLinkedService(null);
      proto.setLinkedChar(null);
      ui.resetCanvasViewport();
    } finally {
      setIsResetting(false);
    }
  }, []);

  const handleLoadLayout = useCallback(async () => {
    setIsLoading(true);
    try {
      const filePath = await openFileDialog({
        multiple: false,
        defaultPath: getDialogDefaultPath(fileDialogDirs.layout),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) {
        setIsLoading(false);
        return;
      }
      setFileDialogDir('layout', getParentDirectory(filePath));

      const content = await invoke<string>('import_from_file', { path: filePath });
      importLayout(content, filePath);
    } catch (err) {
      console.warn('Failed to load layout:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load layout');
    } finally {
      setIsLoading(false);
    }
  }, [fileDialogDirs.layout, setFileDialogDir]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex h-[min(640px,calc(100vh-4rem))] w-[min(900px,calc(100vw-4rem))] overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.4)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar */}
        <aside className="flex w-[240px] shrink-0 flex-col border-r border-border bg-surface-tertiary">
          <div className="flex flex-1 flex-col px-3 py-4">
            <div className="mb-2 px-3 pt-2 text-[12px] font-semibold text-text-muted">General</div>
            <button
              onClick={() => setActiveSection('interface')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors ${
                activeSection === 'interface'
                  ? 'bg-[var(--layer-active)] text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-[var(--layer-hover)]'
              }`}
            >
              <SettingsIcon size={16} className={activeSection === 'interface' ? 'opacity-100' : 'opacity-60'} />
              Interface
            </button>
            <button
              onClick={() => setActiveSection('layout')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors ${
                activeSection === 'layout'
                  ? 'bg-[var(--layer-active)] text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-[var(--layer-hover)]'
              }`}
            >
              <div className={activeSection === 'layout' ? 'opacity-100' : 'opacity-60'}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="2" y="9" width="12" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
              Layout
            </button>
            <div className="mb-2 mt-4 px-3 pt-2 text-[12px] font-semibold text-text-muted">Controls</div>
            <button
              onClick={() => setActiveSection('channel')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors ${
                activeSection === 'channel'
                  ? 'bg-[var(--layer-active)] text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-[var(--layer-hover)]'
              }`}
            >
              <SignalIcon size={16} className={activeSection === 'channel' ? 'opacity-100' : 'opacity-60'} />
              Channel
            </button>
            <button
              onClick={() => setActiveSection('table')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors ${
                activeSection === 'table'
                  ? 'bg-[var(--layer-active)] text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-[var(--layer-hover)]'
              }`}
            >
              <div className={activeSection === 'table' ? 'opacity-100' : 'opacity-60'}>
                {/* Table icon placeholder */}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M2 7H14" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6 7V13" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
              Canvas
            </button>
            <div className="mb-2 mt-4 px-3 pt-2 text-[12px] font-semibold text-text-muted">Advanced</div>
            <button
              onClick={() => setActiveSection('mcp')}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition-colors ${
                activeSection === 'mcp'
                  ? 'bg-[var(--layer-active)] text-text-primary font-medium'
                  : 'text-text-secondary hover:bg-[var(--layer-hover)]'
              }`}
            >
              <div className={activeSection === 'mcp' ? 'opacity-100' : 'opacity-60'}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4.5H13M3 8H13M3 11.5H9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M10.5 10.5L12 12L14 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              MCP
            </button>
          </div>
          
          <div className="px-6 py-6 pb-8">
            <div className="text-[13px] font-medium text-text-muted">LinkAssist</div>
            <div className="mt-0.5 text-[12px] text-text-muted">v{version}</div>
          </div>
        </aside>

        {/* Content Area */}
        <main className="relative flex flex-1 flex-col overflow-y-auto bg-surface">
          <div className="sticky top-0 z-10 flex h-16 items-center justify-between bg-surface/95 px-10 pt-4 backdrop-blur-md">
            <h2 className="text-[20px] font-medium text-text-primary">
              {activeSection === 'interface' && 'Interface'}
              {activeSection === 'layout' && 'Layout'}
              {activeSection === 'channel' && 'Channel'}
              {activeSection === 'table' && 'Canvas'}
              {activeSection === 'mcp' && 'MCP'}
            </h2>
            <button
              onClick={onClose}
              className="-mr-2 rounded-lg p-2 text-text-muted transition-colors hover:bg-[var(--layer-active)] hover:text-text-primary"
            >
              <CloseIcon size={18} />
            </button>
          </div>

          <div className="px-10 pb-12 pt-6">
            {activeSection === 'interface' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <SettingGroup title="System Theme">
                  <DropdownSetting
                    title="Color Scheme"
                    description="Choose whether LinkAssist follows the system theme or uses light or dark mode"
                    value={themeMode}
                    options={[
                      { label: 'System', value: 'system' },
                      { label: 'Light', value: 'light' },
                      { label: 'Dark', value: 'dark' },
                      { label: 'High Contrast (Dark)', value: 'high-contrast' },
                      { label: 'High Contrast (Light)', value: 'high-contrast-light' },
                    ]}
                    onChange={(v) => setThemeMode(v as 'system'|'light'|'dark'|'high-contrast'|'high-contrast-light')}
                  />
                </SettingGroup>

                <SettingGroup title="Layout Mode">
                  <ToggleSetting
                    title="Simple mode"
                    description="Show only the canvas and hide the channel and center panels"
                    checked={simpleMode}
                    onChange={setSimpleMode}
                  />
                </SettingGroup>

              </div>
            )}

            {activeSection === 'layout' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <SettingGroup title="Canvas Layout">
                  <ToggleSetting
                    title="Restore canvas layout on startup"
                    description="When enabled, the next launch restores the canvas content, position, and layer order from the previous session"
                    checked={restoreCanvasLayout}
                    onChange={setRestoreCanvasLayout}
                  />
                </SettingGroup>

                <SettingGroup title="Layout Management">
                  <div className="flex items-center justify-between px-5 py-4 transition-colors">
                    <div className="pr-6">
                      <div className="text-[14px] font-medium text-text-primary">Save current layout</div>
                      <div className="mt-1 text-[13px] leading-relaxed text-text-muted">
                        Save channels, terminal layout, command panels, protocol settings, and more to a JSON file
                      </div>
                    </div>
                    <button
                      onClick={handleSaveLayout}
                      disabled={isSaving}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-[var(--layer-hover)] px-4 py-2 text-[13px] text-text-secondary transition-colors hover:bg-[var(--layer-active)] hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <SaveIcon size={14} />
                      {isSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between px-5 py-4 transition-colors">
                    <div className="pr-6">
                      <div className="text-[14px] font-medium text-text-primary">Load layout</div>
                      <div className="mt-1 text-[13px] leading-relaxed text-text-muted">
                        Restore channels, terminal layout, command panels, and protocol settings from a JSON file
                      </div>
                    </div>
                    <button
                      onClick={handleLoadLayout}
                      disabled={isLoading}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-[var(--layer-hover)] px-4 py-2 text-[13px] text-text-secondary transition-colors hover:bg-[var(--layer-active)] hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2 7.5V11C2 11.5523 2.44772 12 3 12H11C11.5523 12 12 11.5523 12 11V7.5M7 2V9M7 9L4.5 6.5M7 9L9.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {isLoading ? 'Loading…' : 'Load'}
                    </button>
                  </div>
                  <div className="flex items-center justify-between px-5 py-4 transition-colors">
                    <div className="pr-6">
                      <div className="text-[14px] font-medium text-text-primary">Reset all layouts</div>
                      <div className="mt-1 text-[13px] leading-relaxed text-text-muted">
                        Clear all channels, terminal splits, and command settings, then restore the default state
                      </div>
                    </div>
                    <button
                      onClick={handleResetLayout}
                      disabled={isResetting}
                      className="flex shrink-0 items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-[13px] text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path d="M2.5 4H11.5M5.5 6.5V9.5M8.5 6.5V9.5M3.5 4L4 11C4 11.5523 4.44772 12 5 12H9C9.55228 12 10 11.5523 10 11L10.5 4M5 4V2.5C5 2.22386 5.22386 2 5.5 2H8.5C8.77614 2 9 2.22386 9 2.5V4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {isResetting ? 'Resetting…' : 'Reset'}
                    </button>
                  </div>
                </SettingGroup>
              </div>
            )}

            {activeSection === 'channel' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <SettingGroup>
                  <ToggleSetting
                    title="Show received content"
                    description="When disabled, terminals and data views stop rendering RX content, while background capture remains unaffected."
                    checked={showReceived}
                    onChange={setShowReceived}
                  />
                </SettingGroup>
              </div>
            )}

            {activeSection === 'table' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                {/* Reserved for future canvas settings */}
              </div>
            )}

            {activeSection === 'mcp' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <SettingGroup title="MCP Tools">
                  <ToggleSetting
                    title="Enable MCP tools"
                    description="When disabled, MCP Bridge returns no tools, rejects tool calls, and will not start the LinkAssist Core in the background."
                    checked={mcpEnabled}
                    onChange={setMcpEnabled}
                  />
                </SettingGroup>
                <SettingGroup title="Tool Definition Scripts">
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[14px] font-medium text-text-primary">Lua MCP tools</div>
                        <div className="mt-1 text-[13px] leading-relaxed text-text-muted">
                          Add Lua scripts that can be exposed through MCP. File-based scripts must declare <span className="font-mono text-text-secondary">-- linkassist:type = mcp</span>, then either define legacy <span className="font-mono text-text-secondary">mcp_meta()</span> + <span className="font-mono text-text-secondary">call(args)</span> or multi-tool <span className="font-mono text-text-secondary">mcp_tools()</span> + <span className="font-mono text-text-secondary">call(tool_name, args)</span>.
                        </div>
                      </div>
                      <button
                        onClick={handleAddMcpScript}
                        className="shrink-0 rounded-lg border border-accent-blue/30 bg-accent-blue/10 px-4 py-2 text-[13px] text-accent-blue transition-colors hover:bg-accent-blue/20 hover:text-text-primary"
                      >
                        Add Tool
                      </button>
                    </div>
                  </div>
                  {mcpScripts.length === 0 ? (
                    <div className="px-5 py-6 text-[13px] text-text-muted">
                      No MCP tool scripts yet. Add one to define a custom tool for MCP clients.
                    </div>
                  ) : (
                    mcpScripts.map((script) => {
                      const luaPath = script.luaPath ?? '';
                      const luaPathValid = hasMcpToolLuaPath(luaPath);
                      const luaPathError = luaPathErrors[script.id] || '';
                      const preview = mcpMetaPreview[script.id];
                      const tools = preview?.tools ?? [];
                      const firstTool = tools[0];
                      const metaError = mcpMetaErrors[script.id] ?? '';
                      const canExpose = luaPathValid && tools.length > 0 && !metaError;
                      const statusText = luaPathError || metaError || (tools.length > 0
                        ? `${tools.length} tool${tools.length > 1 ? 's' : ''} ready for MCP exposure`
                        : (luaPathValid ? 'Waiting for MCP tool preview' : 'Select a Lua MCP file to preview metadata'));
                      return (
                        <div key={script.id} className="flex items-center gap-3 px-5 py-4">
                          <div className="min-w-0 w-[180px] shrink-0">
                            <div className="truncate text-[14px] font-medium text-text-primary">{firstTool?.name ?? 'Lua MCP tool script'}</div>
                            <div className={`truncate text-[12px] ${luaPathError || metaError ? 'text-red-300' : 'text-text-muted'}`} title={statusText}>
                              {statusText}
                            </div>
                            {tools.length > 0 && (
                              <div className="mt-2 space-y-1">
                                {tools.slice(0, 3).map((tool) => (
                                  <div key={tool.name} className="truncate text-[11px] text-text-muted" title={tool.description || tool.name}>
                                    • {tool.name}
                                  </div>
                                ))}
                                {tools.length > 3 && (
                                  <div className="text-[11px] text-text-muted">+{tools.length - 3} more</div>
                                )}
                              </div>
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <input
                              value={luaPath}
                              onChange={(event) => handleMcpLuaPathChange(script.id, event.target.value)}
                              placeholder="Path to a Lua MCP script"
                              title={luaPath}
                              className={`w-full rounded-lg border bg-[var(--layer-active)] px-3 py-2 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-primary/25 ${luaPathError ? 'border-red-500/50 focus:border-red-400' : 'border-border focus:border-accent-blue/50'}`}
                            />
                          </div>

                          <button
                            onClick={() => handleSelectMcpFile(script.id)}
                            className="shrink-0 rounded-lg border border-border bg-[var(--layer-hover)] px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-[var(--layer-active)] hover:text-text-primary"
                          >
                            Browse
                          </button>

                          <label className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-[var(--layer-hover)] px-3 py-2 text-[13px] text-text-primary">
                            <span>Enable</span>
                            <input
                              type="checkbox"
                              checked={script.exposeToMcp}
                              disabled={!canExpose}
                              onChange={(event) => updateMcpScript(script.id, { exposeToMcp: event.target.checked && canExpose })}
                              className="h-4 w-4 accent-accent-blue"
                            />
                          </label>

                          <button
                            onClick={() => removeMcpScript(script.id)}
                            className="shrink-0 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[13px] text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })
                  )}
                </SettingGroup>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>,
    document.body,
  );
};
