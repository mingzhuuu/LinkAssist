import React from 'react';
import { createPortal } from 'react-dom';
import type { TerminalDataFormat } from '../../stores/uiStore';

interface TerminalContextMenuProps {
  x: number;
  y: number;
  showReceived: boolean;
  sendFormat: TerminalDataFormat;
  receiveFormat: TerminalDataFormat;
  showInputPrefix: boolean;
  showTimestamp: boolean;
  onClear: () => void;
  onToggleReceived: () => void;
  onSetSendFormat: (format: TerminalDataFormat) => void;
  onSetReceiveFormat: (format: TerminalDataFormat) => void;
  onToggleInputPrefix: () => void;
  onToggleTimestamps: () => void;
  onClose: () => void;
}

const FormatSetting: React.FC<{
  label: string;
  value: TerminalDataFormat;
  onChange: (format: TerminalDataFormat) => void;
}> = ({ label, value, onChange }) => (
  <div className="flex items-center justify-between gap-1.5 px-2 py-1 text-[11px] text-text-secondary">
    <span>{label}</span>
    <div className="flex overflow-hidden rounded-md border border-border bg-surface">
      {(['ascii', 'hex'] as const).map((format) => (
        <button
          key={format}
          className={`px-1 py-px text-[9px] uppercase transition-colors ${
            value === format
              ? 'bg-[var(--layer-active)] text-text-primary'
              : 'text-text-muted hover:bg-[var(--layer-hover)] hover:text-text-secondary'
          }`}
          onClick={() => onChange(format)}
        >
          {format}
        </button>
      ))}
    </div>
  </div>
);

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  x,
  y,
  showReceived,
  sendFormat,
  receiveFormat,
  showInputPrefix,
  showTimestamp,
  onClear,
  onToggleReceived,
  onSetSendFormat,
  onSetReceiveFormat,
  onToggleInputPrefix,
  onToggleTimestamps,
  onClose,
}) => {
  const stopMenuEvent = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const runAction = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={(event) => { stopMenuEvent(event); onClose(); }}
        onContextMenu={(event) => { stopMenuEvent(event); onClose(); }}
      />
      <div
        className="fixed z-[9999] min-w-[170px] overflow-hidden rounded-xl border border-border bg-surface-overlay p-1 shadow-xl shadow-black/30 backdrop-blur-sm animate-fade-in"
        style={{
          left: Math.min(x, window.innerWidth - 178),
          top: Math.min(y, window.innerHeight - 170),
        }}
        onMouseDown={stopMenuEvent}
        onMouseUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={stopMenuEvent}
      >
        <button
          className="w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-secondary hover:bg-[var(--layer-active)]"
          onClick={() => runAction(onClear)}
        >
          Clear
        </button>
        <div className="my-0.5 border-t border-border" />
        <button
          className="w-full rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-secondary hover:bg-[var(--layer-active)]"
          onClick={() => runAction(onToggleReceived)}
        >
          {showReceived ? 'Pause' : 'Resume'}
        </button>
        <div className="my-0.5 border-t border-border" />
        <FormatSetting label="Send format" value={sendFormat} onChange={onSetSendFormat} />
        <FormatSetting label="Receive format" value={receiveFormat} onChange={onSetReceiveFormat} />
        <div className="my-0.5 border-t border-border" />
        <button
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-secondary hover:bg-[var(--layer-active)]"
          onClick={onToggleInputPrefix}
        >
          <span>Input prefix</span>
          <span className={showInputPrefix ? 'text-accent-green' : 'text-text-muted'}>
            {showInputPrefix ? 'On' : 'Off'}
          </span>
        </button>
        <button
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11px] text-text-secondary hover:bg-[var(--layer-active)]"
          onClick={onToggleTimestamps}
        >
          <span>Timestamps</span>
          <span className={showTimestamp ? 'text-accent-green' : 'text-text-muted'}>
            {showTimestamp ? 'On' : 'Off'}
          </span>
        </button>
      </div>
    </>,
    document.body,
  );
};
