import { getAppearanceName, inferAppearanceFromServices } from './bleConstants';

export type BleAppearanceSource = 'reported' | 'inferred';

export interface ResolvedBleAppearance {
  value: number;
  source: BleAppearanceSource;
}

export function formatBleAppearanceValue(value: number): string {
  return `0x${value.toString(16).padStart(4, '0').toUpperCase()}`;
}

export function formatBleAppearance(value: number): string {
  return `${getAppearanceName(value)} (${formatBleAppearanceValue(value)})`;
}

export function resolveBleDeviceAppearance(device: {
  appearance?: number | null;
  serviceUuids?: string[] | null;
}): ResolvedBleAppearance | undefined {
  if (device.appearance != null) {
    return {
      value: device.appearance,
      source: 'reported',
    };
  }

  const inferredAppearance = inferAppearanceFromServices(device.serviceUuids ?? []);
  if (inferredAppearance == null) {
    return undefined;
  }

  return {
    value: inferredAppearance,
    source: 'inferred',
  };
}
