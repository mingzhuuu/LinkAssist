export type ChannelActivityKind = 'connected' | 'disconnected' | 'tx' | 'rx' | 'protocol' | 'error';

export type ChannelActivityTransport = 'ble' | 'serial' | 'tcp-client' | 'tcp-server' | 'udp';

export interface ChannelActivityEndpoint {
  deviceId?: string;
  deviceName?: string;
  serialPath?: string;
  address?: string;
  localAddress?: string;
  remoteAddress?: string;
  serviceUuid?: string;
  charUuid?: string;
}

export interface ChannelActivityProtocol {
  transactionId?: string;
  status?: 'running' | 'passed' | 'failed';
  parsed?: unknown;
  error?: string;
}

export interface ChannelActivityEvent {
  activityId: string;
  timestamp: number;
  kind: ChannelActivityKind;
  source: string;
  transport: ChannelActivityTransport;
  channelId?: string;
  connectionId?: string;
  endpoint?: ChannelActivityEndpoint;
  data?: number[];
  text?: string;
  protocol?: ChannelActivityProtocol;
  runId?: string;
  caseId?: string;
}

export interface DetachedTerminalEntryEvent {
  channelId: string;
  channelName: string;
  channelType: string;
  kind: 'tx' | 'system';
  timestamp: number;
  text: string;
  data?: number[];
  bleMetadata?: {
    serviceUuid: string;
    charUuid: string;
  };
}
