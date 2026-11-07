import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Channel } from '../../types';
import type { ChannelTab } from '../../stores/terminalStore';
import { terminalChannels, terminalTabLabel } from './TerminalChannels';
import { PlusIcon } from '../common/Icons';

interface Props {
  anchor: HTMLButtonElement;
  hiddenTabs: ChannelTab[];
  channels: Channel[];
  onSelectTab: (id: string) => void;
  onAddTab: () => void;
  onClose: () => void;
}

export function TerminalTabMenu({ anchor, hiddenTabs, channels, onSelectTab, onAddTab, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); anchor.focus(); }
    };
    document.addEventListener('keydown', dismiss);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', dismiss);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  const run = (action: () => void) => { action(); onClose(); anchor.focus(); };
  const buttonClass = 'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-selected)] focus-visible:bg-[var(--layer-selected)]';
  return createPortal(<>
    <div className="fixed inset-0 z-[9998]" onMouseDown={onClose} onContextMenu={event => { event.preventDefault(); onClose(); }} />
    <div ref={menuRef} role="dialog" aria-label="Terminal channels"
      className="fixed left-1 top-1 z-[9999] w-max min-w-[180px] max-w-[calc(100vw-8px)] rounded-xl border border-border bg-surface-overlay p-1.5 shadow-xl shadow-black/30"
      style={{ transform: `translate(clamp(0px, ${rect.left - 4}px, calc(100vw - 8px - 100%)), clamp(0px, ${rect.bottom}px, calc(100vh - 8px - 100%)))` }}>
      <div className="max-h-[min(24rem,calc(100vh-24px))] overflow-y-auto">
        {hiddenTabs.map(tab => <button key={tab.id} className={buttonClass} onClick={() => run(() => onSelectTab(tab.id))}>
          <span className="max-w-[280px] truncate" title={terminalTabLabel(terminalChannels(tab, channels), channels.length)}>{terminalTabLabel(terminalChannels(tab, channels), channels.length)}</span>
        </button>)}
        <button
          className={buttonClass}
          onClick={() => run(onAddTab)}
          title="Add tab for active channel"
          aria-label="Add tab for active channel"
        >
          <PlusIcon size={12} />
        </button>
      </div>
    </div>
  </>, document.body);
}
