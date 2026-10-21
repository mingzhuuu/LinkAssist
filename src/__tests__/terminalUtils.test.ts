import { describe, expect, it } from 'vitest';
import { buildBleWriteSelectionMenu, formatInputTimestamp, formatTerminalBytes, formatTerminalEntryParts, formatTerminalEntryText } from '../components/layout/terminalUtils';
import { sendWithImmediateTxEcho } from '../lib/terminalSend';

const sampleTimestamp = new Date(2000, 0, 1, 13, 27, 52, 484).getTime();

describe('sendWithImmediateTxEcho', () => {
  it('echoes tx before an immediate asynchronous response can be received', async () => {
    const entries: string[] = [];

    const send = sendWithImmediateTxEcho(
      () => entries.push('tx'),
      async () => {
        await Promise.resolve();
        entries.push('rx');
      }
    );

    expect(entries).toEqual(['tx']);
    await send;
    expect(entries).toEqual(['tx', 'rx']);
  });
});

describe('formatTerminalEntryText', () => {
  it('uses stars instead of milliseconds for the live input timestamp', () => {
    expect(formatInputTimestamp(sampleTimestamp)).toBe('13:27:52.***');
  });

  it('renders a timestamped rx line with one space before the prompt prefix', () => {
    expect(
      formatTerminalEntryText(
        { kind: 'rx', timestamp: sampleTimestamp, text: 'RX: 25' },
        {
          promptText: 'Motor>',
          showTimestamp: true,
          showInputPrefix: true,
          sendFormat: 'hex',
          receiveFormat: 'hex',
        }
      )
    ).toBe('13:27:52.484 Motor< 25');
  });

  it('keeps the rx marker attached when the channel prefix is hidden', () => {
    expect(
      formatTerminalEntryText(
        { kind: 'rx', timestamp: sampleTimestamp, text: 'RX: 25' },
        {
          promptText: 'Motor>',
          showTimestamp: true,
          showInputPrefix: false,
          sendFormat: 'hex',
          receiveFormat: 'hex',
        }
      )
    ).toBe('13:27:52.484< 25');
  });

  it('formats sent and received raw bytes independently', () => {
    const options = {
      promptText: 'Motor>',
      showTimestamp: false,
      showInputPrefix: true,
      sendFormat: 'ascii' as const,
      receiveFormat: 'hex' as const,
    };

    expect(
      formatTerminalEntryText(
        { kind: 'tx', timestamp: sampleTimestamp, text: 'TX(HEX): 48 69', data: [0x48, 0x69] },
        options
      )
    ).toBe('Motor> Hi');

    expect(
      formatTerminalEntryText(
        { kind: 'rx', timestamp: sampleTimestamp, text: 'RX: 48 69', data: [0x48, 0x69] },
        options
      )
    ).toBe('Motor< 48 69');
  });

  it('preserves receive metadata when raw bytes are reformatted', () => {
    expect(
      formatTerminalEntryText(
        {
          kind: 'rx',
          timestamp: sampleTimestamp,
          text: '[127.0.0.1:9000] RX: 4F 4B',
          data: [0x4f, 0x4b],
        },
        {
          promptText: 'UDP>',
          showTimestamp: false,
          showInputPrefix: false,
          sendFormat: 'hex',
          receiveFormat: 'ascii',
        }
      )
    ).toBe('< [127.0.0.1:9000] OK');
  });

  it('renders BLE service and characteristic metadata above the received data', () => {
    const entry = {
      kind: 'rx' as const,
      timestamp: sampleTimestamp,
      text: 'RX: 01 02',
      data: [0x01, 0x02],
      bleMetadata: {
        serviceUuid: '0000180d-0000-1000-8000-00805f9b34fb',
        charUuid: '00002a37-0000-1000-8000-00805f9b34fb',
      },
    };
    const options = {
      promptText: 'BLE>',
      showTimestamp: false,
      showInputPrefix: true,
      sendFormat: 'hex' as const,
      receiveFormat: 'hex' as const,
    };

    expect(formatTerminalEntryParts(entry, options)).toMatchObject({
      metadata: '[180D/2A37]',
      payload: '01 02',
      continuationIndent: '     ',
    });
    expect(formatTerminalEntryText(entry, options)).toBe('BLE< [180D/2A37]\n     01 02');
  });

  it('adds source labels only when rendering the aggregate TERMINAL tab', () => {
    const entry = {
      kind: 'tx' as const,
      timestamp: sampleTimestamp,
      text: 'TX: AA BB',
      data: [0xaa, 0xbb],
      sourceLabel: 'TEST · BLE · device-1 · tc-read',
    };
    const options = {
      promptText: '>',
      showTimestamp: false,
      showInputPrefix: false,
      sendFormat: 'hex' as const,
      receiveFormat: 'hex' as const,
    };

    expect(formatTerminalEntryText(entry, { ...options, aggregate: true }))
      .toBe('> [TEST · BLE · device-1 · tc-read]\n  AA BB');
    expect(formatTerminalEntryText(entry, options)).toBe('> AA BB');
  });

  it('renders CRLF, CR, and LF as terminal line breaks in ASCII mode', () => {
    expect(formatTerminalBytes(
      [0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x43, 0x0a, 0x44],
      'ascii'
    )).toBe('A\nB\nC\nD');
  });

  it('adds a system timestamp only to the first line of a multiline message', () => {
    expect(
      formatTerminalEntryText(
        {
          kind: 'system',
          timestamp: sampleTimestamp,
          text: 'No write characteristic selected — opening selection…\nService: 180D\n  └─ 1) Characteristic: 2A39',
        },
        {
          promptText: 'BLE>',
          showTimestamp: true,
          showInputPrefix: true,
          sendFormat: 'hex',
          receiveFormat: 'hex',
        }
      )
    ).toBe('[13:27:52.484] No write characteristic selected — opening selection…\nService: 180D\n  └─ 1) Characteristic: 2A39');
  });

  it('handles common ASCII terminal control characters', () => {
    expect(formatTerminalBytes(
      [
        0x00, 0x07,
        0x41, 0x42, 0x08, 0x43,
        0x09, 0x44,
        0x0b, 0x45,
        0x0c, 0x46,
        0x1b,
      ],
      'ascii'
    )).toBe('AC\tD\nE\nF\\e');
  });

  it('aligns continued ASCII lines with the first line payload', () => {
    const linePrefix = '13:27:52.484 Motor< ';

    expect(
      formatTerminalEntryText(
        {
          kind: 'rx',
          timestamp: sampleTimestamp,
          text: 'RX: 41 0D 0A 42',
          data: [0x41, 0x0d, 0x0a, 0x42],
        },
        {
          promptText: 'Motor>',
          showTimestamp: true,
          showInputPrefix: true,
          sendFormat: 'hex',
          receiveFormat: 'ascii',
        }
      )
    ).toBe(`${linePrefix}A\n${' '.repeat(linePrefix.length)}B`);
  });
});

describe('buildBleWriteSelectionMenu', () => {
  it('groups writable characteristics under their services', () => {
    const menu = buildBleWriteSelectionMenu([
      {
        uuid: '0000180d-0000-1000-8000-00805f9b34fb',
        characteristics: [
          {
            uuid: '00002a37-0000-1000-8000-00805f9b34fb',
            serviceUuid: '0000180d-0000-1000-8000-00805f9b34fb',
            properties: ['notify'],
          },
          {
            uuid: '00002a39-0000-1000-8000-00805f9b34fb',
            serviceUuid: '0000180d-0000-1000-8000-00805f9b34fb',
            properties: ['write', 'write_without_response'],
          },
        ],
      },
      {
        uuid: '12345678-1234-5678-1234-56789abcdef0',
        characteristics: [
          {
            uuid: 'abcdefab-1234-5678-1234-56789abcdef0',
            serviceUuid: '12345678-1234-5678-1234-56789abcdef0',
            properties: ['write', 'notify'],
          },
        ],
      },
    ]);

    expect(menu.lines).toEqual([
      '━━━ Select writable characteristic ━━━',
      '  Service: 180D',
      '    └─ 1) Characteristic: 2A39  [W,WNR]',
      '  Service: 12345678-1234-5678-1234-56789abcdef0',
      '    └─ 2) Characteristic: abcdefab-1234-5678-1234-56789abcdef0  [W,N]',
      '  Enter number to select:',
    ]);
    expect(menu.options.map(option => option.label)).toEqual([
      '180D/2A39',
      '12345678-1234-5678-1234-56789abcdef0/abcdefab-1234-5678-1234-56789abcdef0',
    ]);
  });
});
