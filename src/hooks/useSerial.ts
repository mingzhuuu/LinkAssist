import { isRemoteWorkspace } from '../stores/remoteStore';
import { remoteAction, remoteChannelAction } from '../lib/remoteClient';
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSerialStore, useChannelStore, useUIStore, normalizeSerialConfig } from '../stores';
import { SerialPortInfo, SerialConfig, MonitorDiscovery } from '../types';
import { registerChannelConnection, unregisterChannelConnection } from '../lib';
import { runLinkedCanvasDeactivateHooks } from '../components/display/canvasLifecycleRuntime';

export function useSerial() {
  const usbpcapDirectory = useUIStore(s => s.usbpcapDirectory);
  const { ports, setPorts, addConnection, removeConnection, setActiveConfig } = useSerialStore();
  const { updateChannelState } = useChannelStore();

  const refreshPorts = useCallback(async () => {
    if (isRemoteWorkspace()) { await remoteAction('serial.refresh').catch(() => {}); return; }
    try {
      const ports = await invoke<SerialPortInfo[]>('list_serial_ports');
      setPorts(ports);
    } catch (error) {
      console.error('Error refreshing ports:', error);
    }
  }, [setPorts]);

  const openPort = async (config: SerialConfig, channelId: string, requestElevation = false) => {
    if (isRemoteWorkspace() && config.monitor) throw new Error('Serial monitoring is currently available in the local workspace only');
    if (isRemoteWorkspace()) return await remoteChannelAction('channel.connect', channelId) as string;
    try {
      updateChannelState(channelId, 'connecting');
      // Final gate: repair configs that reached here malformed (stale
      // persisted settings, imported layouts) so open never fails on a
      // type-level mismatch like dataBits arriving as a string.
      const safeConfig = normalizeSerialConfig(config);
      const connectionId = safeConfig.monitor
        ? await invoke<string | null>('start_serial_monitor', {
          path: safeConfig.path, channelId, capture: safeConfig.usbCapture,
          manual: safeConfig.monitorManual, usbpcapDirectory,
          ...(requestElevation ? { requestElevation } : {}),
        })
        : await invoke<string>('open_serial_port', { config: safeConfig });
      if (connectionId === null) {
        updateChannelState(channelId, 'disconnected');
        return null;
      }
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

  const inspectMonitor = useCallback(async (path: string) => {
    if (isRemoteWorkspace()) throw new Error('Serial monitoring is available in the local workspace only');
    try {
      return await invoke<MonitorDiscovery>('inspect_serial_monitor', { path, usbpcapDirectory });
    } catch (error) {
      console.error('Error detecting USB monitor settings:', error);
      throw error;
    }
  }, [usbpcapDirectory]);

  const checkUsbpcap = useCallback(async () => {
    return await invoke<string>('check_usbpcap', { usbpcapDirectory });
  }, [usbpcapDirectory]);

  const openUsbpcapGuide = useCallback(async () => {
    await invoke('open_usbpcap_install_guide');
  }, []);

  const closePort = async (connectionId: string, channelId: string) => {
    if (isRemoteWorkspace()) { await remoteChannelAction('channel.disconnect', channelId); return; }
    try {
      await runLinkedCanvasDeactivateHooks(channelId);
      if (connectionId.startsWith('monitor:')) await invoke('stop_serial_monitor', { connectionId });
      else await invoke('close_serial_port', { connectionId });
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
    inspectMonitor,
    checkUsbpcap,
    openUsbpcapGuide,
    openPort,
    closePort,
    ports,
    setActiveConfig
  };
}
