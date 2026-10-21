import { describe, expect, it } from 'vitest';
import {
  activityMatchesActiveChannel,
  channelActivitySourceLabel,
  shouldDisplayChannelActivity,
} from '../lib/channelActivity';
import type { Channel, ChannelActivityEvent } from '../types';
import { DEFAULT_TCP_CONFIG } from '../stores/tcpStore';

const bleChannel: Channel = {
  id: 'ble-channel',
  type: 'ble',
  name: 'SRAP',
  state: 'disconnected',
  createdAt: 1,
};

function activity(overrides: Partial<ChannelActivityEvent> = {}): ChannelActivityEvent {
  return {
    activityId: 'activity-1',
    timestamp: 1,
    kind: 'connected',
    source: 'test',
    transport: 'ble',
    endpoint: { deviceId: 'device-1' },
    ...overrides,
  };
}

describe('channel activity matching', () => {
  it.each([
    ['client', 'tcp-client', { address: '127.0.0.1:8080' }],
    ['server', 'tcp-server', { localAddress: '0.0.0.0:8080' }],
    ['udp', 'udp', { localAddress: '0.0.0.0:8080' }],
  ] as const)('matches network endpoints only in %s mode', (mode, transport, endpoint) => {
    const activeChannel: Channel = { ...bleChannel, type: 'tcp' };
    const event = activity({ transport, endpoint });
    for (const candidate of ['client', 'server', 'udp'] as const) {
      expect(activityMatchesActiveChannel(event, {
        activeChannel, bleDeviceIds: [], tcpConfig: { ...DEFAULT_TCP_CONFIG, mode: candidate },
      })).toBe(candidate === mode);
    }
  });

  it('never matches missing endpoints against empty saved addresses', () => {
    for (const [mode, transport] of [['client', 'tcp-client'], ['server', 'tcp-server'], ['udp', 'udp']] as const) {
      expect(activityMatchesActiveChannel(activity({ transport, endpoint: {} }), {
        activeChannel: { ...bleChannel, type: 'tcp' }, bleDeviceIds: [],
        tcpConfig: { mode, clientAddress: ' ', serverAddress: '', udpBindAddress: '', udpTargetAddress: '' },
      })).toBe(false);
    }
  });

  it('matches BLE only by the exact current device id', () => {
    const state = { activeChannel: bleChannel, bleDeviceIds: ['device-1'] };
    expect(activityMatchesActiveChannel(activity(), state)).toBe(true);
    expect(activityMatchesActiveChannel(activity({ endpoint: { deviceId: 'device-2' } }), state)).toBe(false);
    expect(activityMatchesActiveChannel(activity({ endpoint: { deviceName: 'SRAP' } }), state)).toBe(false);
  });

  it('accepts an explicit active channel id and rejects a different channel id', () => {
    const state = { activeChannel: bleChannel, bleDeviceIds: [] };
    expect(activityMatchesActiveChannel(activity({ channelId: 'ble-channel' }), state)).toBe(true);
    expect(activityMatchesActiveChannel(activity({ channelId: 'other-channel' }), state)).toBe(false);
    expect(activityMatchesActiveChannel(activity({
      channelId: 'ble-channel',
      transport: 'serial',
      endpoint: { serialPath: 'COM3' },
    }), state)).toBe(false);
  });

  it('keeps only channel identity in test protocol labels', () => {
    expect(channelActivitySourceLabel(activity({ caseId: 'tc-read' })))
      .toBe('BLE · device-1');
  });

  it('shows only TX/RX protocol frames for test-originated activity', () => {
    expect(shouldDisplayChannelActivity(activity({ kind: 'tx' }))).toBe(true);
    expect(shouldDisplayChannelActivity(activity({ kind: 'rx' }))).toBe(true);
    expect(shouldDisplayChannelActivity(activity({ kind: 'connected' }))).toBe(false);
    expect(shouldDisplayChannelActivity(activity({ kind: 'protocol' }))).toBe(false);
    expect(shouldDisplayChannelActivity(activity({ kind: 'error' }))).toBe(false);
    expect(shouldDisplayChannelActivity(activity({ source: 'mcp', kind: 'error' }))).toBe(true);
  });
});
