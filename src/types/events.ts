import type { ChannelActivityEvent, DetachedTerminalEntryEvent } from './channelActivity';

/** JSON payloads emitted by the Rust transport managers (camelCase via serde). */
export interface ConnectionDataEvent {
  connectionId: string;
  data: number[];
  timestamp: number;
}

export interface UdpDataEvent {
  localAddr: string;
  remoteAddr: string;
  data: number[];
  timestamp: number;
}

export interface BleNotificationEvent {
  deviceId: string;
  serviceUuid: string;
  charUuid: string;
  data: number[];
  timestamp: number;
}

export interface ConnectionClosedEvent { connectionId: string }
export interface ConnectionErrorEvent extends ConnectionClosedEvent { error: string }
export interface TcpClientEvent { id: string; addr: string }

/** Shared contract for main-window and detached-terminal receive routing. */
export interface AppEventMap {
  'serial-data-received': ConnectionDataEvent;
  'serial-connection-closed': ConnectionClosedEvent;
  'serial-connection-error': ConnectionErrorEvent;
  'tcp-data-received': ConnectionDataEvent;
  'tcp-connection-closed': ConnectionClosedEvent;
  'tcp-connection-error': ConnectionErrorEvent;
  'tcp-client-connected': TcpClientEvent;
  'tcp-client-disconnected': TcpClientEvent;
  'udp-data-received': UdpDataEvent;
  'ble-notification-received': BleNotificationEvent;
  'ble-connection-closed': { deviceId: string };
  'channel-activity': ChannelActivityEvent;
  'detached-terminal-entry': DetachedTerminalEntryEvent;
}
