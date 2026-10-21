import { create } from 'zustand';
import { SerialPortInfo, SerialConfig } from '../types';

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  path: '',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  receiveTimeoutMs: 50,
};

const coerceNumber = (value: unknown, fallback: number): number => {
  const num = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
};

const pickUnion = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/**
 * Coerce an untrusted serial config (persisted file, imported layout, script
 * or AI input) into a complete, valid SerialConfig. Values that survived a
 * lossy round trip as strings ("8") or wrong casing ("None") are repaired;
 * anything unusable falls back to defaults so opening the port never fails
 * on malformed settings.
 */
export function normalizeSerialConfig(raw: unknown): SerialConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    path: typeof source.path === 'string' ? source.path : DEFAULT_SERIAL_CONFIG.path,
    baudRate: Math.max(1, coerceNumber(source.baudRate, DEFAULT_SERIAL_CONFIG.baudRate)),
    dataBits: pickUnion(coerceNumber(source.dataBits, DEFAULT_SERIAL_CONFIG.dataBits), [5, 6, 7, 8] as const, DEFAULT_SERIAL_CONFIG.dataBits),
    stopBits: pickUnion(coerceNumber(source.stopBits, DEFAULT_SERIAL_CONFIG.stopBits), [1, 2] as const, DEFAULT_SERIAL_CONFIG.stopBits),
    parity: pickUnion(String(source.parity ?? '').trim().toLowerCase(), ['none', 'odd', 'even'] as const, DEFAULT_SERIAL_CONFIG.parity),
    flowControl: pickUnion(String(source.flowControl ?? '').trim().toLowerCase(), ['none', 'rts_cts', 'dtr_dsr', 'xon_xoff'] as const, DEFAULT_SERIAL_CONFIG.flowControl),
    receiveTimeoutMs: Math.max(1, coerceNumber(source.receiveTimeoutMs, DEFAULT_SERIAL_CONFIG.receiveTimeoutMs)),
  };
}

interface SerialStore {
  ports: SerialPortInfo[];
  openConnections: string[];
  /** Maps connectionId → channelId for incoming event routing */
  connectionMap: Record<string, string>;
  activeConfig: SerialConfig;
  channelConfigs: Record<string, SerialConfig>;
  setPorts: (ports: SerialPortInfo[]) => void;
  addConnection: (id: string, channelId: string) => void;
  removeConnection: (id: string) => void;
  setActiveConfig: (config: Partial<SerialConfig>) => void;
  setChannelConfig: (channelId: string, config: Partial<SerialConfig>) => void;
}

export const useSerialStore = create<SerialStore>((set) => ({
  ports: [],
  openConnections: [],
  connectionMap: {},
  activeConfig: { ...DEFAULT_SERIAL_CONFIG },
  channelConfigs: {},
  setPorts: (ports) => set({ ports }),
  addConnection: (id, channelId) => set((s) => ({
    openConnections: [...s.openConnections, id],
    connectionMap: { ...s.connectionMap, [id]: channelId },
  })),
  removeConnection: (id) => set((s) => {
    const { [id]: _, ...rest } = s.connectionMap;
    return { openConnections: s.openConnections.filter((c) => c !== id), connectionMap: rest };
  }),
  setActiveConfig: (config) => set((s) => ({ activeConfig: { ...s.activeConfig, ...config } })),
  setChannelConfig: (channelId, config) =>
    set((state) => ({
      channelConfigs: {
        ...state.channelConfigs,
        [channelId]: { ...(state.channelConfigs[channelId] ?? DEFAULT_SERIAL_CONFIG), ...config },
      },
    })),
}));
