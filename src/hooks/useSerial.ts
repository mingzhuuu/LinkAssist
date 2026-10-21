import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSerialStore, useChannelStore, normalizeSerialConfig } from '../stores';
import { SerialPortInfo, SerialConfig } from '../types';
import { registerChannelConnection, unregisterChannelConnection } from '../lib';
import { runLinkedCanvasDeactivateHooks } from '../components/display/canvasLifecycleRuntime';

export function useSerial() {
  const { ports, setPorts, addConnection, removeConnection, setActiveConfig } = useSerialStore();
  const { updateChannelState } = useChannelStore();

  const refreshPorts = useCallback(async () => {
    try {
      const ports = await invoke<SerialPortInfo[]>('list_serial_ports');
      setPorts(ports);
    } catch (error) {
      console.error('Error refreshing ports:', error);
    }
  }, [setPorts]);

  const openPort = async (config: SerialConfig, channelId: string) => {
    try {
      updateChannelState(channelId, 'connecting');
      // Final gate: repair configs that reached here malformed (stale
      // persisted settings, imported layouts) so open never fails on a
      // type-level mismatch like dataBits arriving as a string.
      const safeConfig = normalizeSerialConfig(config);
      const connectionId = await invoke<string>('open_serial_port', { config: safeConfig });
      addConnection(connectionId, channelId);
      registerChannelConnection(channelId, 'serial', connectionId);
      updateChannelState(channelId, 'connected');
      return connectionId;
    } catch (error) {
      console.error('Error opening port:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  const closePort = async (connectionId: string, channelId: string) => {
    try {
      await runLinkedCanvasDeactivateHooks(channelId);
      await invoke('close_serial_port', { connectionId });
      removeConnection(connectionId);
      unregisterChannelConnection(channelId);
      updateChannelState(channelId, 'disconnected');
    } catch (error) {
      console.error('Error closing port:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }
  };

  return {
    refreshPorts,
    openPort,
    closePort,
    ports,
    setActiveConfig
  };
}
