/** serde_json can reorder object keys on the wire; revisions compare values. */
export function remoteValueKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

export function remoteText(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value.trim();
}

export function remoteBytes(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192 || value.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
    throw new Error('Send data must contain 1–8192 bytes');
  }
  return value;
}

export function parseRemoteInput(input: string, format: 'hex' | 'text'): number[] {
  if (format === 'text') return remoteBytes(Array.from(new TextEncoder().encode(input)));
  const compact = input.replace(/\s/g, '');
  if (!compact || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) throw new Error('HEX requires complete byte pairs, for example 01 A2 FF');
  return remoteBytes(compact.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
}

export function checkRemoteRevision(expected: unknown, current: string): void {
  if (typeof expected !== 'string' || expected !== current) throw new Error('The host configuration changed. Refresh the editor before saving.');
}
