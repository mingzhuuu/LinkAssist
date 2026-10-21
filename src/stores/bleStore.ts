import { create } from 'zustand';
import { BleDevice, GattService } from '../types';

export interface BleFilterSettings {
  nameFilter: string;
  rssiFilter: number;
  hasServicesFilter: boolean;
  hasNameFilter: boolean;
  connectableFilter: boolean;
}

export type BleUuidNameKind = 'service' | 'characteristic';

export interface BleUuidNames {
  services: Record<string, string>;
  characteristics: Record<string, string>;
}

const STANDARD_BASE_UUID_PATTERN = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/;

export const normalizeBleUuid = (uuid: string): string => {
  const normalized = uuid.trim().toLowerCase();
  return normalized.match(STANDARD_BASE_UUID_PATTERN)?.[1] ?? normalized;
};

const normalizeUuidNameRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const names: Record<string, string> = {};
  for (const [uuid, candidate] of Object.entries(value)) {
    if (typeof candidate !== 'string') continue;
    const normalizedUuid = normalizeBleUuid(uuid);
    const normalizedName = candidate.trim();
    if (normalizedUuid && normalizedName) names[normalizedUuid] = normalizedName;
  }
  return names;
};

export const normalizeBleUuidNames = (value: unknown): BleUuidNames => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { services: {}, characteristics: {} };
  }

  const candidate = value as Record<string, unknown>;
  return {
    services: normalizeUuidNameRecord(candidate.services),
    characteristics: normalizeUuidNameRecord(candidate.characteristics),
  };
};

export const DEFAULT_BLE_FILTERS: BleFilterSettings = {
  nameFilter: '',
  rssiFilter: -100,
  hasServicesFilter: false,
  hasNameFilter: false,
  connectableFilter: false,
};

export interface SubscribedChar {
  serviceUuid: string;
  charUuid: string;
}

export interface LastConnectedBleDevice {
  id: string;
  name: string | null;
  advertisementName?: string | null;
  serviceUuids: string[];
}

function toLastConnectedBleDevice(device: Pick<BleDevice, 'id' | 'name' | 'advertisementName' | 'serviceUuids'>): LastConnectedBleDevice {
  return {
    id: device.id,
    name: device.name ?? null,
    advertisementName: device.advertisementName ?? null,
    serviceUuids: [...(device.serviceUuids ?? [])],
  };
}

export interface BleChannelState {
  devices: BleDevice[];
  connectedDeviceId: string | null;
  gattServices: GattService[];
  subscribedCharacteristics: SubscribedChar[];
}

const createEmptyChannelState = (): BleChannelState => ({
  devices: [],
  connectedDeviceId: null,
  gattServices: [],
  subscribedCharacteristics: [],
});

interface BleStore {
  scanning: boolean;
  scanningChannelId: string | null;
  devices: BleDevice[];
  connectedDeviceId: string | null;
  /** channelId that owns the current BLE connection */
  connectedChannelId: string | null;
  gattServices: GattService[];
  channelStates: Record<string, BleChannelState>;
  deviceChannelMap: Record<string, string>;
  bleFilters: Record<string, BleFilterSettings>;
  subscribedCharacteristics: SubscribedChar[];
  lastConnectedDeviceIds: Record<string, string>;
  lastConnectedDevices: Record<string, LastConnectedBleDevice>;
  customUuidNames: BleUuidNames;
  setScanning: (scanning: boolean, channelId?: string | null) => void;
  setDevices: (devices: BleDevice[], channelId?: string | null) => void;
  updateDevice: (device: BleDevice, channelId?: string | null) => void;
  clearDevices: (channelId?: string | null) => void;
  setConnectedDeviceId: (id: string | null, channelId?: string | null) => void;
  setGattServices: (services: GattService[], channelId?: string | null) => void;
  clearChannelConnection: (channelId: string) => void;
  setBleFilters: (channelId: string, filters: Partial<BleFilterSettings>) => void;
  addSubscription: (serviceUuid: string, charUuid: string, channelId?: string | null) => void;
  removeSubscription: (serviceUuid: string, charUuid: string, channelId?: string | null) => void;
  clearSubscriptions: (channelId?: string | null) => void;
  setLastConnectedDeviceId: (channelId: string, deviceId: string) => void;
  setLastConnectedDevice: (channelId: string, device: Pick<BleDevice, 'id' | 'name' | 'advertisementName' | 'serviceUuids'>) => void;
  setCustomUuidName: (kind: BleUuidNameKind, uuid: string, name: string) => void;
  replaceCustomUuidNames: (names: BleUuidNames) => void;
  getChannelState: (channelId: string) => BleChannelState;
  getConnectedDeviceIdForChannel: (channelId: string) => string | null;
  getLastConnectedDeviceForChannel: (channelId: string) => LastConnectedBleDevice | null;
  getChannelIdForDevice: (deviceId: string) => string | null;
}

export const useBleStore = create<BleStore>((set, get) => ({
  scanning: false,
  scanningChannelId: null,
  devices: [],
  connectedDeviceId: null,
  connectedChannelId: null,
  gattServices: [],
  channelStates: {},
  deviceChannelMap: {},
  bleFilters: {},
  subscribedCharacteristics: [],
  lastConnectedDeviceIds: {},
  lastConnectedDevices: {},
  customUuidNames: { services: {}, characteristics: {} },
  setScanning: (scanning, channelId) => set((state) => ({
    scanning,
    scanningChannelId: scanning ? (channelId ?? state.scanningChannelId) : null,
  })),
  setDevices: (devices, channelId) =>
    set((state) => {
      if (!channelId) return { devices };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        devices,
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, devices },
        },
      };
    }),
  updateDevice: (device, channelId) =>
    set((state) => {
      const targetDevices = channelId
        ? (state.channelStates[channelId]?.devices ?? [])
        : state.devices;
      const index = targetDevices.findIndex((d) => d.id === device.id);
      const newDevices = index === -1 ? [...targetDevices, device] : [...targetDevices];
      if (index !== -1) {
        newDevices[index] = device;
      }
      if (!channelId) return { devices: newDevices };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        devices: newDevices,
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, devices: newDevices },
        },
      };
    }),
  clearDevices: (channelId) =>
    set((state) => {
      if (!channelId) return { devices: [] };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        devices: [],
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, devices: [] },
        },
      };
    }),
  setConnectedDeviceId: (id, channelId) =>
    set((state) => {
      const nextDeviceChannelMap = { ...state.deviceChannelMap };
      let nextChannelStates = state.channelStates;

      if (channelId) {
        const previous = state.channelStates[channelId] ?? createEmptyChannelState();
        nextChannelStates = {
          ...state.channelStates,
          [channelId]: { ...previous, connectedDeviceId: id },
        };
        for (const [deviceId, ownerChannelId] of Object.entries(nextDeviceChannelMap)) {
          if (ownerChannelId === channelId) delete nextDeviceChannelMap[deviceId];
        }
        if (id) nextDeviceChannelMap[id] = channelId;
      } else if (id === null && state.connectedChannelId) {
        const previous = state.channelStates[state.connectedChannelId] ?? createEmptyChannelState();
        nextChannelStates = {
          ...state.channelStates,
          [state.connectedChannelId]: { ...previous, connectedDeviceId: null },
        };
        for (const [deviceId, ownerChannelId] of Object.entries(nextDeviceChannelMap)) {
          if (ownerChannelId === state.connectedChannelId) delete nextDeviceChannelMap[deviceId];
        }
      }

      const nextConnectedDeviceId = id ?? state.connectedDeviceId;
      const nextConnectedChannelId = id ? (channelId ?? null) : state.connectedChannelId;

      return {
        connectedDeviceId: nextConnectedDeviceId,
        connectedChannelId: nextConnectedChannelId,
        channelStates: nextChannelStates,
        deviceChannelMap: nextDeviceChannelMap,
      };
    }),
  setGattServices: (services, channelId) =>
    set((state) => {
      if (!channelId) return { gattServices: services };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        gattServices: services,
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, gattServices: services },
        },
      };
    }),
  clearChannelConnection: (channelId) =>
    set((state) => {
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      const nextDeviceChannelMap = { ...state.deviceChannelMap };
      for (const [deviceId, ownerChannelId] of Object.entries(nextDeviceChannelMap)) {
        if (ownerChannelId === channelId) delete nextDeviceChannelMap[deviceId];
      }

      const remainingConnection = Object.entries(state.channelStates).find(
        ([otherChannelId, channelState]) => otherChannelId !== channelId && !!channelState.connectedDeviceId
      );

      return {
        connectedDeviceId: remainingConnection?.[1].connectedDeviceId ?? null,
        connectedChannelId: remainingConnection?.[0] ?? null,
        gattServices: remainingConnection?.[1].gattServices ?? [],
        subscribedCharacteristics: remainingConnection?.[1].subscribedCharacteristics ?? [],
        channelStates: {
          ...state.channelStates,
          [channelId]: {
            ...previous,
            connectedDeviceId: null,
            gattServices: [],
            subscribedCharacteristics: [],
          },
        },
        deviceChannelMap: nextDeviceChannelMap,
      };
    }),
  setBleFilters: (channelId, filters) =>
    set((state) => ({
      bleFilters: {
        ...state.bleFilters,
        [channelId]: { ...(state.bleFilters[channelId] ?? DEFAULT_BLE_FILTERS), ...filters },
      },
    })),
  addSubscription: (serviceUuid, charUuid, channelId) =>
    set((state) => {
      const targetSubscriptions = channelId
        ? (state.channelStates[channelId]?.subscribedCharacteristics ?? [])
        : state.subscribedCharacteristics;
      if (targetSubscriptions.some(s => s.serviceUuid === serviceUuid && s.charUuid === charUuid)) {
        return state;
      }
      const nextSubscriptions = [...targetSubscriptions, { serviceUuid, charUuid }];
      if (!channelId) return { subscribedCharacteristics: nextSubscriptions };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        subscribedCharacteristics: nextSubscriptions,
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, subscribedCharacteristics: nextSubscriptions },
        },
      };
    }),
  removeSubscription: (serviceUuid, charUuid, channelId) =>
    set((state) => {
      const targetSubscriptions = channelId
        ? (state.channelStates[channelId]?.subscribedCharacteristics ?? [])
        : state.subscribedCharacteristics;
      const nextSubscriptions = targetSubscriptions.filter(
        s => !(s.serviceUuid === serviceUuid && s.charUuid === charUuid)
      );
      if (!channelId) return { subscribedCharacteristics: nextSubscriptions };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        subscribedCharacteristics: nextSubscriptions,
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, subscribedCharacteristics: nextSubscriptions },
        },
      };
    }),
  clearSubscriptions: (channelId) =>
    set((state) => {
      if (!channelId) return { subscribedCharacteristics: [] };
      const previous = state.channelStates[channelId] ?? createEmptyChannelState();
      return {
        subscribedCharacteristics: [],
        channelStates: {
          ...state.channelStates,
          [channelId]: { ...previous, subscribedCharacteristics: [] },
        },
      };
    }),
  setLastConnectedDeviceId: (channelId, deviceId) =>
    set((state) => ({
      lastConnectedDeviceIds: {
        ...state.lastConnectedDeviceIds,
        [channelId]: deviceId,
      },
    })),
  setLastConnectedDevice: (channelId, device) =>
    set((state) => ({
      lastConnectedDevices: {
        ...state.lastConnectedDevices,
        [channelId]: toLastConnectedBleDevice(device),
      },
    })),
  setCustomUuidName: (kind, uuid, name) =>
    set((state) => {
      const normalizedUuid = normalizeBleUuid(uuid);
      if (!normalizedUuid) return state;

      const collection = kind === 'service' ? 'services' : 'characteristics';
      const nextNames = { ...state.customUuidNames[collection] };
      const normalizedName = name.trim();
      if (normalizedName) {
        nextNames[normalizedUuid] = normalizedName;
      } else {
        delete nextNames[normalizedUuid];
      }

      return {
        customUuidNames: {
          ...state.customUuidNames,
          [collection]: nextNames,
        },
      };
    }),
  replaceCustomUuidNames: (names) => set({
    customUuidNames: {
      services: { ...names.services },
      characteristics: { ...names.characteristics },
    },
  }),
  getChannelState: (channelId) => get().channelStates[channelId] ?? createEmptyChannelState(),
  getConnectedDeviceIdForChannel: (channelId) => get().channelStates[channelId]?.connectedDeviceId ?? null,
  getLastConnectedDeviceForChannel: (channelId) => get().lastConnectedDevices[channelId] ?? null,
  getChannelIdForDevice: (deviceId) => get().deviceChannelMap[deviceId] ?? null,
}));
