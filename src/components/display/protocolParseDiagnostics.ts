import type { ParseResult } from '../../types';
import { useTerminalStore } from '../../stores/terminalStore';

const lastDiagnosticByBinding = new Map<string, string>();

export function extractProtocolDiagnosticMessages(result: ParseResult): string[] {
  return [...new Set(
    (result.data_groups ?? [])
      .filter((group) => group.name.toLocaleLowerCase().startsWith('diagnostic'))
      .flatMap((group) => group.fields)
      .map((field) => field.display || String(field.value))
      .filter(Boolean),
  )];
}

function publish(channelId: string, protocolFile: string, message: string | null): void {
  const key = `${channelId}\0${protocolFile}`;
  if (!message) {
    lastDiagnosticByBinding.delete(key);
    return;
  }
  if (lastDiagnosticByBinding.get(key) === message) return;
  lastDiagnosticByBinding.set(key, message);
  useTerminalStore.getState().appendEntryToChannel(
    channelId,
    'system',
    `Protocol parse (${protocolFile}): ${message}`,
  );
}

export function reportProtocolParseResult(
  channelId: string,
  protocolFile: string,
  result: ParseResult,
): void {
  const diagnostics = extractProtocolDiagnosticMessages(result);
  publish(channelId, protocolFile, diagnostics.length > 0 ? diagnostics.join('; ') : null);
}

export function reportProtocolParseError(
  channelId: string,
  protocolFile: string,
  error: unknown,
): void {
  publish(channelId, protocolFile, error instanceof Error ? error.message : String(error));
}
