import React from 'react';
import { createPortal } from 'react-dom';

interface MenuOption {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  options: MenuOption[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, options, onClose }) => {
  const stopMenuEvent = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={(e) => { stopMenuEvent(e); onClose(); }}
        onContextMenu={(e) => { stopMenuEvent(e); onClose(); }}
      />
      {/* Menu */}
      <div
        className="fixed z-[9999] min-w-[140px] p-1 overflow-hidden bg-surface-overlay border border-border rounded-xl shadow-xl shadow-black/30 backdrop-blur-sm animate-fade-in"
        style={{ left: x, top: y }}
        onMouseDown={stopMenuEvent}
        onMouseUp={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={stopMenuEvent}
      >
        {options.map((opt, i) => (
          <button
            key={i}
            className={`w-full rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
              opt.disabled
                ? 'text-text-faint cursor-not-allowed'
                : opt.danger
                ? 'text-accent-red hover:bg-accent-red/10'
                : 'text-text-primary hover:bg-[var(--layer-selected)]'
            }`}
            onClick={() => { if (!opt.disabled) { opt.onClick(); onClose(); } }}
            disabled={opt.disabled}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
};
