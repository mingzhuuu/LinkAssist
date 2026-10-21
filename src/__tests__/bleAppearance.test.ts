import { describe, expect, it } from 'vitest';
import {
  formatBleAppearance,
  formatBleAppearanceValue,
  resolveBleDeviceAppearance,
} from '../lib';

describe('BLE device appearance resolution', () => {
  it('uses a reported appearance before a conflicting service inference', () => {
    expect(resolveBleDeviceAppearance({
      appearance: 0x0480,
      serviceUuids: ['180d'],
    })).toEqual({
      value: 0x0480,
      source: 'reported',
    });
  });

  it('preserves a reported Generic Unknown value instead of inferring', () => {
    expect(resolveBleDeviceAppearance({
      appearance: 0x0000,
      serviceUuids: ['180d'],
    })).toEqual({
      value: 0x0000,
      source: 'reported',
    });
  });

  it('falls back to service inference only when appearance is absent', () => {
    expect(resolveBleDeviceAppearance({
      appearance: null,
      serviceUuids: ['00001816-0000-1000-8000-00805f9b34fb'],
    })).toEqual({
      value: 0x0480,
      source: 'inferred',
    });
  });

  it('preserves an inferred Generic Unknown value', () => {
    expect(resolveBleDeviceAppearance({
      serviceUuids: ['1826'],
    })).toEqual({
      value: 0x0000,
      source: 'inferred',
    });
  });

  it('returns undefined when neither source is available', () => {
    expect(resolveBleDeviceAppearance({
      appearance: undefined,
      serviceUuids: ['12345678-1234-5678-1234-56789abcdef0'],
    })).toBeUndefined();
  });

  it('formats the standard name together with the original numeric value', () => {
    expect(formatBleAppearance(0x0341)).toBe('Heart Rate Belt (0x0341)');
    expect(formatBleAppearanceValue(0x0c40)).toBe('0x0C40');
  });

  it('retains an unassigned subtype value while using its standard category name', () => {
    expect(formatBleAppearance(0x0342)).toBe('Heart Rate Sensor (0x0342)');
  });
});
