import type { FormRowConfig, ProtocolFileSummary } from '../../types';

export function getFormInputPlaceholder(
  row: FormRowConfig,
  protocolFile: string | null | undefined,
  protocolSummary: ProtocolFileSummary | null,
): string {
  if (!protocolFile || !row.parsedFieldId) {
    return row.column.format;
  }

  return protocolSummary?.fields.find((field) => field.id === row.parsedFieldId)?.name
    ?? row.parsedFieldId;
}

export function shouldShowFormFieldNameColumn(rows: FormRowConfig[]): boolean {
  return rows.some((row) => row.visible !== false && row.label.trim().length > 0);
}
