import { invoke } from '@tauri-apps/api/core';
import { useTcpStore, useChannelStore } from '../stores';
import { registerChannelConnection, unregisterChannelConnection } from '../lib';

export function useTcp() {
  const store = useTcpStore();
  const { updateChannelState } = useChannelStore();

  const connectTcp = async (addr: string, channelId: string) => {
    try {
      updateChannelState(channelId, 'connecting');
      const connectionId = await invoke<string>('tcp_connect', { addr });
      store.addClientConnection({ id: connectionId, addr }, channelId);
      registerChannelConnection(channelId, 'tcp-client', connectionId);
      updateChannelState(channelId, 'connected');
      return connectionId;
    } catch (error) {
      console.error('Error connecting TCP:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const disconnectTcp = async (connectionId: string, channelId: string) => {
    try {
      await invoke('tcp_disconnect', { connectionId });
      store.removeClientConnection(connectionId);
      unregisterChannelConnection(channelId);
      updateChannelState(channelId, 'disconnected');
    } catch (error) {
      console.error('Error disconnecting TCP:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const startServer = async (addr: string, channelId: string) => {
    try {
      updateChannelState(channelId, 'connecting');
      await invoke('tcp_server_start', { addr });
      store.setServerListening(true, addr);
      // Map server addr as connectionId for routing incoming server-client data to this channel
      store.setConnectionChannel(`server:${addr}`, channelId);
      registerChannelConnection(channelId, 'tcp-server', `server:${addr}`);
      updateChannelState(channelId, 'connected');
    } catch (error) {
      console.error('Error starting TCP server:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const stopServer = async (channelId: string) => {
    try {
      await invoke('tcp_server_stop');
      const current = useTcpStore.getState();
      for (const client of current.serverClients) store.removeConnectionMapping(client.id);
      store.removeConnectionMapping(`server:${current.serverAddr}`);
      store.setServerListening(false);
      store.setServerClients([]);
      unregisterChannelConnection(channelId);
      updateChannelState(channelId, 'disconnected');
    } catch (error) {
      console.error('Error stopping TCP server:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const disconnectClient = async (clientId: string) => {
    try {
      await invoke('tcp_server_disconnect_client', { clientId });
      store.removeServerClient(clientId);
    } catch (error) {
      console.error('Error disconnecting TCP client:', error);
      throw error;
    }
  };

  const bindUdp = async (addr: string, channelId: string) => {
    try {
      updateChannelState(channelId, 'connecting');
      await invoke('udp_bind', { addr });
      store.setUdpBound(true, addr);
      store.setConnectionChannel(`udp:${addr}`, channelId);
      registerChannelConnection(
        channelId,
        'udp',
        `udp:${addr}`,
        useTcpStore.getState().channelConfigs[channelId]?.udpTargetAddress,
      );
      updateChannelState(channelId, 'connected');
    } catch (error) {
      console.error('Error binding UDP:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const unbindUdp = async (channelId: string) => {
    try {
      await invoke('udp_unbind');
      store.removeConnectionMapping(`udp:${useTcpStore.getState().udpAddr}`);
      store.setUdpBound(false);
      unregisterChannelConnection(channelId);
      updateChannelState(channelId, 'disconnected');
    } catch (error) {
      console.error('Error unbinding UDP:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  return {
    ...store,
    connectTcp,
    disconnectTcp,
    startServer,
    stopServer,
    disconnectClient,
    bindUdp,
    unbindUdp
  };
}
