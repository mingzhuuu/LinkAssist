import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useSerial } from '../../hooks';
import { useUIStore } from '../../stores';

export function UsbPcapSettings() {
  const directory = useUIStore(s => s.usbpcapDirectory);
  const setDirectory = useUIStore(s => s.setUsbpcapDirectory);
  const { checkUsbpcap, openUsbpcapGuide } = useSerial();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ path?: string; error?: string } | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const buttonClass = 'shrink-0 rounded-lg border border-border px-3 py-1 text-[13px] text-text-secondary hover:bg-[var(--layer-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-blue disabled:opacity-40';

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    const timer = window.setTimeout(() => {
      void checkUsbpcap().then(path => {
        if (!cancelled) setResult({ path });
      }).catch(error => {
        if (!cancelled) setResult({ error: String(error) });
      });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [directory, checkUsbpcap, revision]);

  const browse = async () => {
    setBusy(true);
    setActionError('');
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select USBPcap installation directory', defaultPath: directory || undefined });
      if (typeof selected === 'string') setDirectory(selected);
    } catch (error) {
      setActionError(String(error));
    } finally { setBusy(false); }
  };

  return (
    <div className="py-3 space-y-3">
      <div className="space-y-2">
        <label htmlFor="usbpcap-directory" className="text-[13px] font-semibold text-text-primary">
          USBPcap installation directory
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="usbpcap-directory"
            value={directory}
            onChange={event => setDirectory(event.target.value)}
            placeholder="Auto"
            className="min-w-0 flex-1 basis-48 rounded-lg border border-border bg-surface px-3 py-1 text-[13px] text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-blue"
          />
          <button type="button" disabled={busy} onClick={() => { void browse(); }} className={buttonClass}>Browse</button>
          <button type="button" onClick={() => setDirectory('')} disabled={!directory} className={buttonClass}>Reset</button>
          <button type="button" onClick={() => setRevision(value => value + 1)} className={buttonClass}>Check again</button>
        </div>
        <p role="status" className={`break-all text-[12px] leading-5 ${result?.error ? 'text-accent-red' : 'text-text-secondary'}`}>
          {result === null ? 'Checking USBPcap tool and driver…' : result.error || `Tool and capture interfaces detected: ${result.path}.`}
        </p>
      </div>

      {result?.error ? (
        <div className="border-t border-[var(--divider-default)] pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-text-primary">USBPcap installation guide</div>
              <p className="mt-0.5 text-[12px] leading-5 text-text-secondary">
                Install USBPcap and restart Windows. Run as administrator if capture is denied.
              </p>
            </div>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setActionError('');
                void openUsbpcapGuide().catch(error => setActionError(String(error)));
              }}
            >
              Open USBPcap website
            </button>
          </div>
          {actionError && <p role="alert" className="mt-2 break-words text-[12px] text-accent-red">{actionError}</p>}
        </div>
      ) : null}
    </div>
  );
}
