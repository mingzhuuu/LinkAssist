import { describe, expect, it } from 'vitest';
import type { FormRowConfig, ProtocolFileSummary } from '../types';
import {
  getFormInputPlaceholder,
  shouldShowFormFieldNameColumn,
} from '../components/display/formPlaceholderUtils';

const row: FormRowConfig = {
  id: 'row-1',
  label: 'Voltage',
  column: {
    id: 'column-1',
    alias: 'Voltage',
    offset: 0,
    format: 'UInt16LE',
    formula: '',
  },
};

const protocolSummary: ProtocolFileSummary = {
  filePath: 'D:/protocol.lua',
  name: 'Example protocol',
  fields: [
    {
      id: 'voltage_mv',
      name: 'Battery voltage',
      fieldType: 'UInt16LE',
      description: '',
      displayFormat: 'Auto',
    },
  ],
};

describe('form input placeholder', () => {
  it('uses the configured data type when no protocol is selected', () => {
    expect(getFormInputPlaceholder(row, null, null)).toBe('UInt16LE');
  });

  it('uses the selected protocol field name', () => {
    expect(getFormInputPlaceholder(
      { ...row, parsedFieldId: 'voltage_mv' },
      protocolSummary.filePath,
      protocolSummary,
    )).toBe('Battery voltage');
  });

  it('falls back to the protocol field id while its summary is unavailable', () => {
    expect(getFormInputPlaceholder(
      { ...row, parsedFieldId: 'voltage_mv' },
      protocolSummary.filePath,
      null,
    )).toBe('voltage_mv');
  });
});

describe('form field name column', () => {
  it('shows the column when a visible row has a field name', () => {
    expect(shouldShowFormFieldNameColumn([row])).toBe(true);
  });

  it('hides the column when all visible field names are empty', () => {
    expect(shouldShowFormFieldNameColumn([
      { ...row, label: '   ' },
      { ...row, id: 'row-2', label: 'Hidden name', visible: false },
    ])).toBe(false);
  });
});
