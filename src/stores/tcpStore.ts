import { create } from 'zustand';
import { TcpMode } from '../types';

export interface TcpChannelConfig {
  mode: TcpMode;
  clientAddress: string;
  serverAddress: string;
  udpBindAddress: string;
  udpTargetAddress: string;
}

export const DEFAULT_TCP_CONFIG: TcpChannelConfig = {
  mode: 'client',
  clientAddress: '127.0.0.1:8080',
  serverAddress: '0.0.0.0:8080',
  udpBindAddress: '0.0.0.0:8080',
  udpTargetAddress: '127.0.0.1:8081',
};

interface TcpConnectionInfo {
  id: string;
  addr: string;
}

interface TcpStore {
  mode: TcpMode;
  clientConnections: TcpConnectionInfo[];
  serverClients: TcpConnectionInfo[];
  serverListening: boolean;
  serverAddr: string;
  udpBound: boolean;
  udpAddr: string;
  /** Maps connectionId → channelId for incoming event routing */
  connectionMap: Record<string, string>;
  channelConfigs: Record<string, TcpChannelConfig>;
  setMode: (mode: TcpMode) => void;
  addClientConnection: (info: TcpConnectionInfo, channelId: string) => void;
  removeClientConnection: (id: string) => void;
  setServerClients: (clients: TcpConnectionInfo[]) => void;
  addServerClient: (info: TcpConnectionInfo) => void;
  removeServerClient: (id: string) => void;
  setServerListening: (listening: boolean, addr?: string) => void;
  setUdpBound: (bound: boolean, addr?: string) => void;
  /** Set the channelId for server/UDP connections (for event routing) */
  setConnectionChannel: (connectionId: string, channelId: string) => void;
  removeConnectionMapping: (connectionId: string) => void;
  setChannelConfig: (channelId: string, config: Partial<TcpChannelConfig>) => void;
}

const initialState = {
  mode: 'client' as TcpMode,
  clientConnections: [] as TcpConnectionInfo[],
  serverClients: [] as TcpConnectionInfo[],
  serverListening: false,
  serverAddr: '',
  udpBound: false,
  udpAddr: '',
  connectionMap: {} as Record<string, string>,
  channelConfigs: {} as Record<string, TcpChannelConfig>,
};

export const useTcpStore = create<TcpStore>((set) => ({
  ...initialState,
  setMode: (mode) => set({ mode }),
  addClientConnection: (info, channelId) => set((s) => ({
    clientConnections: [...s.clientConnections, info],
    connectionMap: { ...s.connectionMap, [info.id]: channelId },
  })),
  removeClientConnection: (id) => set((s) => {
    const { [id]: _, ...rest } = s.connectionMap;
    return { clientConnections: s.clientConnections.filter((c) => c.id !== id), connectionMap: rest };
  }),
  setServerClients: (clients) => set({ serverClients: clients }),
  addServerClient: (info) => set((s) => ({ serverClients: [...s.serverClients, info] })),
  removeServerClient: (id) => set((s) => ({ serverClients: s.serverClients.filter((c) => c.id !== id) })),
  setServerListening: (listening, addr) => set((s) => ({ serverListening: listening, serverAddr: addr ?? s.serverAddr })),
  setUdpBound: (bound, addr) => set((s) => ({ udpBound: bound, udpAddr: addr ?? s.udpAddr })),
  setConnectionChannel: (connectionId, channelId) => set((s) => ({
    connectionMap: { ...s.connectionMap, [connectionId]: channelId },
  })),
  removeConnectionMapping: (connectionId) => set((s) => {
    const { [connectionId]: _, ...rest } = s.connectionMap;
    return { connectionMap: rest };
  }),
  setChannelConfig: (channelId, config) =>
    set((state) => ({
      channelConfigs: {
        ...state.channelConfigs,
        [channelId]: { ...(state.channelConfigs[channelId] ?? DEFAULT_TCP_CONFIG), ...config },
      },
    })),
}));
