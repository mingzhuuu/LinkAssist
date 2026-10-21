import { describe, expect, it } from 'vitest';
import type { NumericExtractor, TableColumn } from '../types';
import { buildCanvasRow, encodeFormFieldResult } from '../components/display/canvasDataUtils';
import { extractNumeric } from '../components/display/chartDataUtils';
import { buildFormulaVariableDefinitions } from '../components/display/formulaUtils';

describe('Formula context support', () => {
  it('creates unique variable names for duplicate and reserved labels', () => {
    const definitions = buildFormulaVariableDefinitions([
      { label: 'A', fallback: 'col_1' },
      { label: 'x', fallback: 'col_2' },
      { label: 'A', fallback: 'col_3' },
      { label: 'Voltage %', fallback: 'col_4' },
    ]);

    expect(definitions.map((item) => item.identifier)).toEqual(['A', '_x', 'A_2', 'Voltage']);
  });

  it('lets table rows reference previous column results', () => {
    const columns: TableColumn[] = [
      { id: 'a', alias: 'A', offset: 0, format: 'UInt8', formula: '' },
      { id: 'b', alias: 'B', offset: 1, format: 'UInt8', formula: 'x * 2' },
      { id: 'c', alias: 'C', offset: 2, format: 'UInt8', formula: 'A + B' },
    ];

    const row = buildCanvasRow(columns, [2, 3, 0], Date.now(), 'channel-1', 'Channel 1');

    expect(row.cells.a).toBe('2');
    expect(row.cells.b).toBe('6');
    expect(row.cells.c).toBe('8');
  });

  it('lets chart extractors use previous series variables', () => {
    const extractor: NumericExtractor = {
      source: 'raw',
      offset: 0,
      format: 'UInt8',
      formula: 'x + A + B',
    };

    expect(extractNumeric(extractor, [1], undefined, { A: 2, B: 3 })).toBe(6);
  });

  it('lets form encoding reference previous row results', () => {
    const columnA: TableColumn = { id: 'a', alias: 'A', offset: 0, format: 'UInt8', formula: '' };
    const columnC: TableColumn = { id: 'c', alias: 'C', offset: 1, format: 'UInt8', formula: 'A * 3' };

    const encodedA = encodeFormFieldResult('2', columnA);
    const encodedC = encodeFormFieldResult('0', columnC, { A: encodedA.numericValue ?? undefined });

    expect(encodedA.bytes).toEqual([2]);
    expect(encodedC.bytes).toEqual([6]);
  });
});
