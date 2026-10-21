import type { Channel, ChannelActivityEvent } from '../types';
import type { TcpChannelConfig } from '../stores/tcpStore';

export interface ChannelActivityMatchState {
  activeChannel: Channel | undefined;
  bleDeviceIds: string[];
  serialPath?: string;
  tcpConfig?: TcpChannelConfig;
}

const normalized = (value: string | undefined): string | undefined => value?.trim() || undefined;

export function activityMatchesActiveChannel(
  activity: ChannelActivityEvent,
  state: ChannelActivityMatchState,
): boolean {
  const channel = state.activeChannel;
  if (!channel) return false;
  const compatibleTransport = channel.type === 'ble'
    ? activity.transport === 'ble'
    : channel.type === 'serial'
      ? activity.transport === 'serial'
      : activity.transport === 'tcp-client'
        || activity.transport === 'tcp-server'
        || activity.transport === 'udp';
  if (!compatibleTransport) return false;
  if (activity.channelId) return activity.channelId === channel.id;

  if (channel.type === 'ble' && activity.transport === 'ble') {
    const deviceId = normalized(activity.endpoint?.deviceId);
    return !!deviceId && state.bleDeviceIds.some(candidate => normalized(candidate) === deviceId);
  }

  if (channel.type === 'serial' && activity.transport === 'serial') {
    const expectedPath = normalized(state.serialPath);
    return !!expectedPath && normalized(activity.endpoint?.serialPath) === expectedPath;
  }

  if (channel.type !== 'tcp' || !state.tcpConfig) return false;
  const config = state.tcpConfig;
  if (activity.transport === 'tcp-client') {
    const address = normalized(config.clientAddress);
    return config.mode === 'client' && !!address && normalized(activity.endpoint?.address) === address;
  }
  if (activity.transport === 'tcp-server') {
    const address = normalized(config.serverAddress);
    return config.mode === 'server' && !!address
      && normalized(activity.endpoint?.localAddress ?? activity.endpoint?.address) === address;
  }
  if (activity.transport === 'udp') {
    const address = normalized(config.udpBindAddress);
    return config.mode === 'udp' && !!address && normalized(activity.endpoint?.localAddress) === address;
  }
  return false;
}

export function channelActivitySourceLabel(activity: ChannelActivityEvent): string {
  const source = normalized(activity.source)?.toUpperCase() ?? 'MCP';
  const endpoint = activity.endpoint;
  const target = endpoint?.deviceName
    ?? endpoint?.deviceId
    ?? endpoint?.serialPath
    ?? endpoint?.address
    ?? endpoint?.localAddress
    ?? activity.connectionId;
  if (source === 'TEST') {
    return [activity.transport.toUpperCase(), target].filter(Boolean).join(' · ');
  }
  const testCase = normalized(activity.caseId);
  return [source, activity.transport.toUpperCase(), target, testCase].filter(Boolean).join(' · ');
}

export function shouldDisplayChannelActivity(activity: ChannelActivityEvent): boolean {
  const source = normalized(activity.source)?.toLowerCase();
  return source !== 'test' || activity.kind === 'tx' || activity.kind === 'rx';
}
