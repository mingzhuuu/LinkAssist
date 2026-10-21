import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { useCommandStore, toast } from '../../stores';
import { SaveIcon, DownloadIcon, TrashIcon } from '../common/Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  anchorPosition: { top: number; left: number } | null;
  tagId: string;
}

const EMPTY_CONFIGS: never[] = [];

function ExportIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

export const SavedCommandsDialog: React.FC<Props> = ({ open, onClose, anchorPosition, tagId }) => {
  const allSavedConfigs = useCommandStore(state => state.savedConfigs);
  const savedConfigs = useMemo(() => allSavedConfigs[tagId] ?? EMPTY_CONFIGS, [allSavedConfigs, tagId]);
  const [saveName, setSaveName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSaveName('');
    setShowSaveInput(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (showSaveInput) {
      window.setTimeout(() => saveInputRef.current?.focus(), 0);
    }
  }, [showSaveInput]);

  const handleSave = useCallback(() => {
    if (showSaveInput) {
      useCommandStore.getState().saveConfig(tagId, saveName);
      toast.success('Config saved');
      setSaveName('');
      setShowSaveInput(false);
    } else {
      setShowSaveInput(true);
    }
  }, [showSaveInput, tagId, saveName]);

  const handleExport = useCallback(async () => {
    const json = useCommandStore.getState().exportCommands(tagId);
    try {
      const filePath = await save({
        defaultPath: `commands-${tagId}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!filePath) return; // User cancelled
      await invoke('export_to_file', { path: filePath, content: json });
      toast.success('Config exported');
      onClose();
    } catch (error) {
      toast.error(`Export failed: ${String(error)}`);
    }
  }, [tagId, onClose]);

  const handleLoad = useCallback((configId: string) => {
    useCommandStore.getState().loadConfig(tagId, configId);
    toast.success('Config loaded');
    onClose();
  }, [tagId, onClose]);

  const handleDelete = useCallback((configId: string) => {
    useCommandStore.getState().deleteConfig(tagId, configId);
  }, [tagId]);

  const handleLoadFromFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const success = useCommandStore.getState().importCommands(tagId, text);
      if (success) {
        toast.success('Config loaded from file');
        onClose();
      } else {
        toast.error('Invalid config file');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }, [tagId, onClose]);

  if (!open || !anchorPosition) return null;

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  const availableHeightAboveAnchor = Math.max(anchorPosition.top - 12, 0);

  return createPortal(
    <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-[9000]" onMouseDown={onClose}>
      <div
        className="bg-surface-overlay border border-border rounded-2xl shadow-2xl w-[180px] max-w-[90vw] flex flex-col overflow-hidden"
        style={{
          position: 'fixed',
          top: anchorPosition.top,
          left: anchorPosition.left,
          transform: 'translate(-100%, calc(-100% - 8px))',
          transformOrigin: 'bottom right',
          maxHeight: availableHeightAboveAnchor || undefined,
        }}
        onMouseDown={event => event.stopPropagation()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={handleFileSelected}
        />

        {/* Save */}
        <button
          onClick={handleSave}
          className="flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-[var(--layer-selected)] transition-colors"
        >
          <SaveIcon size={13} />
          <span>Save</span>
        </button>

        {showSaveInput && (
          <div className="px-3 pb-2">
            <input
              ref={saveInputRef}
              type="text"
              value={saveName}
              onChange={event => setSaveName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleSave();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setShowSaveInput(false);
                }
              }}
              placeholder="Name (optional)"
              className="w-full bg-surface-tertiary border border-border rounded-lg px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent-blue/40 placeholder:text-text-muted/50"
            />
          </div>
        )}

        <div className="mx-2 border-t border-border" />

        {/* Load from file */}
        <button
          onClick={handleLoadFromFile}
          className="flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-[var(--layer-selected)] transition-colors"
        >
          <DownloadIcon size={13} />
          <span>Load</span>
        </button>

        <div className="mx-2 border-t border-border" />

        {/* Export to file */}
        <button
          onClick={handleExport}
          className="flex items-center gap-2.5 px-3 py-2 text-xs text-text-secondary hover:bg-[var(--layer-selected)] transition-colors"
        >
          <ExportIcon size={13} />
          <span>Export</span>
        </button>

        {/* Config history */}
        {savedConfigs.length > 0 && (
          <>
            <div className="mx-2 border-t border-border" />
            <div className="max-h-[200px] overflow-y-auto">
              {savedConfigs.map(config => (
                <div
                  key={config.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--layer-selected)] transition-colors cursor-default group"
                  onClick={() => handleLoad(config.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-text-primary truncate text-[11px]">{config.name}</div>
                    <div className="text-[9px] text-text-muted">{formatTime(config.timestamp)}</div>
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDelete(config.id);
                    }}
                    className="p-0.5 text-text-muted hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                    title="Delete"
                  >
                    <TrashIcon size={11} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
