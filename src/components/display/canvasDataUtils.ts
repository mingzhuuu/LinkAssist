import { TableColumn, TableColumnFormat, ParsedField } from '../../types';
import { CanvasDataRow } from '../../stores';
import {
  buildFormulaVariableDefinitions,
  coerceFormulaNumber,
  evaluateNumericFormula,
  FormulaVariableContext,
} from './formulaUtils';

/** Decode a numeric value from raw bytes at a given offset using the specified format */
function decodeValue(data: number[], offset: number, format: TableColumnFormat): number | null {
  const buf = new DataView(new Uint8Array(data).buffer);
  try {
    switch (format) {
      case 'UInt8':
        return buf.getUint8(offset);
      case 'Int8':
        return buf.getInt8(offset);
      case 'UInt16LE':
        return buf.getUint16(offset, true);
      case 'UInt16BE':
        return buf.getUint16(offset, false);
      case 'Int16LE':
        return buf.getInt16(offset, true);
      case 'Int16BE':
        return buf.getInt16(offset, false);
      case 'UInt32LE':
        return buf.getUint32(offset, true);
      case 'UInt32BE':
        return buf.getUint32(offset, false);
      case 'Int32LE':
        return buf.getInt32(offset, true);
      case 'Int32BE':
        return buf.getInt32(offset, false);
      case 'Float32LE':
        return buf.getFloat32(offset, true);
      case 'Float32BE':
        return buf.getFloat32(offset, false);
      case 'Float64LE':
        return buf.getFloat64(offset, true);
      case 'Float64BE':
        return buf.getFloat64(offset, false);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Decode a Hex string from raw bytes at a given offset.
 *  For Hex, we show all remaining bytes from offset onward (or 1 byte if only that). */
function decodeHex(data: number[], offset: number): string {
  if (offset >= data.length) return '';
  return data.slice(offset).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Decode an ASCII string from raw bytes at a given offset */
function decodeAscii(data: number[], offset: number): string {
  if (offset >= data.length) return '';
  return data.slice(offset).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
}

interface DecodedColumnValue {
  displayValue: string;
  numericValue: number | null;
}

function formatNumericValue(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(4);
}

/** Format a timestamp as HH:MM:SS.mmm */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/** Decode a single column's cell value from raw data bytes */
export function decodeColumnValue(
  col: TableColumn,
  data: number[],
  timestamp: number,
  channelName: string,
  parsedFields?: ParsedField[],
  formulaVariables: FormulaVariableContext = {},
): string {
  return decodeColumnResult(col, data, timestamp, channelName, parsedFields, formulaVariables).displayValue;
}

function decodeColumnResult(
  col: TableColumn,
  data: number[],
  timestamp: number,
  channelName: string,
  parsedFields?: ParsedField[],
  formulaVariables: FormulaVariableContext = {},
): DecodedColumnValue {
  if (col.formula && col.formula.trim() === '@Timestamp') {
    return { displayValue: formatTimestamp(timestamp), numericValue: timestamp };
  }
  if (col.formula && col.formula.trim() === '@ChannelName') {
    return { displayValue: channelName, numericValue: null };
  }

  if (col.builtIn === 'timestamp') {
    return { displayValue: formatTimestamp(timestamp), numericValue: null };
  }
  if (col.builtIn === 'channelName') {
    return { displayValue: channelName, numericValue: null };
  }

  if (col.parsedFieldId) {
    // parsedFieldId is set but parsed fields are missing — signal error instead of silent raw fallback
    if (!parsedFields || parsedFields.length === 0) {
      return { displayValue: '—', numericValue: null };
    }
    const field = parsedFields.find(
      (f) => (f.id && f.id === col.parsedFieldId) || f.name === col.parsedFieldId,
    );
    if (field) {
      const raw = field.value;
      if (typeof raw === 'string') {
        return { displayValue: raw, numericValue: coerceFormulaNumber(raw) };
      }
      if (typeof raw === 'boolean') {
        return { displayValue: raw ? '1' : '0', numericValue: raw ? 1 : 0 };
      }
      if (typeof raw === 'number') {
        const final = evaluateNumericFormula(raw, col.formula, formulaVariables);
        return { displayValue: formatNumericValue(final), numericValue: final };
      }
      if (Array.isArray(raw)) {
        return {
          displayValue: (raw as number[]).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
          numericValue: null,
        };
      }
      const displayValue = field.display || '—';
      return { displayValue, numericValue: coerceFormulaNumber(displayValue) };
    }
    return { displayValue: '—', numericValue: null };
  }

  if (col.format === 'Hex') {
    return { displayValue: decodeHex(data, col.offset), numericValue: null };
  }
  if (col.format === 'Ascii') {
    return { displayValue: decodeAscii(data, col.offset), numericValue: null };
  }

  const raw = decodeValue(data, col.offset, col.format);
  if (raw === null) {
    return { displayValue: '—', numericValue: null };
  }

  const final = evaluateNumericFormula(raw, col.formula, formulaVariables);
  return { displayValue: formatNumericValue(final), numericValue: final };
}

/** Encode a numeric value into bytes using the specified format */
export function encodeNumericValue(value: number, format: TableColumnFormat): number[] {
  const size =
    format === 'UInt8' || format === 'Int8' ? 1 :
    format === 'UInt16LE' || format === 'UInt16BE' || format === 'Int16LE' || format === 'Int16BE' ? 2 :
    format === 'UInt32LE' || format === 'UInt32BE' || format === 'Int32LE' || format === 'Int32BE' ||
    format === 'Float32LE' || format === 'Float32BE' ? 4 :
    format === 'Float64LE' || format === 'Float64BE' ? 8 : 0;

  if (size === 0) return [];

  const arr = new Uint8Array(size);
  const view = new DataView(arr.buffer);
  const little = format.endsWith('LE');

  switch (format) {
    case 'UInt8':
      view.setUint8(0, value);
      break;
    case 'Int8':
      view.setInt8(0, value);
      break;
    case 'UInt16LE':
    case 'UInt16BE':
      view.setUint16(0, value, little);
      break;
    case 'Int16LE':
    case 'Int16BE':
      view.setInt16(0, value, little);
      break;
    case 'UInt32LE':
    case 'UInt32BE':
      view.setUint32(0, value, little);
      break;
    case 'Int32LE':
    case 'Int32BE':
      view.setInt32(0, value, little);
      break;
    case 'Float32LE':
    case 'Float32BE':
      view.setFloat32(0, value, little);
      break;
    case 'Float64LE':
    case 'Float64BE':
      view.setFloat64(0, value, little);
      break;
  }

  return Array.from(arr);
}

/** Encode a string value into bytes (for Hex or Ascii formats) */
export function encodeStringValue(value: string, format: TableColumnFormat): number[] {
  if (format === 'Hex') {
    const hex = value.replace(/\s+/g, '');
    if (hex.length % 2 !== 0) return [];
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      const byte = parseInt(hex.substring(i, i + 2), 16);
      if (Number.isNaN(byte)) return [];
      bytes.push(byte);
    }
    return bytes;
  }

  if (format === 'Ascii') {
    return Array.from(value).map((c) => c.charCodeAt(0));
  }

  return [];
}

/** Encode a single form field value according to its column config */
export function encodeFormField(value: string, column: TableColumn): number[] {
  return encodeFormFieldResult(value, column).bytes;
}

export function encodeFormFieldResult(
  value: string,
  column: TableColumn,
  formulaVariables: FormulaVariableContext = {},
): { bytes: number[]; numericValue: number | null } {
  if (column.format === 'Hex' || column.format === 'Ascii') {
    return { bytes: encodeStringValue(value, column.format), numericValue: null };
  }

  const num = Number(value);
  if (Number.isNaN(num)) {
    return { bytes: [], numericValue: null };
  }

  const final = evaluateNumericFormula(num, column.formula, formulaVariables);
  return { bytes: encodeNumericValue(final, column.format), numericValue: final };
}

/** Build a complete packet from multiple form rows, respecting offsets */
export function buildFormPacket(
  rows: Array<{ offset: number; bytes: number[] }>,
): number[] {
  if (rows.length === 0) return [];

  let maxEnd = 0;
  for (const row of rows) {
    const end = row.offset + row.bytes.length;
    if (end > maxEnd) maxEnd = end;
  }

  const packet = new Uint8Array(maxEnd);
  for (const row of rows) {
    packet.set(row.bytes, row.offset);
  }

  return Array.from(packet);
}

/** Build a complete CanvasDataRow from raw bytes for a given set of columns */
export function buildCanvasRow(
  columns: TableColumn[],
  data: number[],
  timestamp: number,
  channelId: string,
  channelName: string,
  parsedFields?: ParsedField[],
): CanvasDataRow {
  const cells: Record<string, string> = {};

  const formulaVariableDefinitions = buildFormulaVariableDefinitions(
    columns.map((column, index) => ({
      label: column.alias,
      fallback: `col_${index + 1}`,
    })),
  );
  const formulaVariables: FormulaVariableContext = {};

  columns.forEach((col, index) => {
    const decoded = decodeColumnResult(col, data, timestamp, channelName, parsedFields, formulaVariables);
    cells[col.id] = decoded.displayValue;
    formulaVariables[formulaVariableDefinitions[index].identifier] = decoded.numericValue ?? undefined;
  });

  return { timestamp, channelId, cells };
}
