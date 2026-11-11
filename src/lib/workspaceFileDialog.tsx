import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { open, type OpenDialogOptions } from '@tauri-apps/plugin-dialog';
import { isRemoteWorkspace, useRemoteStore } from '../stores/remoteStore';
import { remoteAction } from './remoteClient';

interface DirectoryListing { path: string; parent: string | null; entries: Array<{ name: string; path: string; directory: boolean }> }

/** The same file-selection entry points always operate on the active workspace. */
export const openWorkspaceFile: typeof open = options => {
  if (!isRemoteWorkspace()) return open(options);
  const previousFocus = document.activeElement;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const result = new Promise<string | string[] | null>(resolve => {
    const close = (value: string | string[] | null) => {
      root.unmount(); element.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(value);
    };
    root.render(<RemoteFilePicker options={options ?? {}} onClose={close} />);
  });
  return result as ReturnType<typeof open<typeof options & OpenDialogOptions>>;
};

function RemoteFilePicker({ options, onClose }: { options: OpenDialogOptions; onClose: (value: string | string[] | null) => void }) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [path, setPath] = useState(options.defaultPath ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const browse = async (target: string) => {
    const request = ++generation.current;
    setBusy(true); setError(''); setSelected([]);
    try {
      const next = await remoteAction('workspace.browse', { path: target }) as DirectoryListing;
      if (request !== generation.current) return;
      setListing(next); setPath(next.path);
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    void browse(options.defaultPath ?? '');
    dialog.current?.querySelector('input')?.focus();
    return () => { generation.current++; };
  }, []);
  useEffect(() => useRemoteStore.subscribe(state => { if (!state.active) onClose(null); }), [onClose]);
  const extensions = options.filters?.flatMap(filter => filter.extensions.map(ext => ext.toLowerCase())) ?? [];
  const entries = listing?.entries.filter(entry => entry.directory || (!options.directory && (!extensions.length || extensions.includes('*') || extensions.some(ext => entry.name.toLowerCase().endsWith(`.${ext}`))))) ?? [];
  const choose = (paths: string[]) => { if (paths.length) onClose(options.multiple ? paths : paths[0]); };
  return <div data-no-drag className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/40 p-4" onMouseDown={e => e.stopPropagation()}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={options.title ?? 'Choose a file on the remote computer'}
      className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-border bg-surface-overlay p-4 text-sm text-text-primary window-shadow-dialog-md"
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(null); }
        if (e.key === 'Tab') {
          const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])];
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <h2 className="mb-3 font-semibold">{options.title ?? (options.directory ? 'Select folder' : 'Select file')} · Remote</h2>
      <form className="mb-3 flex gap-2" onSubmit={e => { e.preventDefault(); void browse(path); }}>
        <button type="button" className="btn-channel-action px-3" disabled={busy || !listing?.parent} onClick={() => void browse(listing!.parent!)}>Up</button>
        <input aria-label="Remote folder path" className="input-base min-w-0 flex-1 font-mono" value={path} onChange={e => setPath(e.target.value)} />
        <button className="btn-channel-action px-3" disabled={busy}>Open</button>
      </form>
      {error && <p role="alert" className="mb-2 break-words text-accent-red">{error}</p>}
      <div className="min-h-40 overflow-auto rounded-lg border border-border p-1">
        {busy ? <p className="p-3 text-text-muted">Loading…</p> : entries.map(entry => <button key={entry.path}
          className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-[var(--layer-hover)] focus-visible:outline focus-visible:outline-1 ${selected.includes(entry.path) ? 'bg-[var(--layer-selected)]' : ''}`}
          onClick={e => setSelected(options.multiple && (e.ctrlKey || e.metaKey) ? selected.includes(entry.path) ? selected.filter(p => p !== entry.path) : [...selected, entry.path] : [entry.path])}
          onDoubleClick={() => entry.directory ? void browse(entry.path) : choose([entry.path])}>
          <span className="w-12 shrink-0 text-xs text-text-muted">{entry.directory ? 'Folder' : 'File'}</span><span className="truncate">{entry.name}</span>
        </button>)}
        {!busy && !entries.length && <p className="p-3 text-text-muted">No matching files or folders</p>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn-channel-action px-3" onClick={() => onClose(null)}>Cancel</button>
        <button className="btn-channel-action px-3" disabled={busy || !listing} onClick={() => {
          const target = listing?.entries.find(entry => entry.path === selected[0]);
          if (target?.directory && !options.directory) { void browse(target.path); return; }
          choose(selected.length ? selected : options.directory && listing ? [listing.path] : []);
        }}>Select</button>
      </div>
    </div>
  </div>;
}
