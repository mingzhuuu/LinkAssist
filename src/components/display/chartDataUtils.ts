import { NumericExtractor, NumericFormat, ParsedField } from '../../types';
import { coerceFormulaNumber, evaluateNumericFormula, FormulaVariableContext } from './formulaUtils';

function usesLittleEndian(format: NumericFormat): boolean {
  return format.endsWith('LE');
}

function decodeRawValue(
  data: number[],
  offset: number,
  format: NumericFormat,
): number | null {
  const buffer = new DataView(new Uint8Array(data).buffer);
  const littleEndian = usesLittleEndian(format);

  try {
    switch (format) {
      case 'UInt8':
        return buffer.getUint8(offset);
      case 'Int8':
        return buffer.getInt8(offset);
      case 'UInt16LE':
      case 'UInt16BE':
        return buffer.getUint16(offset, littleEndian);
      case 'Int16LE':
      case 'Int16BE':
        return buffer.getInt16(offset, littleEndian);
      case 'UInt32LE':
      case 'UInt32BE':
        return buffer.getUint32(offset, littleEndian);
      case 'Int32LE':
      case 'Int32BE':
        return buffer.getInt32(offset, littleEndian);
      case 'Float32LE':
      case 'Float32BE':
        return buffer.getFloat32(offset, littleEndian);
      case 'Float64LE':
      case 'Float64BE':
        return buffer.getFloat64(offset, littleEndian);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function extractNumericFromParsedFields(
  fieldId: string,
  parsedFields: ParsedField[],
  formula: string,
  formulaVariables: FormulaVariableContext = {},
): number | null {
  const field = parsedFields.find(
    (f) => (f.id && f.id === fieldId) || f.name === fieldId,
  );
  if (!field) return null;

  const numericValue = coerceFormulaNumber(field.value);

  if (numericValue === null) return null;
  const result = evaluateNumericFormula(numericValue, formula, formulaVariables);
  return Number.isFinite(result) ? result : null;
}

export function extractNumeric(
  extractor: NumericExtractor,
  data: number[],
  parsedFields?: ParsedField[],
  formulaVariables: FormulaVariableContext = {},
): number | null {
  if (extractor.source === 'parsed') {
    if (!parsedFields || parsedFields.length === 0) return null;
    return extractNumericFromParsedFields(extractor.fieldId, parsedFields, extractor.formula, formulaVariables);
  }

  const rawValue = decodeRawValue(
    data,
    extractor.offset,
    extractor.format,
  );

  if (rawValue === null) {
    return null;
  }

  const value = evaluateNumericFormula(rawValue, extractor.formula, formulaVariables);
  return Number.isFinite(value) ? value : null;
}
