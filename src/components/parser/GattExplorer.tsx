import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  normalizeBleUuid,
  useBleStore,
  type BleUuidNameKind,
  type BleUuidNames,
} from '../../stores';
import { useBle } from '../../hooks';
import { GattCharacteristic, GattService } from '../../types';
import { ChevronDownIcon, BluetoothIcon, CloseIcon, SendIcon } from '../common/Icons';
import { toast } from '../../stores/toastStore';
import { extractShortUuid, getCharacteristicName, getServiceName } from '../../lib';

// Helper: bytes to hex string
const toHex = (bytes: number[]) =>
  bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');

const toAscii = (bytes: number[]) =>
  bytes.map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');

// Helper: parse hex string to byte array
const hexToBytes = (hex: string): number[] | null => {
  const cleaned = hex.replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(cleaned)) return null;
  const result: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    const byte = parseInt(cleaned.substring(i, i + 2), 16);
    if (isNaN(byte)) return null;
    result.push(byte);
  }
  return result;
};

const formatUuid = (uuid: string): string => {
  const shortUuid = extractShortUuid(uuid);
  if (shortUuid) {
    return shortUuid.toUpperCase();
  }
  return uuid;
};

interface UuidNameTarget {
  kind: BleUuidNameKind;
  uuid: string;
  displayName?: string;
  customName?: string;
}

interface UuidNameMenuState extends UuidNameTarget {
  x: number;
  y: number;
}

interface UuidNameContextMenuProps {
  menu: UuidNameMenuState;
  onClose: () => void;
  onEdit: () => void;
  onReset: () => void;
}

const UuidNameContextMenu: React.FC<UuidNameContextMenuProps> = ({
  menu,
  onClose,
  onEdit,
  onReset,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const menuWidth = 208;
  const menuHeight = menu.customName ? 74 : 42;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - menuHeight - 8));
  const targetLabel = menu.kind === 'service' ? 'service' : 'characteristic';

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        onMouseDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        role="menu"
        aria-label={`${targetLabel} UUID actions`}
        className="fixed z-[9999] min-w-[208px] overflow-hidden rounded-xl border border-border bg-surface-overlay p-1 shadow-xl shadow-black/30 backdrop-blur-sm animate-fade-in"
        style={{ left, top }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <button
          type="button"
          role="menuitem"
          onClick={onEdit}
          className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-[var(--layer-selected)]"
        >
          Edit {targetLabel} name…
        </button>
        {menu.customName && (
          <button
            type="button"
            role="menuitem"
            onClick={onReset}
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-text-secondary transition-colors hover:bg-[var(--layer-selected)] hover:text-text-primary"
          >
            Reset custom name
          </button>
        )}
      </div>
    </>,
    document.body,
  );
};

interface UuidNameDialogProps {
  target: UuidNameTarget;
  overlayContainerRef?: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSave: (name: string) => void;
}

const UuidNameDialog: React.FC<UuidNameDialogProps> = ({
  target,
  overlayContainerRef,
  onClose,
  onSave,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(target.customName ?? target.displayName ?? '');
  const normalizedName = name.trim();
  const targetLabel = target.kind === 'service' ? 'service' : 'characteristic';

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSave = useCallback(() => {
    if (normalizedName) onSave(normalizedName);
  }, [normalizedName, onSave]);

  const overlayContainer = overlayContainerRef?.current;
  const titleId = `ble-${target.kind}-uuid-name-title`;

  return createPortal(
    <div
      className={`${overlayContainer ? 'absolute inset-px rounded-[7px]' : 'fixed inset-0'} z-[9000] flex items-center justify-center bg-transparent px-4 backdrop-blur-sm`}
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.4)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-text-primary">
              Edit {targetLabel} name
            </h2>
            <div className="mt-1 truncate font-mono text-[10px] text-text-muted" title={target.uuid}>
              {formatUuid(target.uuid)}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close name dialog"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 px-5 py-5">
          <label htmlFor="ble-custom-uuid-name" className="block text-xs font-medium text-text-secondary">
            Custom {targetLabel} name
          </label>
          <input
            ref={inputRef}
            id="ble-custom-uuid-name"
            type="text"
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSave();
            }}
            placeholder={`Name this private ${targetLabel} UUID`}
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface-tertiary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-accent-blue/50"
          />
          <p className="text-[10px] text-text-faint">
            Saved for this UUID and reused across BLE devices and channels.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-surface-tertiary/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-overlay"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!normalizedName}
            onClick={handleSave}
            className="rounded-lg bg-accent-blue px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-accent-blue/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    overlayContainer ?? document.body,
  );
};

interface WriteCharacteristicDialogProps {
  characteristicName?: string;
  characteristicUuid: string;
  overlayContainerRef?: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onSend: (bytes: number[]) => Promise<void>;
}

const WriteCharacteristicDialog: React.FC<WriteCharacteristicDialogProps> = ({
  characteristicName,
  characteristicUuid,
  overlayContainerRef,
  onClose,
  onSend,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [writeInput, setWriteInput] = useState('');
  const [sending, setSending] = useState(false);
  const parsedBytes = useMemo(() => hexToBytes(writeInput), [writeInput]);
  const hasInput = writeInput.trim().length > 0;
  const canSend = hasInput && parsedBytes !== null && !sending;

  useEffect(() => {
    inputRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, sending]);

  const handleSend = useCallback(async () => {
    if (!canSend || parsedBytes === null) return;
    setSending(true);
    try {
      await onSend(parsedBytes);
      onClose();
    } catch {
      // The parent reports the write error and the dialog remains open for retry.
    } finally {
      setSending(false);
    }
  }, [canSend, onClose, onSend, parsedBytes]);

  const overlayContainer = overlayContainerRef?.current;

  return createPortal(
    <div
      className={`${overlayContainer ? 'absolute inset-px rounded-[7px]' : 'fixed inset-0'} z-[9000] flex items-center justify-center bg-transparent px-4 backdrop-blur-sm`}
      onMouseDown={() => {
        if (!sending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ble-write-dialog-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_24px_60px_rgba(0,0,0,0.4)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="ble-write-dialog-title" className="text-sm font-semibold text-text-primary">
              Send characteristic data
            </h2>
            {characteristicName && (
              <div className="mt-1 truncate text-xs text-accent-mauve/90" title={characteristicName}>
                {characteristicName}
              </div>
            )}
            <div className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={characteristicUuid}>
              {formatUuid(characteristicUuid)}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close send dialog"
            disabled={sending}
            onClick={onClose}
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-[var(--layer-hover)] hover:text-text-primary disabled:opacity-50"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 px-5 py-5">
          <label htmlFor="ble-write-data" className="block text-xs font-medium text-text-secondary">
            HEX data
          </label>
          <input
            ref={inputRef}
            id="ble-write-data"
            type="text"
            value={writeInput}
            disabled={sending}
            onChange={(event) => setWriteInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSend();
            }}
            placeholder="e.g. 01 A2 FF"
            spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface-tertiary px-3 py-2 font-mono text-sm text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-accent-blue/50 disabled:opacity-50"
          />
          <div className={`text-[10px] ${hasInput && parsedBytes === null ? 'text-accent-red' : 'text-text-faint'}`}>
            {hasInput && parsedBytes === null
              ? 'Enter complete hexadecimal byte pairs.'
              : 'Separate byte pairs with spaces. Press Enter to send.'}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-surface-tertiary/40 px-5 py-3">
          <button
            type="button"
            disabled={sending}
            onClick={onClose}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-overlay disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => void handleSend()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent-blue px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:bg-accent-blue/80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SendIcon className="h-3.5 w-3.5" />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>,
    overlayContainer ?? document.body,
  );
};

interface ServiceSectionProps {
  service: GattService;
  charValues: Record<string, number[]>;
  customUuidNames: BleUuidNames;
  overlayContainerRef?: React.RefObject<HTMLDivElement | null>;
  subscribedCharacteristics: Array<{ serviceUuid: string; charUuid: string }>;
  onRead: (svcUuid: string, charUuid: string) => Promise<void>;
  onWrite: (svcUuid: string, charUuid: string, bytes: number[]) => Promise<void>;
  onSubscribe: (svcUuid: string, charUuid: string) => Promise<void>;
  onUnsubscribe: (svcUuid: string, charUuid: string) => Promise<void>;
  onNameContextMenu: (event: React.MouseEvent, target: UuidNameTarget) => void;
}

const ServiceSection = React.memo(function ServiceSection({
  service,
  charValues,
  customUuidNames,
  overlayContainerRef,
  subscribedCharacteristics,
  onRead,
  onWrite,
  onSubscribe,
  onUnsubscribe,
  onNameContextMenu,
}: ServiceSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const displayUuid = formatUuid(service.uuid);
  const customServiceName = customUuidNames.services[normalizeBleUuid(service.uuid)];
  const serviceName = customServiceName ?? getServiceName(service.uuid);

  return (
    <div className="flex flex-col border-b border-border last:border-b-0">
      {/* Service header — matches device scan row style */}
      <div
        className="flex items-center justify-between px-3 py-1.5 hover:bg-[var(--layer-hover)] transition-colors duration-150"
        onContextMenu={(event) => onNameContextMenu(event, {
          kind: 'service',
          uuid: service.uuid,
          displayName: serviceName,
          customName: customServiceName,
        })}
      >
        <div className="flex items-center gap-3 flex-1 overflow-hidden pr-2">
          <span className="font-mono text-xs text-text-primary truncate" title={service.uuid}>
            {displayUuid}
          </span>
          {serviceName && (
            <span className="text-[10px] text-accent-blue/90 truncate" title={serviceName}>
              {serviceName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="bg-[var(--layer-hover)] text-text-secondary px-1.5 py-0.5 rounded text-[10px] font-mono">
            {service.characteristics.length} char{service.characteristics.length !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} service ${serviceName || displayUuid}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="p-1 hover:bg-[var(--layer-hover)] rounded"
          >
            <ChevronDownIcon
              className={`w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-2 text-xs font-mono space-y-0 divide-y divide-border">
          {service.characteristics.map((char) => {
            const key = `${service.uuid}-${char.uuid}`;
            return (
              <div key={char.uuid}>
                <CharRowWithValue
                  char={char}
                  service={service}
                  customUuidNames={customUuidNames}
                  readValue={charValues[key] ?? null}
                  overlayContainerRef={overlayContainerRef}
                  subscribed={subscribedCharacteristics.some(
                    (item) => item.serviceUuid === service.uuid && item.charUuid === char.uuid
                  )}
                  onRead={onRead}
                  onWrite={onWrite}
                  onSubscribe={onSubscribe}
                  onUnsubscribe={onUnsubscribe}
                  onNameContextMenu={onNameContextMenu}
                />
              </div>
            );
          })}
          {service.characteristics.length === 0 && (
            <div className="py-2 text-[10px] text-text-faint italic">
              No characteristics
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// Wrap CharRow to accept readValue as prop
interface CharRowWithValueProps {
  char: GattCharacteristic;
  service: GattService;
  readValue: number[] | null;
  customUuidNames: BleUuidNames;
  overlayContainerRef?: React.RefObject<HTMLDivElement | null>;
  subscribed: boolean;
  onRead: (svcUuid: string, charUuid: string) => Promise<void>;
  onWrite: (svcUuid: string, charUuid: string, bytes: number[]) => Promise<void>;
  onSubscribe: (svcUuid: string, charUuid: string) => Promise<void>;
  onUnsubscribe: (svcUuid: string, charUuid: string) => Promise<void>;
  onNameContextMenu: (event: React.MouseEvent, target: UuidNameTarget) => void;
}

const CharRowWithValue = React.memo(function CharRowWithValue({
  char,
  service,
  readValue,
  customUuidNames,
  overlayContainerRef,
  subscribed,
  onRead,
  onWrite,
  onSubscribe,
  onUnsubscribe,
  onNameContextMenu,
  }: CharRowWithValueProps) {
  const [busy, setBusy] = useState(false);
  const [readExpanded, setReadExpanded] = useState(false);
  const [writeDialogOpen, setWriteDialogOpen] = useState(false);

  const canRead = char.properties.includes('read');
  const canWrite =
    char.properties.includes('write') ||
    char.properties.includes('write_without_response');
  const canNotify = char.properties.includes('notify');
  const canIndicate = char.properties.includes('indicate');

  const handleRead = useCallback(async () => {
    setReadExpanded(true);
    setBusy(true);
    try {
      await onRead(service.uuid, char.uuid);
    } catch {
      // handled by parent
    } finally {
      setBusy(false);
    }
  }, [onRead, service.uuid, char.uuid]);

  const handleSubscribeToggle = useCallback(async () => {
    setBusy(true);
    try {
      if (subscribed) {
        await onUnsubscribe(service.uuid, char.uuid);
      } else {
        await onSubscribe(service.uuid, char.uuid);
      }
    } catch {
      // handled by parent
    } finally {
      setBusy(false);
    }
  }, [subscribed, onSubscribe, onUnsubscribe, service.uuid, char.uuid]);

  const displayUuid = formatUuid(char.uuid);
  const customCharacteristicName = customUuidNames.characteristics[normalizeBleUuid(char.uuid)];
  const characteristicName = customCharacteristicName ?? getCharacteristicName(char.uuid);

  return (
    <div
      className="flex flex-col py-2"
      onContextMenu={(event) => onNameContextMenu(event, {
        kind: 'characteristic',
        uuid: char.uuid,
        displayName: characteristicName,
        customName: customCharacteristicName,
      })}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,47%)_minmax(0,1fr)_auto] items-center gap-2">
        <span
          className="min-w-0 truncate font-mono text-[10px] text-text-muted"
          title={char.uuid}
        >
          {displayUuid}
        </span>
        <span className="min-w-0 truncate text-[10px] text-accent-mauve/90" title={characteristicName}>
          {characteristicName ?? ''}
        </span>
        <div className="flex gap-0.5 shrink-0">
          {canRead && (
            <button
              type="button"
              title="Read characteristic"
              aria-label={`Read ${characteristicName || displayUuid}`}
              aria-expanded={readExpanded}
              disabled={busy}
              onClick={() => void handleRead()}
              className="bg-accent-blue/20 text-accent-blue px-1 py-0.5 rounded text-[9px] font-bold transition-colors hover:bg-accent-blue/40 disabled:opacity-50"
            >
              R
            </button>
          )}
          {canWrite && (
            <button
              type="button"
              title="Write characteristic"
              aria-label={`Write ${characteristicName || displayUuid}`}
              disabled={busy}
              onClick={() => setWriteDialogOpen(true)}
              className="bg-accent-yellow/20 text-accent-yellow px-1 py-0.5 rounded text-[9px] font-bold transition-colors hover:bg-accent-yellow/40 disabled:opacity-50"
            >
              W
            </button>
          )}
          {canNotify && (
            <button
              type="button"
              title={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} notifications`}
              aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} notifications for ${characteristicName || displayUuid}`}
              aria-pressed={subscribed}
              disabled={busy}
              onClick={() => void handleSubscribeToggle()}
              className={`bg-accent-green/20 text-accent-green px-1 py-0.5 rounded text-[9px] font-bold transition-colors hover:bg-accent-green/40 disabled:opacity-50 ${
                subscribed ? 'ring-1 ring-inset ring-accent-green/70' : ''
              }`}
            >
              N
            </button>
          )}
          {canIndicate && (
            <button
              type="button"
              title={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} indications`}
              aria-label={`${subscribed ? 'Unsubscribe from' : 'Subscribe to'} indications for ${characteristicName || displayUuid}`}
              aria-pressed={subscribed}
              disabled={busy}
              onClick={() => void handleSubscribeToggle()}
              className={`bg-accent-mauve/20 text-accent-mauve px-1 py-0.5 rounded text-[9px] font-bold transition-colors hover:bg-accent-mauve/40 disabled:opacity-50 ${
                subscribed ? 'ring-1 ring-inset ring-accent-mauve/70' : ''
              }`}
            >
              I
            </button>
          )}
        </div>
      </div>

      {readExpanded && (
        <div className="mt-1.5 space-y-1 rounded-lg bg-surface-tertiary/60 px-2 py-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <span className="w-9 shrink-0 text-[9px] font-semibold text-text-faint">HEX</span>
            <span className="min-w-0 flex-1 break-all font-mono text-[10px] text-text-secondary">
              {readValue === null ? (busy ? 'Reading…' : '—') : (toHex(readValue) || '—')}
            </span>
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <span className="w-9 shrink-0 text-[9px] font-semibold text-text-faint">ASCII</span>
            <span className="min-w-0 flex-1 break-all font-mono text-[10px] text-text-secondary">
              {readValue === null ? (busy ? 'Reading…' : '—') : (toAscii(readValue) || '—')}
            </span>
          </div>
        </div>
      )}

      {writeDialogOpen && (
        <WriteCharacteristicDialog
          characteristicName={characteristicName}
          characteristicUuid={char.uuid}
          overlayContainerRef={overlayContainerRef}
          onClose={() => setWriteDialogOpen(false)}
          onSend={(bytes) => onWrite(service.uuid, char.uuid, bytes)}
        />
      )}
    </div>
  );
});

export const GattExplorer: React.FC<{
  channelId: string;
  overlayContainerRef?: React.RefObject<HTMLDivElement | null>;
}> = ({ channelId, overlayContainerRef }) => {
  const {
    channelStates,
    customUuidNames,
    addSubscription,
    removeSubscription,
    setCustomUuidName,
  } = useBleStore();
  const channelState = channelStates[channelId];
  const connectedDeviceId = channelState?.connectedDeviceId ?? null;
  const gattServices = channelState?.gattServices ?? [];
  const subscribedCharacteristics = channelState?.subscribedCharacteristics ?? [];
  const { readCharacteristic, writeCharacteristic, subscribeNotifications, unsubscribeNotifications } = useBle();

  // charValues: key = "svcUuid-charUuid", value = bytes returned by a read.
  const [charValues, setCharValues] = useState<Record<string, number[]>>({});
  const [uuidNameMenu, setUuidNameMenu] = useState<UuidNameMenuState | null>(null);
  const [uuidNameEditor, setUuidNameEditor] = useState<UuidNameTarget | null>(null);

  const handleNameContextMenu = useCallback((event: React.MouseEvent, target: UuidNameTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setUuidNameEditor(null);
    setUuidNameMenu({
      ...target,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const handleRead = useCallback(
    async (svcUuid: string, charUuid: string) => {
      if (!connectedDeviceId) return;
      try {
        const data = await readCharacteristic(connectedDeviceId, svcUuid, charUuid);
        setCharValues((prev) => ({
          ...prev,
          [`${svcUuid}-${charUuid}`]: data,
        }));
      } catch (e) {
        toast.error(`Read failed: ${String(e)}`);
        throw e;
      }
    },
    [connectedDeviceId, readCharacteristic]
  );

  const handleWrite = useCallback(
    async (svcUuid: string, charUuid: string, bytes: number[]) => {
      if (!connectedDeviceId) return;
      try {
        await writeCharacteristic(connectedDeviceId, svcUuid, charUuid, bytes);
        toast.success('Written');
      } catch (e) {
        toast.error(`Write failed: ${String(e)}`);
        throw e;
      }
    },
    [connectedDeviceId, writeCharacteristic]
  );

  const handleSubscribe = useCallback(
    async (svcUuid: string, charUuid: string) => {
      if (!connectedDeviceId) return;
      try {
        await subscribeNotifications(connectedDeviceId, svcUuid, charUuid);
        addSubscription(svcUuid, charUuid, channelId);
        toast.success('Subscribed');
      } catch (e) {
        toast.error(`Subscribe failed: ${String(e)}`);
        throw e;
      }
    },
    [connectedDeviceId, subscribeNotifications, addSubscription, channelId]
  );

  const handleUnsubscribe = useCallback(
    async (svcUuid: string, charUuid: string) => {
      if (!connectedDeviceId) return;
      try {
        await unsubscribeNotifications(connectedDeviceId, svcUuid, charUuid);
        removeSubscription(svcUuid, charUuid, channelId);
        toast.info('Unsubscribed');
      } catch (e) {
        toast.error(`Unsubscribe failed: ${String(e)}`);
        throw e;
      }
    },
    [connectedDeviceId, unsubscribeNotifications, removeSubscription, channelId]
  );

  if (!connectedDeviceId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-faint gap-2">
        <BluetoothIcon size={28} className="opacity-30" />
        <p className="text-xs">Connect a BLE device to explore GATT services</p>
      </div>
    );
  }

  if (gattServices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-faint gap-2">
        <BluetoothIcon size={28} className="opacity-30" />
        <p className="text-xs">No GATT services discovered</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Service list */}
      <div className="pr-1">
        {gattServices.map((service) => (
          <ServiceSection
            key={service.uuid}
            service={service}
            charValues={charValues}
            customUuidNames={customUuidNames}
            overlayContainerRef={overlayContainerRef}
            subscribedCharacteristics={subscribedCharacteristics}
            onRead={handleRead}
            onWrite={handleWrite}
            onSubscribe={handleSubscribe}
            onUnsubscribe={handleUnsubscribe}
            onNameContextMenu={handleNameContextMenu}
          />
        ))}
      </div>
      {uuidNameMenu && (
        <UuidNameContextMenu
          menu={uuidNameMenu}
          onClose={() => setUuidNameMenu(null)}
          onEdit={() => {
            setUuidNameEditor(uuidNameMenu);
            setUuidNameMenu(null);
          }}
          onReset={() => {
            setCustomUuidName(uuidNameMenu.kind, uuidNameMenu.uuid, '');
            setUuidNameMenu(null);
          }}
        />
      )}
      {uuidNameEditor && (
        <UuidNameDialog
          key={`${uuidNameEditor.kind}-${uuidNameEditor.uuid}`}
          target={uuidNameEditor}
          overlayContainerRef={overlayContainerRef}
          onClose={() => setUuidNameEditor(null)}
          onSave={(name) => {
            setCustomUuidName(uuidNameEditor.kind, uuidNameEditor.uuid, name);
            setUuidNameEditor(null);
          }}
        />
      )}
    </div>
  );
};
