import { describe, expect, it } from 'vitest';
import { extractProtocolDiagnosticMessages } from '../components/display/protocolParseDiagnostics';

describe('protocol parse diagnostics', () => {
  it('extracts diagnostic groups without treating normal groups as errors', () => {
    const messages = extractProtocolDiagnosticMessages({
      fields: [],
      remaining_bytes: [],
      data_groups: [
        { name: 'Payload', fields: [{ name: 'value', raw_bytes: [], value: 1, display: '1' }] },
        {
          name: 'Diagnostics',
          fields: [{ name: 'diagnostic', raw_bytes: [], value: 'schema stale', display: 'schema stale' }],
        },
      ],
    });

    expect(messages).toEqual(['schema stale']);
  });
});
