export type TcpMode = 'client' | 'server' | 'udp';

export interface TcpConnection {
  id: string;
  mode: TcpMode;
  localAddr?: string;
  remoteAddr?: string;
  state: 'disconnected' | 'connecting' | 'connected' | 'listening';
}

export interface ConnectionHistory {
  addr: string;
  lastUsed: number;
}
