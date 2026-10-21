import { afterEach, describe, expect, it } from 'vitest';
import type { CanvasChannelLink, Channel } from '../types';
import { computeCanvasBorderColor } from '../components/display/Canvas';

const channelColorCases: Array<{
  channel: Channel;
  link: CanvasChannelLink;
  variable: string;
  value: string;
  expected: string;
}> = [
  {
    channel: { id: 'ble-1', type: 'ble', name: 'BLE', state: 'disconnected', createdAt: 0 },
    link: { channelId: 'ble-1', protocolTemplateId: null },
    variable: '--accent-blue',
    value: '0 79 196',
    expected: 'rgb(0, 79, 196)',
  },
  {
    channel: { id: 'serial-1', type: 'serial', name: 'UART', state: 'disconnected', createdAt: 0 },
    link: { channelId: 'serial-1', protocolTemplateId: null },
    variable: '--accent-mauve',
    value: '91 33 182',
    expected: 'rgb(91, 33, 182)',
  },
  {
    channel: { id: 'tcp-1', type: 'tcp', name: 'TCP', state: 'disconnected', createdAt: 0 },
    link: { channelId: 'tcp-1', protocolTemplateId: null },
    variable: '--accent-green',
    value: '0 107 60',
    expected: 'rgb(0, 107, 60)',
  },
];

afterEach(() => {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
});

describe('canvas border theme colors', () => {
  it('uses a white fallback border in high contrast dark mode', () => {
    document.documentElement.classList.add('dark', 'high-contrast');

    expect(computeCanvasBorderColor([], [])).toBe('rgb(255, 255, 255)');
  });

  it('uses a black fallback border in high contrast light mode', () => {
    document.documentElement.classList.add('high-contrast-light');

    expect(computeCanvasBorderColor([], [])).toBe('rgb(0, 0, 0)');
  });

  it.each(channelColorCases)(
    'uses $variable for the $channel.type channel border',
    ({ channel, link, variable, value, expected }) => {
      document.documentElement.classList.add('high-contrast-light');
      document.documentElement.style.setProperty(variable, value);

      expect(computeCanvasBorderColor([link], [channel])).toBe(expected);
    }
  );
});
