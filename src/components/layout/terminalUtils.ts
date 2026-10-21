import type { TerminalDataFormat } from '../../stores/uiStore';
import type { SelectOption } from '../../stores/terminalStore';
import type { GattService } from '../../types';

const BLE_BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

export interface ParsedTerminalPayload {
  bytes: number[];
  modeLabel: 'ASCII' | 'ASCII+NUL' | 'HEX';
}

export interface TerminalDisplayEntry {
  kind: 'rx' | 'tx' | 'system';
  timestamp: number;
  text: string;
  data?: number[];
  bleMetadata?: {
    serviceUuid: string;
    charUuid: string;
  };
  sourceLabel?: string;
}

export interface TerminalEntryFormatOptions {
  promptText: string;
  showTimestamp: boolean;
  showInputPrefix: boolean;
  sendFormat: TerminalDataFormat;
  receiveFormat: TerminalDataFormat;
  aggregate?: boolean;
}

export interface TerminalEntryParts {
  leadingText: string;
  marker: '<' | '>';
  metadata?: string;
  payload: string;
  continuationIndent: string;
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function formatInputTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}.***`;
}

export function toHex(data: number[]): string {
  return data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function parseHexInput(input: string): number[] | null {
  const clean = input.replace(/\s/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return null;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    const val = parseInt(clean.slice(i, i + 2), 16);
    if (isNaN(val)) return null;
    bytes.push(val);
  }
  return bytes;
}

export function parseTerminalPayload(raw: string): ParsedTerminalPayload | null {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    const content = raw.slice(1, -1);
    return {
      bytes: Array.from(new TextEncoder().encode(content)),
      modeLabel: 'ASCII',
    };
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    const content = raw.slice(1, -1);
    return {
      bytes: [...Array.from(new TextEncoder().encode(content)), 0x00],
      modeLabel: 'ASCII+NUL',
    };
  }

  const parsed = parseHexInput(raw);
  if (!parsed) return null;
  return { bytes: parsed, modeLabel: 'HEX' };
}

export function formatBleUuid(uuid: string): string {
  const lower = uuid.toLowerCase();
  if (lower.length === 36 && lower.startsWith('0000') && lower.endsWith(BLE_BASE_UUID_SUFFIX)) {
    return uuid.substring(4, 8).toUpperCase();
  }
  return uuid;
}

function stripPromptChevron(promptText: string): string {
  return promptText.endsWith('>') ? promptText.slice(0, -1) : promptText;
}

function makeDirectionPrefix(promptText: string, kind: 'rx' | 'tx', showInputPrefix: boolean): string {
  const marker = kind === 'tx' ? '>' : '<';
  if (!showInputPrefix) return marker;

  const promptBase = stripPromptChevron(promptText);
  return promptBase ? `${promptBase}${marker}` : marker;
}

function stripTxLabel(text: string): string {
  const match = /^TX(?:\([^)]+\))?:\s*(.*)$/.exec(text);
  return match?.[1] ?? text;
}

function stripRxLabel(text: string): string {
  const match = /^(?:((?:\[[^\]]+\]\s*)+))?RX:\s*(.*)$/.exec(text);
  if (!match) return text;

  const metadata = match[1]?.trim();
  const payload = match[2] ?? '';
  return metadata ? `${metadata} ${payload}`.trim() : payload;
}

export interface BleWriteSelectionMenu {
  options: SelectOption[];
  lines: string[];
}

export function buildBleWriteSelectionMenu(services: GattService[]): BleWriteSelectionMenu {
  const options: SelectOption[] = [];
  const lines = ['━━━ Select writable characteristic ━━━'];

  for (const service of services) {
    const writableCharacteristics = service.characteristics.filter(characteristic => (
      characteristic.properties.includes('write')
      || characteristic.properties.includes('write_without_response')
    ));
    if (writableCharacteristics.length === 0) continue;

    lines.push(`  Service: ${formatBleUuid(service.uuid)}`);
    writableCharacteristics.forEach((characteristic, characteristicIndex) => {
      const properties: string[] = [];
      if (characteristic.properties.includes('write')) properties.push('W');
      if (characteristic.properties.includes('write_without_response')) properties.push('WNR');
      if (characteristic.properties.includes('notify')) properties.push('N');
      if (characteristic.properties.includes('indicate')) properties.push('I');

      const optionIndex = options.length + 1;
      const serviceLabel = formatBleUuid(service.uuid);
      const characteristicLabel = formatBleUuid(characteristic.uuid);
      options.push({
        idx: optionIndex,
        serviceUuid: service.uuid,
        charUuid: characteristic.uuid,
        label: `${serviceLabel}/${characteristicLabel}`,
      });

      const branch = characteristicIndex === writableCharacteristics.length - 1 ? '└─' : '├─';
      lines.push(`    ${branch} ${optionIndex}) Characteristic: ${characteristicLabel}  [${properties.join(',')}]`);
    });
  }

  if (options.length > 0) lines.push('  Enter number to select:');
  return { options, lines };
}

export function formatTerminalBytes(data: number[], format: TerminalDataFormat): string {
  if (format === 'hex') return toHex(data);

  let result = '';
  for (let index = 0; index < data.length; index++) {
    const byte = data[index];
    if (byte === 0x00 || byte === 0x07) {
      continue;
    }
    if (byte === 0x08) {
      if (result.length > 0 && !result.endsWith('\n')) {
        result = result.slice(0, -1);
      }
      continue;
    }
    if (byte === 0x09) {
      result += '\t';
      continue;
    }
    if (byte === 0x0b || byte === 0x0c) {
      result += '\n';
      continue;
    }
    if (byte === 0x0d) {
      if (data[index + 1] === 0x0a) index++;
      result += '\n';
      continue;
    }
    if (byte === 0x0a) {
      result += '\n';
      continue;
    }
    if (byte === 0x1b) {
      result += '\\e';
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      result += String.fromCharCode(byte);
      continue;
    }
    result += `\\x${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return result;
}

function formatRxPayload(text: string, data: number[] | undefined, format: TerminalDataFormat): string {
  if (!data) return stripRxLabel(text);

  const match = /^(?:((?:\[[^\]]+\]\s*)+))?RX:\s*/.exec(text);
  const metadata = match?.[1]?.trim();
  const payload = formatTerminalBytes(data, format);
  return metadata ? `${metadata} ${payload}` : payload;
}

export function formatTerminalEntryParts(
  entry: TerminalDisplayEntry,
  options: TerminalEntryFormatOptions
): TerminalEntryParts | null {
  const { promptText, showTimestamp, showInputPrefix, sendFormat, receiveFormat, aggregate } = options;

  if (entry.kind === 'tx' || entry.kind === 'rx') {
    const directionPrefix = makeDirectionPrefix(promptText, entry.kind, showInputPrefix);
    const marker = directionPrefix.slice(-1) as '<' | '>';
    const prefix = directionPrefix.slice(0, -1);
    const payload = entry.kind === 'tx'
      ? (entry.data ? formatTerminalBytes(entry.data, sendFormat) : stripTxLabel(entry.text))
      : formatRxPayload(entry.text, entry.data, receiveFormat);
    const timestampPrefix = showTimestamp ? formatTimestamp(entry.timestamp) : '';
    const timestampSeparator = showTimestamp && showInputPrefix ? ' ' : '';
    const leadingText = `${timestampPrefix}${timestampSeparator}${prefix}`;
    const linePrefix = `${leadingText}${marker} `;
    const continuationIndent = ' '.repeat(linePrefix.length);
    const metadataParts: string[] = [];
    if (aggregate && entry.sourceLabel) metadataParts.push(`[${entry.sourceLabel}]`);
    if (entry.bleMetadata) {
      metadataParts.push(`[${formatBleUuid(entry.bleMetadata.serviceUuid)}/${formatBleUuid(entry.bleMetadata.charUuid)}]`);
    }
    const metadata = metadataParts.length > 0 ? metadataParts.join(' ') : undefined;
    return {
      leadingText,
      marker,
      metadata,
      payload: payload.replace(/\n/g, `\n${continuationIndent}`),
      continuationIndent,
    };
  }

  return null;
}

export function formatTerminalEntryText(
  entry: TerminalDisplayEntry,
  options: TerminalEntryFormatOptions
): string {
  const parts = formatTerminalEntryParts(entry, options);
  if (parts) {
    const firstLine = `${parts.leadingText}${parts.marker} `;
    return parts.metadata
      ? `${firstLine}${parts.metadata}\n${parts.continuationIndent}${parts.payload}`
      : `${firstLine}${parts.payload}`;
  }

  const { showTimestamp } = options;
  const sourcePrefix = options.aggregate && entry.sourceLabel ? `[${entry.sourceLabel}] ` : '';
  return showTimestamp
    ? `[${formatTimestamp(entry.timestamp)}] ${sourcePrefix}${entry.text}`
    : `${sourcePrefix}${entry.text}`;
}
