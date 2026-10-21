import { invoke } from '@tauri-apps/api/core';

export type RegisteredChannelType = 'serial' | 'tcp-client' | 'tcp-server' | 'udp' | 'ble';

/**
 * Mirror channelId → connection bindings into the Rust backend so headless
 * callers (MCP Lua tools) can resolve "the current channel" to a transport.
 * Best-effort: registry staleness is re-checked backend-side at send time.
 */
export function registerChannelConnection(
  channelId: string,
  channelType: RegisteredChannelType,
  connectionId: string,
  targetAddr?: string,
): void {
  invoke('register_channel_connection', {
    channelId,
    channelType,
    connectionId,
    targetAddr: targetAddr ?? null,
  }).catch((error) => console.warn('Failed to register channel connection:', error));
}

export function unregisterChannelConnection(channelId: string): void {
  invoke('unregister_channel_connection', { channelId })
    .catch((error) => console.warn('Failed to unregister channel connection:', error));
}
