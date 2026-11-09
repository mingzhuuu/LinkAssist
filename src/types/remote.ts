import type { Channel } from './channel';
import type { SerialConfig, SerialPortInfo } from './serial';
import type { TcpChannelConfig } from '../stores/tcpStore';
import type { BleChannelState } from '../stores/bleStore';
import type { TerminalEntry } from '../stores/terminalStore';
import type { Canvas } from './canvas';
import type { CanvasDataRow } from '../stores/canvasStore';
import type { RemoteCanvasView } from '../lib/remoteCanvasBridge';
import type { ThemeMode } from '../stores/uiStore';

export interface RemotePeer { id: string; name: string; invitation: string | null }
export interface RemoteStatus {
  enabled: boolean;
  noApproval?: boolean;
  invitation?: string | null;
  inviteExpiresAt?: number | null;
  persistentInvite?: boolean;
  endpointId: string | null;
  pending: { id: string; name: string; requestId: string } | null;
  trusted: RemotePeer[];
  recent: RemotePeer[];
  controller: RemotePeer | null;
  connected: RemotePeer | null;
  connecting: boolean;
  transport: 'direct' | 'relay' | null;
  rttMs: number | null;
  reconnectAllowed: boolean;
}

export interface RemoteChannel {
  channel: Channel;
  revision: string;
  serial: SerialConfig;
  tcp: TcpChannelConfig;
  ble: BleChannelState | null;
  clients: Array<{ id: string; addr: string }>;
}

export interface RemoteWorkspaceSnapshot {
  content?: import('../lib/remoteWorkspaceState').WorkspaceContent;
  terminalEntries?: Record<string, Record<string, TerminalEntry[]>>;
  terminalEntryIds?: Record<string, Record<string, number[]>>;
  chartViewState?: Record<string, { paused: boolean }>;
  connections?: {
    serial: Pick<ReturnType<typeof import('../stores/serialStore').useSerialStore.getState>, 'connectionMap' | 'openConnections'>;
    tcp: Pick<ReturnType<typeof import('../stores/tcpStore').useTcpStore.getState>, 'connectionMap' | 'clientConnections' | 'serverListening' | 'serverAddr' | 'serverClients' | 'udpBound' | 'udpAddr'>;
    ble: Pick<ReturnType<typeof import('../stores/bleStore').useBleStore.getState>, 'scanningChannelId' | 'connectedChannelId' | 'connectedDeviceId' | 'deviceChannelMap' | 'devices' | 'gattServices' | 'lastConnectedDeviceIds' | 'lastConnectedDevices'>;
  };
  layout?: import('../lib/remoteLayout').RemoteLayout;
  layoutRevision?: string;
  canvasFrames?: Record<string, { rows: CanvasDataRow[]; chart: Array<Array<number | null>> | null; view: RemoteCanvasView | null }>;
  commands?: ReturnType<typeof import('../stores/commandStore').useCommandStore.getState>['commandSets'];
  version: 1;
  sequence: number;
  themeMode: ThemeMode;
  channels: RemoteChannel[];
  ports: SerialPortInfo[];
  scanning: boolean;
  entries: TerminalEntry[];
  canvases: Array<Pick<Canvas, 'id' | 'name' | 'active' | 'config'> & Partial<Pick<Canvas, 'activationMode' | 'groupId'>>>;
  canvasId: string | null;
  rows: CanvasDataRow[];
  chart: Array<Array<number | null>> | null;
  canvasView: RemoteCanvasView | null;
}

export interface RemoteHostRequest { id: string; action: string; args: Record<string, unknown> }
