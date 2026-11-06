import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { receiveChannelsFor, useTerminalStore } from '../../stores/terminalStore';
import type { ChannelTab } from '../../stores/terminalStore';
import type { Channel } from '../../types';

const accents = { ble: 'blue', serial: 'mauve', tcp: 'green' } as const;

export function terminalChannels(tab: ChannelTab, channels: Channel[]) {
  const receive = receiveChannelsFor(tab);
  return receive === 'all' ? channels : channels.filter(channel => receive.includes(channel.id));
}

export function resolveTerminalLink(tab: ChannelTab, channels: Channel[], query: string) {
  const name = query.trim().toLowerCase();
  if (!name) return { error: 'Usage: /link <channel-name-or-index>' } as const;
  const target = channels.find((ch, index) => ch.name.toLowerCase() === name || ch.id === name || String(index) === name);
  if (!target) return { error: `Channel not found: ${query}` } as const;
  const receive = receiveChannelsFor(tab);
  if (receive !== 'all' && !receive.includes(target.id)) {
    if (receive.length > 1) return { error: 'Select a send target from the channels checked for this tab.' } as const;
    return { receive: [target.id], target };
  }
  return { receive, target };
}

export function terminalTabLabel(selected: Channel[], total: number) {
  if (selected.length === total) return 'ALL';
  return selected.length === 1 ? selected[0].name : 'MIXED';
}

export function terminalTabColor(selected: Channel[]): string | undefined {
  let total = 0;
  let color: string | undefined;
  for (const [type, accent] of Object.entries(accents)) {
    const count = selected.filter(channel => channel.type === type).length;
    if (!count) continue;
    total += count;
    const next = `rgb(var(--accent-${accent}))`;
    color = color ? `color-mix(in srgb, ${color}, ${next} ${100 * count / total}%)` : next;
  }
  return color;
}

interface BindingProps {
  paneId: string;
  tab: ChannelTab;
  channels: Channel[];
}

/** Drop deleted channels and keep at least one receive channel when channels exist. */
export function useValidTerminalChannels(paneId: string | null, tabs: ChannelTab[] | undefined, channels: Channel[]) {
  useEffect(() => {
    if (!paneId || !tabs || !channels.length) return;
    const live = new Set(channels.map(channel => channel.id));
    const configure = useTerminalStore.getState().configureTab;
    for (const tab of tabs) {
      const receive = receiveChannelsFor(tab);
      if (receive === 'all') {
        if (tab.channelId && !live.has(tab.channelId)) configure(paneId, tab.id, receive, null);
        continue;
      }
      const next = receive.filter(id => live.has(id));
      if (next.length === receive.length) continue;
      if (!next.length) next.push(channels[0].id);
      const target = next.length === 1 ? next[0] : (tab.channelId && live.has(tab.channelId) ? tab.channelId : null);
      configure(paneId, tab.id, next, target);
    }
  }, [paneId, tabs, channels]);
}

export function TerminalChannelPicker({ paneId, tab, channels, x, y, onClose }: BindingProps & {
  x: number; y: number; onClose: () => void;
}) {
  const selected = terminalChannels(tab, channels);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [onClose]);
  function toggle(id: string) {
    const ids = selected.map(channel => channel.id);
    const next = ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id];
    if (!next.length) return;
    const target = next.length === 1 ? next[0] : (ids.length > 1 && tab.channelId && next.includes(tab.channelId) ? tab.channelId : null);
    useTerminalStore.getState().configureTab(paneId, tab.id, next.length === channels.length ? 'all' : next, target);
  }
  return createPortal(<>
    <div className="fixed inset-0 z-[9998]" onMouseDown={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} />
    <div role="dialog" aria-label="Select channels" className="fixed left-1 top-1 z-[9999] w-max max-w-[calc(100vw-8px)] overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-xl shadow-black/30" style={{
      // Percentages in translate() use the actual size of the picker.
      transform: `translate(clamp(0px, ${x - 4}px, calc(100vw - 8px - 100%)), clamp(0px, ${y - 4}px, calc(100vh - 8px - 100%)))`,
    }} onContextMenu={e => e.preventDefault()}>
      <div className="max-h-[min(18rem,calc(100vh-10px))] overflow-y-auto p-1.5">
        {!channels.length && <div className="px-3 py-3 text-xs text-text-muted">No channels created</div>}
        {channels.map(channel => {
          const checked = selected.some(item => item.id === channel.id);
          const color = terminalTabColor([channel]);
          return <button key={channel.id} type="button" role="checkbox" aria-checked={checked}
            disabled={checked && selected.length === 1} onClick={() => toggle(channel.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-text-primary hover:bg-[var(--layer-selected)]"
            style={checked ? { backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border" style={checked ? { borderColor: color, backgroundColor: color } : undefined}>
              {checked && <span className="h-1.5 w-1.5 rounded-full bg-road" />}
            </span>
            <span className="shrink-0 text-xs text-text-muted">{channel.type.toUpperCase()}</span><span className="truncate" title={channel.name}>{channel.name}</span>
          </button>;
        })}
      </div>
    </div>
  </>, document.body);
}
