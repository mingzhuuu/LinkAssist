import { useEffect, useRef, useState } from 'react';
import { useCloseStore } from '../../stores/closeStore';

export function CloseConfirmation() {
  const { reason, resolve } = useCloseStore();
  const [always, setAlways] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reason) return;
    setAlways(false);
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [reason]);
  if (!reason) return null;
  return <div className="fixed inset-0 z-[11000] flex items-center justify-center bg-black/40 p-4" data-no-drag>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="close-confirm-title" className="w-full max-w-md rounded-2xl border border-border bg-surface-overlay p-5 text-sm text-text-primary shadow-xl" onKeyDown={event => {
      if (event.key === 'Escape') resolve?.('cancel');
      if (event.key === 'Tab') {
        const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>('button, input') ?? [])];
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons[buttons.length - 1]?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) { event.preventDefault(); buttons[0]?.focus(); }
      }
    }}>
      <h2 id="close-confirm-title" className="font-semibold">{reason === 'remote' ? 'Keep remote access running?' : 'When closing LinkAssist'}</h2>
      <p className="mt-3 text-text-secondary">{reason === 'remote' ? 'Remote access is enabled. Exiting stops remote connections.' : 'Choose whether to exit or hide in the system tray. Select Always to remember your choice.'}</p>
      <label className="mt-4 flex items-center gap-2"><input type="checkbox" checked={always} onChange={event => setAlways(event.target.checked)} />Always</label>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button className="btn-channel-action px-3" onClick={() => resolve?.('background', always)}>Keep in background</button>
        <button className="btn-channel-action px-3" onClick={() => resolve?.('exit', always)}>Exit program</button>
        <button className="btn-channel-action px-3" onClick={() => resolve?.('cancel')}>Cancel</button>
      </div>
    </div>
  </div>;
}
