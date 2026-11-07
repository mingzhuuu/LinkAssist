import { describe, expect, it } from 'vitest';
import { buildBleWriteSelectionMenu, coalesceTerminalEntries, formatInputTimestamp, formatTerminalBytes, formatTerminalEntryParts, formatTerminalEntryText } from '../components/layout/terminalUtils';
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

describe('coalesceTerminalEntries', () => {
  const encode = (text: string): number[] => Array.from(new TextEncoder().encode(text));
  const asciiOptions = {
    promptText: '>',
    showTimestamp: false,
    showInputPrefix: false,
    sendFormat: 'ascii' as const,
    receiveFormat: 'ascii' as const,
  };

  it('merges mid-line chunk splits, interactive echoes, backspaces, and CRLF responses in ASCII mode', () => {
    const rawEntries = [
      {
        id: 1,
        kind: 'rx' as const,
        timestamp: 1000,
        text: 'RX: 01',
        data: encode('on   : VER.B\r\nBootROM       Version  : 0214.0000\r\nBootLoad'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 2,
        kind: 'rx' as const,
        timestamp: 1010,
        text: 'RX: 02',
        data: encode('   Version    : 0214.0000\r\nCPLD          Version  : 0105\r\nSof'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 3,
        kind: 'rx' as const,
        timestamp: 1020,
        text: 'RX: 03',
        data: encode('tware      Version    : VRP (R) Software, Version 5.170 (V200R0'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 4,
        kind: 'rx' as const,
        timestamp: 1030,
        text: 'RX: 04',
        data: encode('20C00SPC500)\r\nFLASH         Version  : 020b.0a06\r\n<FutureMatrix>'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 5,
        kind: 'rx' as const,
        timestamp: 1100,
        text: 'RX: 05',
        data: encode('display'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 6,
        kind: 'rx' as const,
        timestamp: 1150,
        text: 'RX: 06',
        data: [
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
          0x08, 0x20, 0x08,
        ],
        sourceChannelId: 'serial-1',
      },
      {
        id: 7,
        kind: 'rx' as const,
        timestamp: 1200,
        text: 'RX: 07',
        data: encode('displa'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 8,
        kind: 'rx' as const,
        timestamp: 1250,
        text: 'RX: 08',
        data: encode('y clock'),
        sourceChannelId: 'serial-1',
      },
      {
        id: 9,
        kind: 'rx' as const,
        timestamp: 1300,
        text: 'RX: 09',
        data: encode("\r\n                        ^\r\nError: Unrecognized command found at '^' position.\r\n<FutureMatrix>"),
        sourceChannelId: 'serial-1',
      },
      {
        id: 10,
        kind: 'rx' as const,
        timestamp: 1400,
        text: 'RX: 10',
        data: encode('\r\n<FutureMatrix>'),
        sourceChannelId: 'serial-1',
      },
    ];

    const coalesced = coalesceTerminalEntries(rawEntries, 'ascii');
    expect(coalesced).toHaveLength(3);

    expect(formatTerminalEntryParts(coalesced[0], asciiOptions)?.rawPayload).toBe(
      [
        'on   : VER.B',
        'BootROM       Version  : 0214.0000',
        'BootLoad   Version    : 0214.0000',
        'CPLD          Version  : 0105',
        'Software      Version    : VRP (R) Software, Version 5.170 (V200R020C00SPC500)',
        'FLASH         Version  : 020b.0a06',
        '<FutureMatrix>display clock',
      ].join('\n')
    );

    expect(formatTerminalEntryParts(coalesced[1], asciiOptions)?.rawPayload).toBe(
      [
        '                        ^',
        "Error: Unrecognized command found at '^' position.",
        '<FutureMatrix>',
      ].join('\n')
    );

    expect(formatTerminalEntryParts(coalesced[2], asciiOptions)?.rawPayload).toBe('<FutureMatrix>');

    // HEX mode preserves all raw packet entries unchanged
    expect(coalesceTerminalEntries(rawEntries, 'hex')).toHaveLength(rawEntries.length);
  });

  it('handles CRLF split across packet boundaries without adding extra blank lines', () => {
    const rawEntries = [
      {
        id: 1,
        kind: 'rx' as const,
        timestamp: 1000,
        text: 'RX: 01',
        data: [0x4f, 0x4b, 0x0d],
        sourceChannelId: 'serial-1',
      },
      {
        id: 2,
        kind: 'rx' as const,
        timestamp: 1005,
        text: 'RX: 02',
        data: [0x0a, 0x52, 0x45, 0x41, 0x44, 0x59, 0x0d, 0x0a],
        sourceChannelId: 'serial-1',
      },
    ];

    const coalesced = coalesceTerminalEntries(rawEntries, 'ascii');
    expect(coalesced).toHaveLength(2);
    expect(formatTerminalEntryText(coalesced[0], asciiOptions)).toBe('< OK');
    expect(formatTerminalEntryText(coalesced[1], asciiOptions)).toBe('< READY');
  });
});
