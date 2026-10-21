import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { useCanvasStore, useChannelStore, useSerialStore, useTcpStore, useBleStore } from '../../stores';
import { useTerminalStore } from '../../stores/terminalStore';
import { Canvas, FormConfig, FormMode, Channel, ParsedField, ParseResult, ProtocolFileSummary } from '../../types';
import { buildFormPacket, encodeFormFieldResult } from './canvasDataUtils';
import { buildFormulaVariableDefinitions, FormulaVariableContext } from './formulaUtils';
import { getFormInputPlaceholder, shouldShowFormFieldNameColumn } from './formPlaceholderUtils';
import { toast } from '../../stores/toastStore';
import { sendWithImmediateTxEcho } from '../../lib/terminalSend';

interface CanvasFormProps {
  canvasId: string;
  liveWidth?: number;
}

const FORM_ROW_HEIGHT = 36;

interface SerialDataEvent {
  connectionId: string;
  data: number[];
  timestamp: number;
}

interface TcpDataEvent {
  connectionId: string;
  data: number[];
  timestamp: number;
}

interface BleNotificationEvent {
  deviceId: string;
  serviceUuid: string;
  charUuid: string;
  data: number[];
  timestamp: number;
}

interface UdpDataEvent {
  localAddr: string;
  remoteAddr: string;
  data: number[];
  timestamp: number;
}

function textToBytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function findParsedField(fields: ParsedField[], fieldId: string): ParsedField | undefined {
  return fields.find((field) => field.id === fieldId || field.name === fieldId || field.alias === fieldId);
}

function parsedFieldNumber(field: ParsedField | undefined): number | null {
  if (!field) return null;
  return typeof field.value === 'number' ? field.value : null;
}

function useLatestRow(canvasId: string) {
  const storedRows = useCanvasStore((state) => state.dataBuffers[canvasId]);
  return storedRows && storedRows.length > 0 ? storedRows[storedRows.length - 1] : null;
}

function getLabelDisplayUnits(label: string): number {
  return Array.from(label.trim()).reduce((total, char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return total + (codePoint >= 0x2e80 ? 2 : 1);
  }, 0);
}

function getChannelSendInfo(channel: Channel, canvasId: string) {
  if (channel.type === 'serial') {
    const { connectionMap } = useSerialStore.getState();
    const connectionId = Object.entries(connectionMap).find(([, cid]) => cid === channel.id)?.[0];
    return connectionId ? { type: 'serial' as const, connectionId } : null;
  }

  if (channel.type === 'tcp') {
    const { connectionMap } = useTcpStore.getState();
    const udpAddr = Object.entries(connectionMap).find(([key, cid]) => key.startsWith('udp:') && cid === channel.id)?.[0];
    if (udpAddr) {
      return { type: 'udp' as const, addr: udpAddr.replace('udp:', '') };
    }
    const connectionId = Object.entries(connectionMap).find(([, cid]) => cid === channel.id)?.[0];
    if (!connectionId) return null;
    const isServerClient = connectionId.startsWith('server:');
    if (isServerClient) {
      const serverClients = useTcpStore.getState().serverClients;
      return serverClients.length > 0
        ? { type: 'tcp_server' as const, clientId: serverClients[0].id }
        : null;
    }
    return { type: 'tcp' as const, connectionId };
  }

  if (channel.type === 'ble') {
    const { connectedDeviceId, connectedChannelId } = useBleStore.getState();
    const canvas = useCanvasStore.getState().canvases.find((c) => c.id === canvasId);
    const bleTarget = canvas?.config.channels.find((l) => l.channelId === channel.id)?.bleTarget;
    if (connectedDeviceId && connectedChannelId === channel.id && bleTarget) {
      return {
        type: 'ble' as const,
        deviceId: connectedDeviceId,
        serviceUuid: bleTarget.serviceUuid,
        charUuid: bleTarget.charUuid,
      };
    }
    return null;
  }

  return null;
}

export const CanvasForm: React.FC<CanvasFormProps> = ({ canvasId, liveWidth }) => {
  const canvases = useCanvasStore((state) => state.canvases);
  const canvas = canvases.find((c: Canvas) => c.id === canvasId);
  const channels = useChannelStore((state) => state.channels);
  const latestRow = useLatestRow(canvasId);

  const [sendValues, setSendValues] = useState<Record<string, string>>({});
  const [sendStatus, setSendStatus] = useState<'idle' | 'sending' | 'success' | 'timeout'>('idle');
  const [protocolSummary, setProtocolSummary] = useState<ProtocolFileSummary | null>(null);
  const pendingConfirmRef = useRef<{ expected: string; timer: number } | null>(null);
  const statusTimerRef = useRef<number | null>(null);

  const clearStatusTimer = () => {
    if (statusTimerRef.current !== null) {
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = null;
    }
    if (pendingConfirmRef.current !== null) {
      clearTimeout(pendingConfirmRef.current.timer);
      pendingConfirmRef.current = null;
    }
  };

  const formConfig: FormConfig | undefined = canvas?.config.form;
  const formMode: FormMode = formConfig?.mode ?? 'display';
  const rows = formConfig?.rows ?? [];
  const visibleRows = useMemo(() => rows.filter((row) => row.visible !== false), [rows]);
  const showFieldNameColumn = useMemo(() => shouldShowFormFieldNameColumn(rows), [rows]);
  const sendConfig = formConfig?.sendConfig;
  const protocolFile = canvas?.config.dataSource === 'parsed'
    ? canvas.config.channels[0]?.protocolFile
    : null;
  const protocolResourceRoot = canvas?.config.dataSource === 'parsed'
    ? canvas.config.channels[0]?.protocolResourceRoot
    : null;
  const linkedChannel = useMemo(() => {
    const link = canvas?.config.channels[0];
    if (!link) return null;
    return channels.find((c) => c.id === link.channelId) ?? null;
  }, [canvas, channels]);

  const rowsKey = useMemo(() => JSON.stringify(rows.map((r) => ({ id: r.id, dv: r.defaultValue }))), [rows]);

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const row of rows) {
      initial[row.id] = row.defaultValue ?? '';
    }
    setSendValues(initial);
  }, [rowsKey]);

  useEffect(() => {
    let cancelled = false;
    setProtocolSummary(null);

    if (!protocolFile) return;

    invoke<ProtocolFileSummary>('get_lua_protocol_file_summary', {
      filePath: protocolFile,
      resourceRoot: protocolResourceRoot,
    })
      .then((summary) => {
        if (!cancelled) setProtocolSummary(summary);
      })
      .catch((error) => {
        if (!cancelled) console.error('Failed to load form protocol field names:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [protocolFile, protocolResourceRoot]);

  useEffect(() => {
    if (formMode !== 'send' || !sendConfig?.expectedResponse || !linkedChannel) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    const isUdp = linkedChannel.type === 'tcp' &&
      Object.entries(useTcpStore.getState().connectionMap).some(
        ([key, cid]) => key.startsWith('udp:') && cid === linkedChannel.id
      );

    const eventName =
      linkedChannel.type === 'serial'
        ? 'serial-data-received'
        : isUdp
        ? 'udp-data-received'
        : linkedChannel.type === 'tcp'
        ? 'tcp-data-received'
        : linkedChannel.type === 'ble'
        ? 'ble-notification-received'
        : null;

    if (!eventName) return;

    const handleData = (data: number[]) => {
      if (!pendingConfirmRef.current) return;
      const expected = pendingConfirmRef.current.expected;
      const hex = data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = data
        .filter((b) => b >= 32 && b < 127)
        .map((b) => String.fromCharCode(b))
        .join('');
      if (hex.includes(expected) || ascii.includes(expected)) {
        clearTimeout(pendingConfirmRef.current.timer);
        setSendStatus('success');
        pendingConfirmRef.current = null;
      }
    };

    if (eventName === 'serial-data-received') {
      listen<SerialDataEvent>(eventName, (event) => {
        if (cancelled) return;
        const { connectionId } = event.payload;
        const serialChannelId = useSerialStore.getState().connectionMap[connectionId];
        if (serialChannelId === linkedChannel.id) {
          handleData(event.payload.data);
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    } else if (eventName === 'tcp-data-received') {
      listen<TcpDataEvent>(eventName, (event) => {
        if (cancelled) return;
        const tcpState = useTcpStore.getState();
        const isOurs =
          tcpState.clientConnections.some((c) => c.id === event.payload.connectionId) ||
          tcpState.serverClients.some((c) => c.id === event.payload.connectionId);
        if (!isOurs) return;
        const tcpChannelId = tcpState.connectionMap[event.payload.connectionId];
        if (tcpChannelId === linkedChannel.id) {
          handleData(event.payload.data);
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    } else if (eventName === 'udp-data-received') {
      listen<UdpDataEvent>(eventName, (event) => {
        if (cancelled) return;
        const udpChannelId = useTcpStore.getState().connectionMap['udp:' + event.payload.localAddr];
        if (udpChannelId === linkedChannel.id) {
          handleData(event.payload.data);
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    } else if (eventName === 'ble-notification-received') {
      listen<BleNotificationEvent>(eventName, (event) => {
        if (cancelled) return;
        const bleState = useBleStore.getState();
        if (bleState.connectedChannelId === linkedChannel.id) {
          handleData(event.payload.data);
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    }

    return () => {
      cancelled = true;
      unlisten?.();
      clearStatusTimer();
    };
  }, [formMode, sendConfig?.expectedResponse, linkedChannel]);

  if (!canvas || !formConfig) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-text-muted">
        Configure form fields to begin.
      </div>
    );
  }

  const executeSend = async (packet: number[]) => {
    if (!linkedChannel) {
      toast.error('No channel linked to this form');
      return;
    }

    const sendInfo = getChannelSendInfo(linkedChannel, canvasId);
    if (!sendInfo) {
      toast.error('Channel is not connected');
      return;
    }

    if (packet.length === 0) {
      toast.error('Failed to encode data. Check input format (e.g. Hex must have even number of characters).');
      return;
    }

    clearStatusTimer();
    setSendStatus('sending');

    if (sendConfig?.expectedResponse) {
      const timeout = sendConfig.timeout ?? 5000;
      pendingConfirmRef.current = {
        expected: sendConfig.expectedResponse,
        timer: window.setTimeout(() => {
          setSendStatus('timeout');
          pendingConfirmRef.current = null;
        }, timeout),
      };
    }

    const hexStr = packet.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const txLine = `TX(HEX): ${hexStr}`;

    try {
      await sendWithImmediateTxEcho(
        () => {
          useTerminalStore.getState().appendEntryToChannel(linkedChannel.id, 'tx', txLine);
        },
        async () => {
          if (sendInfo.type === 'serial') {
            await invoke('send_serial_data', { connectionId: sendInfo.connectionId, data: packet });
          } else if (sendInfo.type === 'tcp') {
            await invoke('tcp_send', { connectionId: sendInfo.connectionId, data: packet });
          } else if (sendInfo.type === 'tcp_server') {
            await invoke('tcp_server_send', { clientId: sendInfo.clientId, data: packet });
          } else if (sendInfo.type === 'ble') {
            await invoke('write_ble_characteristic', {
              deviceId: sendInfo.deviceId,
              serviceUuid: sendInfo.serviceUuid,
              charUuid: sendInfo.charUuid,
              data: packet,
            });
          } else if (sendInfo.type === 'udp') {
            await invoke('udp_send', { addr: sendInfo.addr, data: packet });
          }
        }
      );

      if (!sendConfig?.expectedResponse) {
        setSendStatus('success');
        statusTimerRef.current = window.setTimeout(() => setSendStatus('idle'), 1500);
      }
    } catch (error) {
      if (pendingConfirmRef.current !== null) {
        clearTimeout(pendingConfirmRef.current.timer);
        pendingConfirmRef.current = null;
      }
      console.error('Send failed:', error);
      useTerminalStore.getState().appendEntryToChannel(
        linkedChannel.id,
        'system',
        `Send error: ${String(error)}`
      );
      toast.error('Send failed');
      setSendStatus('idle');
    }
  };

  const handleSend = async () => {
    try {
      const formulaVariableDefinitions = buildFormulaVariableDefinitions(
        rows.map((row, index) => ({
          label: row.column.alias || row.label,
          fallback: `row_${index + 1}`,
        })),
      );
      const formulaVariables: FormulaVariableContext = {};
      const encodedRows: Array<{ offset: number; bytes: number[] }> = [];

      for (const [index, row] of rows.entries()) {
        const inputValue = sendValues[row.id] ?? '';

        if (protocolFile && row.parsedFieldId) {
          // Preferred path: the protocol script encodes the field from the input value and
          // returns the bytes plus the absolute frame offset to place them at.
          let encodedField: { offset: number; bytes: number[] } | null = null;
          try {
            encodedField = await invoke<{ offset: number; bytes: number[] }>('encode_field_with_lua_file', {
              filePath: protocolFile,
              resourceRoot: protocolResourceRoot,
              fieldId: row.parsedFieldId,
              value: inputValue,
            });
          } catch (encodeError) {
            // Protocols without an `encode` function fall back to the legacy decode-based path.
            const message = String(encodeError);
            if (!message.includes("global 'encode'")) {
              toast.error(`Protocol field ${row.label}: ${message}`);
              return;
            }
            const result = await invoke<ParseResult>('parse_data_with_lua_file', {
              filePath: protocolFile,
              resourceRoot: protocolResourceRoot,
              data: textToBytes(inputValue),
            });
            const parsedField = findParsedField(result.fields, row.parsedFieldId);
            const bytes = parsedField?.raw_bytes ?? [];
            if (bytes.length === 0) {
              toast.error(`Protocol field ${row.label} did not produce send bytes`);
              return;
            }
            formulaVariables[formulaVariableDefinitions[index].identifier] = parsedFieldNumber(parsedField) ?? undefined;
            encodedRows.push({ offset: 0, bytes });
            continue;
          }
          if (!encodedField || encodedField.bytes.length === 0) {
            toast.error(`Protocol field ${row.label} did not produce send bytes`);
            return;
          }
          encodedRows.push({ offset: encodedField.offset, bytes: encodedField.bytes });
          continue;
        }

        const encoded = encodeFormFieldResult(inputValue, row.column, formulaVariables);
        formulaVariables[formulaVariableDefinitions[index].identifier] = encoded.numericValue ?? undefined;
        encodedRows.push({
          offset: row.column.offset,
          bytes: encoded.bytes,
        });
      }

      const packet = buildFormPacket(encodedRows);
      await executeSend(packet);
    } catch (error) {
      console.error('Failed to encode form send data:', error);
      toast.error('Failed to encode send data');
    }
  };

  const isSendMode = formMode === 'send';
  const canvasWidth = liveWidth ?? canvas.rect.width;
  const isCompactLayout = canvasWidth < 360;
  const widthProgress = Math.min(1, Math.max(0, (canvasWidth - 180) / 280));
  const easedWidthProgress = Math.sqrt(widthProgress);
  const maxLabelUnits = Math.max(0, ...visibleRows.map((row) => getLabelDisplayUnits(row.label)));
  const labelWidthLimit = Math.round(72 + (128 - 72) * easedWidthProgress);
  const labelWidth = Math.max(24, Math.min(labelWidthLimit, Math.round(10 + maxLabelUnits * 6.5)));
  const sendColumnWidth = isSendMode && rows.length > 0
    ? Math.max(52, Math.min(64, Math.round(52 + 12 * easedWidthProgress)))
    : 0;
  const title = canvas.name.trim();

  const statusDot =
    sendStatus === 'sending'
      ? 'bg-yellow-400'
      : sendStatus === 'success'
      ? 'bg-green-400'
      : sendStatus === 'timeout'
      ? 'bg-red-400'
      : 'bg-transparent';
  const statusLabel =
    sendStatus === 'sending'
      ? 'Sending...'
      : sendStatus === 'success'
      ? 'Success'
      : sendStatus === 'timeout'
      ? 'Timeout - no matching response'
      : '';
  const statusClassName =
    sendStatus === 'success'
      ? 'border-green-400/30 bg-green-500/15 text-green-300 shadow-green-500/20'
      : sendStatus === 'timeout'
      ? 'border-red-400/30 bg-red-500/15 text-red-300 shadow-red-500/20'
      : sendStatus === 'sending'
      ? 'border-yellow-400/30 bg-yellow-500/15 text-yellow-300 shadow-yellow-500/20'
      : '';

  return (
    <div className="relative h-full w-full bg-surface flex flex-col overflow-hidden">
      {title && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-surface">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-text-primary">
              {title}
            </span>
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusDot}`}
              title={sendStatus === 'idle' ? 'Idle' : sendStatus}
            />
          </div>
          <span className="text-[10px] text-text-muted">
            {linkedChannel ? linkedChannel.name : 'No channel'}
          </span>
        </div>
      )}

      <div className={`min-h-0 flex-1 overflow-y-auto ${isCompactLayout
        ? 'px-2 pb-2 pt-0'
        : 'px-2.5 pb-2.5 pt-0'}`}>
        <div className="flex items-stretch gap-0">
          <div className="flex-1">
            {rows.length === 0 ? (
              <div className="text-center py-8 text-text-muted text-xs">
                No rows configured. Edit canvas to add rows.
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="text-center py-8 text-text-muted text-xs">
                All rows are hidden.
              </div>
            ) : (
              <div className="flex flex-col">
                {visibleRows.map((row) => {
                  const cellValue = latestRow?.cells[row.column.id] ?? '—';
                  const inputValue = sendValues[row.id] ?? '';
                  const isEditable = isSendMode && (row.editable !== false);

                  return (
                    <div
                      key={row.id}
                      className="canvas-form-row"
                      style={{
                        gridTemplateColumns: showFieldNameColumn
                          ? `${labelWidth}px minmax(0, 1fr)`
                          : 'minmax(0, 1fr)',
                        height: `${FORM_ROW_HEIGHT}px`,
                      }}
                    >
                      {showFieldNameColumn && (
                        <div
                          className="min-w-0 translate-y-1 text-xs font-medium text-text-secondary truncate"
                        >
                          {row.label}
                        </div>
                      )}

                      <div
                        className={`min-w-0 flex-1 ${isSendMode
                          ? 'h-full overflow-hidden'
                          : ''}`}
                      >
                        {isSendMode ? (
                          <input
                            type="text"
                            className="input-base h-full w-full translate-y-1 rounded-none border-0 bg-transparent px-2 py-0 text-xs leading-6"
                            value={inputValue}
                            onChange={(e) =>
                              setSendValues((prev) => ({ ...prev, [row.id]: e.target.value }))
                            }
                            readOnly={!isEditable}
                            placeholder={getFormInputPlaceholder(row, protocolFile, protocolSummary)}
                          />
                        ) : (
                          <div className="translate-y-1 text-xs font-mono text-text-secondary truncate">
                            {cellValue}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {isSendMode && rows.length > 0 && (
            <div
              className="ml-2 flex shrink-0 items-center justify-center p-1"
              style={{ width: `${sendColumnWidth}px` }}
            >
              <button
                className="h-full w-full translate-y-1 rounded-xl border border-border bg-transparent text-xs font-medium text-text-secondary transition-colors hover:bg-surface-secondary disabled:opacity-50"
                onClick={handleSend}
                disabled={sendStatus === 'sending'}
              >
                {sendStatus === 'sending' ? '...' : 'Send'}
              </button>
            </div>
          )}
        </div>
      </div>

      {isSendMode && sendStatus !== 'idle' && (
        <div
          className={`pointer-events-none absolute inset-x-2 bottom-2 z-30 flex h-6 items-center justify-center rounded-xl border px-3 text-center text-[10px] shadow-lg backdrop-blur-sm ${statusClassName}`}
          aria-live="polite"
        >
          {statusLabel}
        </div>
      )}
    </div>
  );
};
