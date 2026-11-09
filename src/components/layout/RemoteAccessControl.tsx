import { applyClientSnapshot, endRemoteWorkspace, flushRemoteLayout, prepareRemoteWorkspace } from '../../lib/remoteClient';
import { useRemoteStore } from '../../stores/remoteStore';
import type { RemoteWorkspaceSnapshot } from '../../types';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useBle, useSerial, useTcp } from '../../hooks';
import { toast } from '../../stores';
import type { RemoteHostRequest, RemoteStatus } from '../../types';
import { buildRemoteSnapshot, executeRemoteAction, type RemoteWatch } from '../../lib/remoteHost';
import { SettingGroup, SettingSwitch, ToggleSetting } from './SettingsControls';
import { CloseIcon, CopyIcon, RefreshIcon } from '../common/Icons';

const actionClass = 'inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-border bg-[var(--layer-hover)] px-2.5 py-1 text-xs leading-4 text-text-secondary transition-colors hover:bg-[var(--layer-active)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

const EMPTY_STATUS: RemoteStatus = { enabled: false, endpointId: null, pending: null, trusted: [], recent: [], controller: null, connected: null, connecting: false, transport: null, rttMs: null, reconnectAllowed: false };

export const RemoteAccessControl: React.FC<{ ready: boolean; container: HTMLElement | null; onConnected?: () => void }> = ({ ready, container, onConnected }) => {
  const serial = useSerial();
  const tcp = useTcp();
  const ble = useBle();
  const adapters = useRef({ serial, tcp, ble });
  adapters.current = { serial, tcp, ble };
  const [status, setStatus] = useState<RemoteStatus>(EMPTY_STATUS);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingOperations = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const invitation = status.invitation ?? '';
  const remaining = Math.max(0, Math.ceil(((status.inviteExpiresAt ?? now) - now) / 1000));
  const expiry = status.persistentInvite ? 'Persistent' : remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Expired';
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const watch = useRef<RemoteWatch>({ channelId: null, canvasId: null });
  const dialogRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let sequence = 0;
    let publishing = false;
    let previous = '';
    let lastPublished = 0;
    const unlisteners: Array<() => void> = [];
    const register = (promise: Promise<() => void>) => { void promise.then(fn => { if (disposed) fn(); else unlisteners.push(fn); }).catch(error => toast.error(String(error))); };
    register(listen<RemoteStatus>('remote-status', event => {
      if (disposed) return;
      statusRef.current = event.payload;
      setStatus(event.payload);
      useRemoteStore.setState({ connected: !!event.payload.connected, name: event.payload.connected?.name ?? '', controller: event.payload.controller });
      if (!event.payload.connected && !event.payload.connecting && useRemoteStore.getState().active) endRemoteWorkspace();
      if (event.payload.pending) setOpen(true);
    }));
    register(listen<RemoteWorkspaceSnapshot>('remote-snapshot', event => {
      if (disposed) return;
      if (!event.payload || event.payload.version !== 1) return;
      try { applyClientSnapshot(event.payload); } catch (error) { setError(String(error)); }
    }));
    register(listen<RemoteHostRequest>('remote-host-request', event => {
      if (disposed) return;
      const { id, action, args } = event.payload;
      // The Rust session already checked peer identity and its command allowlist.
      void invoke<boolean>('remote_request_active', { id }).then(active => {
        if (!active || disposed) throw new Error('Remote request expired or access was revoked');
        return executeRemoteAction(action, args, adapters.current, watch.current);
      })
        .then(value => invoke('remote_respond', { id, value: value ?? null, error: null }))
        .catch(error => invoke('remote_respond', { id, value: null, error: String(error) }))
        .catch(error => console.error('Remote response failed:', error));
    }));
    void invoke<RemoteStatus>('remote_status').then(async value => {
      if (disposed) return;
      setStatus(value);
      useRemoteStore.setState({ connected: !!value.connected, name: value.connected?.name ?? '', controller: value.controller });
      if (value.connected) { const snapshot = await invoke<RemoteWorkspaceSnapshot | null>('remote_snapshot'); if (!disposed && snapshot) applyClientSnapshot(snapshot); }
    }).catch(error => setError(String(error)));
    const timer = window.setInterval(() => {
      if (!statusRef.current.enabled || publishing) return;
      // Bound traffic to five snapshots/second and coalesce unchanged state.
      const snapshot = buildRemoteSnapshot(watch.current, 0);
      const encoded = JSON.stringify(snapshot);
      // A heartbeat also detects a suspended/unresponsive host UI.
      if (previous === encoded && Date.now() - lastPublished < 5000) return;
      publishing = true;
      void invoke('remote_publish', { snapshot: { ...snapshot, sequence: ++sequence } })
        .then(() => { previous = encoded; lastPublished = Date.now(); })
        .catch(error => setError(String(error)))
        .finally(() => { publishing = false; });
    }, 200);
    return () => { disposed = true; clearInterval(timer); unlisteners.forEach(fn => fn()); };
  }, [ready]);

  useEffect(() => {
    if (!open || container) return;
    const first = dialogRef.current?.querySelector<HTMLElement>('button, input, textarea');
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !statusRef.current.pending) setOpen(false);
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? [])];
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open, container]);

  const run = async (operation: () => Promise<unknown>, allowConcurrent = false) => {
    // Guard synchronously, including clicks before React commits the busy state.
    if (pendingOperations.current > 0 && !allowConcurrent) return;
    pendingOperations.current += 1;
    setBusy(true); setError('');
    try { await operation(); }
    catch (error) { setError(String(error)); }
    finally {
      try { setStatus(await invoke<RemoteStatus>('remote_status')); } catch { /* Keep the operation error visible. */ }
      pendingOperations.current -= 1;
      setBusy(pendingOperations.current > 0);
    }
  };
  const connect = (ticket: string) => run(async () => { await prepareRemoteWorkspace(); await invoke('remote_connect', { invitation: ticket }); onConnected?.(); setOpen(false); });

  const content = (open || container) ? (
        <div className="min-w-0 space-y-5" aria-busy={busy}>
          {error && <p role="alert" className="break-words text-accent-red">{error}</p>}
          {status.pending && <section className="space-y-2 rounded-xl border border-accent-yellow p-3">
            <p><strong>{status.pending.name}</strong> requests control of this LinkAssist.</p>
            <p className="break-all font-mono text-xs text-text-secondary">{status.pending.id}</p>
            <p className="text-xs text-text-secondary">Allowing pairs this device for future connections while remote access is enabled. It can operate channels and run your configured scripts.</p>
            <div className="flex gap-2"><button className="btn-channel-action px-3" aria-disabled={busy} onClick={() => void run(() => invoke('remote_approve', { requestId: status.pending!.requestId, allow: true }))}>Allow and pair</button>
              <button className="btn-channel-action px-3" aria-disabled={busy} onClick={() => void run(() => invoke('remote_approve', { requestId: status.pending!.requestId, allow: false }))}>Reject</button></div>
          </section>}
          <div className="grid min-w-0 grid-cols-1 items-start">
            <section aria-label="Allow remote" className="min-w-0">
              <SettingGroup title="Local access">
                <div className="py-0">
                  <ToggleSetting title="Allow remote" checked={status.enabled} pending={busy}
                    onChange={enabled => void run(() => invoke('remote_enable', { enabled }))} />
                  {status.controller && <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
                    <span className="min-w-0 break-words text-[13px] text-accent-blue">Controlled by {status.controller.name}</span>
                    <button className={actionClass} aria-disabled={busy} onClick={() => void run(() => invoke('remote_enable', { enabled: false }))}>Take back control</button>
                  </div>}
                </div>
                {status.enabled && <div className="space-y-3 py-3">
                  <div className="text-[13px] font-semibold text-text-primary">Pairing code</div>
                  <div className="flex min-w-0 items-center gap-2">
                    <input aria-label="Pairing invitation" className="remote-pairing-code min-w-0 flex-1 bg-transparent py-1 text-left font-mono text-xs text-text-primary" readOnly value={invitation} onFocus={event => event.target.select()} onClick={event => event.currentTarget.select()} />
                    <span aria-label="Pairing code validity" className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-secondary">{invitation ? expiry : 'No code'}</span>
                    <button className="btn-icon shrink-0" aria-label="Copy pairing code" title="Copy pairing code" aria-disabled={busy || !invitation} disabled={!invitation} onClick={() => void run(() => navigator.clipboard.writeText(invitation))}><CopyIcon size={16} /></button>
                    <button className="btn-icon shrink-0" aria-label="Refresh pairing code" title="Refresh pairing code" aria-disabled={busy} onClick={() => void run(() => invoke('remote_invite'))}><RefreshIcon size={16} /></button>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0 flex-1 text-[12px] leading-5 text-text-secondary">Keep this pairing code valid between sessions</span>
                    <SettingSwitch label="Persistent" checked={!!status.persistentInvite} pending={busy} onChange={persistent => void run(() => invoke('remote_invite', { persistent }))} />
                  </div>
                </div>}
                {status.enabled && <ToggleSetting title="Connect without local approval" checked={!!status.noApproval} pending={busy}
                  onChange={enabled => void run(() => invoke('remote_set_no_approval', { enabled }))} />}
              </SettingGroup>
            </section>
            <section aria-label="Connect" className="min-w-0">
              <SettingGroup title="Remote connection">
                <div className="space-y-3 py-3 text-left">
                  <label htmlFor="remote-peer-code" className="block text-left text-[13px] font-semibold text-text-primary">Peer code</label>
                  <div className="flex min-w-0 items-center gap-2">
                    <input id="remote-peer-code" aria-label="Remote pairing invitation" className="remote-peer-code input-base h-7 min-w-0 flex-1 text-left font-mono text-xs leading-4" placeholder="Paste a pairing code" value={target} onChange={event => setTarget(event.target.value)} />
                    <button className={`${actionClass} remote-borderless-action`} aria-disabled={busy || status.connecting || !target.trim() || !!status.connected} disabled={status.connecting || !target.trim() || !!status.connected} onClick={() => void connect(target)}>Connect</button>
                  </div>
                  {status.connecting && <p role="status" className="text-[13px] text-text-secondary">Waiting for connection / approval…</p>}
                  {(status.connected || status.connecting) && <button className={actionClass} aria-disabled={busy && !status.connecting} onClick={() => void run(async () => { await flushRemoteLayout(); await invoke('remote_disconnect'); endRemoteWorkspace(); }, status.connecting)}>Disconnect / cancel</button>}
                  {status.connected && <p className="break-words text-[13px] text-accent-green">Connected to {status.connected.name}.</p>}
                </div>
                {status.recent.length > 0 && <div className="space-y-2 py-3 text-left">
                  <h4 className="text-[13px] font-medium text-text-secondary">Recent devices</h4>
                  {status.recent.map(peer => <div key={peer.id} className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs leading-5 text-text-secondary" title={`${peer.name} (${peer.id})`}>{peer.name}</span><button className={actionClass} aria-disabled={busy || status.connecting || !!status.connected || !peer.invitation} disabled={status.connecting || !!status.connected || !peer.invitation} onClick={() => peer.invitation && void connect(peer.invitation)}>Reconnect</button></div>)}
                </div>}
                {status.trusted.length > 0 && <div className="space-y-2 py-3 text-left">
                  <h4 className="text-[13px] font-semibold text-text-primary">Devices list</h4>
                  {status.trusted.map(peer => <div key={peer.id} className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs leading-5 text-text-secondary" title={`${peer.name} (${peer.id})`}>{peer.name}</span><button className={`${actionClass} remote-borderless-action text-accent-red`} aria-disabled={busy} onClick={() => void run(() => invoke('remote_revoke', { id: peer.id }))}>Revoke</button></div>)}
                </div>}
              </SettingGroup>
            </section>
          </div>
        </div>
  ) : null;
  return <>
    {container && createPortal(<div className="remote-ui" data-no-drag onMouseDown={event => event.stopPropagation()}>{content}</div>, container)}
    {open && !container && createPortal(<div data-no-drag onDoubleClick={event => event.stopPropagation()} className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" onMouseDown={event => { event.stopPropagation(); if (event.target === event.currentTarget && !status.pending) setOpen(false); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="remote-access-title" className="remote-ui flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface-overlay text-sm text-text-primary shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 id="remote-access-title" className="font-semibold">Remote</h2><button className="btn-icon" aria-label="Close remote" onClick={() => setOpen(false)}><CloseIcon size={16} /></button>
        </header>
        <div className="min-h-0 overflow-auto p-5">{content}</div>
      </div>
    </div>, document.body)}
  </>;
};
