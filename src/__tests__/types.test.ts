import { describe, it, expect } from 'vitest';
import type { Channel, ChannelType } from '../types';

describe('Type definitions', () => {
  it('Channel type is valid', () => {
    const channel: Channel = {
      id: 'test-1',
      type: 'ble',
      name: 'Test BLE',
      state: 'disconnected',
      createdAt: Date.now(),
    };
    expect(channel.type).toBe('ble');
    expect(channel.state).toBe('disconnected');
  });

  it('ChannelType union is correct', () => {
    const types: ChannelType[] = ['ble', 'serial', 'tcp'];
    expect(types).toHaveLength(3);
  });
});
