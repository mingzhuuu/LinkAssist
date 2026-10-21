import { ScriptDataPreview } from './scriptTypes';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

export function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function normalizeHex(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export function hexToBytes(value: string): number[] {
  const compact = normalizeHex(value);
  if (compact.length % 2 !== 0) {
    throw new Error(`Invalid hex payload length: ${value}`);
  }
  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(Number.parseInt(compact.slice(index, index + 2), 16));
  }
  return bytes;
}

export function textToBytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

export function bytesToTextPreview(bytes: number[]): string {
  const decoded = TEXT_DECODER.decode(new Uint8Array(bytes));
  return decoded.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '.');
}

export function previewBytes(bytes: number[]): ScriptDataPreview {
  return {
    bytes,
    hex: bytesToHex(bytes),
    textPreview: bytesToTextPreview(bytes),
  };
}

export function unknownToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function parseDataSpec(format: string | undefined, value: unknown): number[] {
  const resolvedFormat = format ?? 'hex';
  if (resolvedFormat === 'hex') return hexToBytes(unknownToString(value));
  if (resolvedFormat === 'text') return textToBytes(unknownToString(value));
  if (resolvedFormat === 'base64') {
    const binary = atob(unknownToString(value));
    return Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (resolvedFormat === 'json') return textToBytes(JSON.stringify(value));
  if (resolvedFormat === 'bytes') {
    if (!Array.isArray(value)) throw new Error('bytes payload must be an array');
    return value.map((item) => {
      const byte = Number(item);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`Invalid byte value: ${String(item)}`);
      }
      return byte;
    });
  }
  throw new Error(`Unsupported data format: ${resolvedFormat}`);
}

export function buildAddress(params: Record<string, unknown> | undefined, hostKey = 'host', portKey = 'port'): string {
  const direct = params?.addr ?? params?.address;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const host = unknownToString(params?.[hostKey] ?? params?.localHost ?? '127.0.0.1');
  const port = unknownToString(params?.[portKey] ?? params?.localPort ?? '');
  if (!port) throw new Error('Missing port');
  return `${host}:${port}`;
}
