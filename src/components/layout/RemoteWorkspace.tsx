import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { RemoteStatus, RemoteWorkspaceSnapshot } from '../../types';
import { RemoteChannelPanel } from './RemoteChannelPanel';
import { RemoteCanvasPanel } from './RemoteCanvasPanel';

export const RemoteWorkspace: React.FC = () => {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [snapshot, setSnapshot] = useState<RemoteWorkspaceSnapshot | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [name, setName] = useState('');
  const [type, setType] = useState<'serial' | 'tcp' | 'ble'>('serial');
  const [autoScroll, setAutoScroll] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const lastPeer = useRef<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const connected = !!status?.connected;
  const peerId = status?.connected?.id;

  useEffect(() => {
    const mode = snapshot?.themeMode ?? 'light';
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const contrastQuery = window.matchMedia('(forced-colors: active)');
    const apply = () => {
      const dark = mode === 'dark' || mode === 'high-contrast' || (mode === 'system' && darkQuery.matches);
      const contrast = mode.startsWith('high-contrast') || (mode === 'system' && contrastQuery.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('high-contrast', contrast && dark);
      document.documentElement.classList.toggle('high-contrast-light', contrast && !dark);
    };
    apply(); darkQuery.addEventListener('change', apply); contrastQuery.addEventListener('change', apply);
    return () => { darkQuery.removeEventListener('change', apply); contrastQuery.removeEventListener('change', apply); };
  }, [snapshot?.themeMode]);

  useEffect(() => {
    if (!peerId) return;
    sequence.current = 0;
    setSnapshot(null);
    void invoke<RemoteWorkspaceSnapshot | null>('remote_snapshot').then(value => {
      if (value?.version === 1) { sequence.current = value.sequence; setSnapshot(value); }
    }).catch(error => setError(String(error)));
  }, [peerId]);

  useEffect(() => {
    if (status?.connected) { lastPeer.current = status.connected.id; setReconnectAttempt(0); return; }
    if (!status?.reconnectAllowed || status.connecting || !lastPeer.current || reconnectAttempt >= 3) return;
    const timer = setTimeout(() => {
      sequence.current = 0;
      setReconnectAttempt(attempt => attempt + 1);
      void invoke('remote_reconnect', { id: lastPeer.current }).catch(error => setError(String(error)));
    }, [1000, 3000, 8000][reconnectAttempt]);
    return () => clearTimeout(timer);
  }, [status?.connected, status?.connecting, status?.reconnectAllowed, reconnectAttempt]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const accept = (value: RemoteWorkspaceSnapshot | null) => {
      if (!disposed && value?.version === 1 && value.sequence >= sequence.current) {
        sequence.current = value.sequence; setSnapshot(value);
      }
    };
    const add = (promise: Promise<() => void>) => { void promise.then(fn => { if (disposed) fn(); else unlisteners.push(fn); }).catch(error => setError(String(error))); };
    add(listen<RemoteWorkspaceSnapshot>('remote-snapshot', event => accept(event.payload)));
    add(listen<RemoteStatus>('remote-status', event => { if (!disposed) setStatus(event.payload); }));
    void invoke<RemoteWorkspaceSnapshot | null>('remote_snapshot').then(accept).catch(error => setError(String(error)));
    const refresh = () => { void invoke<RemoteStatus>('remote_status').then(value => { if (!disposed) setStatus(value); }).catch(error => setError(String(error))); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { disposed = true; clearInterval(timer); unlisteners.forEach(fn => fn()); };
  }, []);

  const act = useCallback(async (action: string, args: Record<string, unknown> = {}) => {
    if (!connected) throw new Error('Remote device is disconnected');
    setPending(count => count + 1); setError('');
    try { return await invoke<unknown>('remote_action', { action, args }); }
    catch (error) { setError(String(error)); throw error; }
    finally { setPending(count => count - 1); }
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    void act('workspace.watch', { channelId, canvasId }).catch(() => {});
  }, [act, connected, channelId, canvasId]);
  useEffect(() => {
    if (autoScroll && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [snapshot?.entries, autoScroll]);

  return <div className="remote-ui flex h-screen flex-col overflow-hidden bg-road text-text-primary">
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
      <strong>Remote · {status?.connected?.name ?? 'Disconnected'}</strong>
      <span className={`text-xs ${connected ? 'text-accent-green' : 'text-accent-red'}`}>{connected ? `${status?.transport === 'direct' ? 'Direct' : status?.transport === 'relay' ? 'Relay' : 'Encrypted'} · ${status?.rttMs ?? '—'} ms` : status?.connecting ? 'Reconnecting…' : 'Controls unavailable'}</span>
      <span className="ml-auto text-xs text-text-secondary">{pending ? 'Working…' : 'Your local workspace is separate'}</span>
      <button className="btn-channel-action px-3" disabled={!connected && !status?.reconnectAllowed} onClick={() => void invoke('remote_disconnect').catch(error => setError(String(error)))}>Disconnect</button>
    </header>
    {error && <div role="alert" className="shrink-0 border-b border-border px-4 py-2 text-sm text-accent-red">{error}</div>}
    {!connected && <div className="border-b border-border px-4 py-3 text-sm text-text-secondary">{status?.reconnectAllowed && reconnectAttempt < 3 ? 'Connection lost. Trying to reconnect…' : 'Connection closed. Reconnect from Remote access on the main window.'} Previously received data remains visible; operations are never replayed automatically.</div>}
    <div className="flex min-h-0 flex-1 gap-1 p-1">
      <aside className="flex w-52 shrink-0 flex-col overflow-auto rounded-xl border border-border bg-surface-secondary p-2 text-sm">
        <button className={`rounded-lg px-2 py-2 text-left ${!channelId && !canvasId ? 'bg-[var(--layer-selected)]' : ''}`} onClick={() => { setChannelId(null); setCanvasId(null); }}>All terminal traffic</button>
        <p className="px-2 pb-1 pt-4 text-xs text-text-secondary">CHANNELS</p>
        {snapshot?.channels.map(item => <button key={item.channel.id} title={item.channel.name} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--layer-hover)] ${channelId === item.channel.id && !canvasId ? 'bg-[var(--layer-selected)]' : ''}`} onClick={() => { setChannelId(item.channel.id); setCanvasId(null); }}><span className="min-w-0 flex-1 truncate">{item.channel.name}</span><span className={item.channel.state === 'connected' ? 'text-accent-green' : 'text-text-secondary'}>{item.channel.type === 'serial' ? 'UART' : item.channel.type.toUpperCase()}</span></button>)}
        <form className="mt-2 space-y-2 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); void act('channel.create', { type, name }).then(id => { setName(''); if (typeof id === 'string') { setChannelId(id); setCanvasId(null); } }).catch(() => {}); }}>
          <input className="input-base w-full" aria-label="New remote channel name" placeholder="New channel name" value={name} onChange={event => setName(event.target.value)} disabled={!connected} />
          <div className="flex gap-2"><select className="input-base min-w-0 flex-1" aria-label="New remote channel type" value={type} onChange={event => setType(event.target.value as typeof type)}><option value="serial">UART</option><option value="ble">BLE</option><option value="tcp">TCP / UDP</option></select><button type="submit" className="btn-channel-action px-2" disabled={!connected || !name.trim() || pending > 0}>Add</button></div>
        </form>
        <p className="px-2 pb-1 pt-5 text-xs text-text-secondary">CANVASES</p>
        {snapshot?.canvases.map(canvas => <button key={canvas.id} className={`truncate rounded-lg px-2 py-2 text-left hover:bg-[var(--layer-hover)] ${canvasId === canvas.id ? 'bg-[var(--layer-selected)]' : ''}`} onClick={() => setCanvasId(canvas.id)}>{canvas.name || canvas.config.type}</button>)}
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface">
        {!snapshot ? <p className="p-5 text-sm text-text-secondary">Waiting for the host workspace…</p> : canvasId ? <fieldset className="flex min-h-0 min-w-0 flex-1 flex-col" disabled={!connected}>
          <RemoteCanvasPanel key={canvasId} snapshot={snapshot} canvasId={canvasId} act={act} />
        </fieldset> : <>
          {channelId && snapshot.channels.find(item => item.channel.id === channelId) && <fieldset className="max-h-[65%] shrink-0 overflow-auto" disabled={!connected || pending > 0}>
            <RemoteChannelPanel key={channelId} item={snapshot.channels.find(item => item.channel.id === channelId)!} snapshot={snapshot} act={act} />
          </fieldset>}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-text-secondary"><span>Recent terminal history · up to 300 entries · live updates</span><label className="ml-auto flex items-center gap-2"><input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />Auto-scroll</label></div>
          <div ref={outputRef} className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5" aria-label="Remote terminal">
            {snapshot.entries.filter(entry => !channelId || entry.sourceChannelId === channelId).map(entry => <div key={entry.id} className={`whitespace-pre-wrap break-all ${entry.kind === 'tx' ? 'text-accent-green' : entry.kind === 'system' ? 'text-text-secondary' : 'text-text-primary'}`}><span className="text-text-secondary">{new Date(entry.timestamp).toLocaleTimeString()} {entry.sourceLabel ? `[${entry.sourceLabel}] ` : ''}</span>{entry.text}</div>)}
          </div>
        </>}
      </main>
    </div>
  </div>;
};
