export type ChannelType = 'ble' | 'serial' | 'tcp';

export type ChannelState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  state: ChannelState;
  createdAt: number;
}
