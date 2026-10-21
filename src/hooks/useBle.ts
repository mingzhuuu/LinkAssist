import { invoke } from '@tauri-apps/api/core';
import { useBleStore, useChannelStore } from '../stores';
import { useTerminalStore } from '../stores/terminalStore';
import { toast } from '../stores/toastStore';
import { BleConnectionInfo, BleDevice, BlePairingStatus, GattService } from '../types';
import { registerChannelConnection, unregisterChannelConnection } from '../lib';

const wait = (ms: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, ms);
});

export function useBle() {
  const { scanning, devices, setScanning, setDevices, clearDevices, setConnectedDeviceId, setGattServices, clearChannelConnection, setLastConnectedDeviceId, setLastConnectedDevice } = useBleStore();
  const { updateChannelState } = useChannelStore();

  const startScan = async (channelId?: string) => {
    try {
      clearDevices(channelId);
      await invoke('start_ble_scan');
      setScanning(true, channelId);
      
      const pollDevices = async () => {
        const bleState = useBleStore.getState();
        if (!bleState.scanning) return;
        if (channelId && bleState.scanningChannelId !== channelId) return;
        try {
          const newDevices = await invoke<BleDevice[]>('get_ble_devices');
          setDevices(newDevices, channelId);
          setTimeout(pollDevices, 1000);
        } catch (error) {
          console.error('Error polling devices:', error);
          toast.error(`BLE scan interrupted: ${String(error)}`);
          setScanning(false);
        }
      };

      setTimeout(pollDevices, 1000);
    } catch (error) {
      console.error('Error starting scan:', error);
      toast.error(`Failed to start BLE scan: ${String(error)}`);
      setScanning(false);
    }
  };

  const stopScan = async () => {
    try {
      await invoke('stop_ble_scan');
      setScanning(false);
    } catch (error) {
      console.error('Error stopping scan:', error);
      toast.error(`Failed to stop BLE scan: ${String(error)}`);
      setScanning(false);
    }
  };

  const scanForReconnectAttempt = async (channelId: string, durationMs: number) => {
    const bleState = useBleStore.getState();
    if (bleState.scanning) {
      await stopScan().catch(() => {});
    }

    await startScan(channelId);

    try {
      await wait(durationMs);
    } finally {
      await stopScan().catch(() => {});
    }
  };

  const connectDevice = async (deviceId: string, channelId: string) => {
    try {
      updateChannelState(channelId, 'connecting');
      const connection = await invoke<BleConnectionInfo>('connect_ble_device', { deviceId });
      updateChannelState(channelId, 'connected');
      setConnectedDeviceId(deviceId, channelId);
      setLastConnectedDeviceId(channelId, deviceId);
      registerChannelConnection(channelId, 'ble', deviceId);

      if (connection.connectionParameters) {
        const { intervalUs, latency, supervisionTimeoutUs } = connection.connectionParameters;
        useTerminalStore.getState().appendEntryToChannel(
          channelId,
          'system',
          `BLE connection: interval ${(intervalUs / 1000).toFixed(2)} ms, latency ${latency}, supervision timeout ${(supervisionTimeoutUs / 1000).toFixed(0)} ms`,
        );
      }

      const bleState = useBleStore.getState();
      const knownDevice = bleState.getChannelState(channelId).devices.find((device) => device.id === deviceId)
        ?? bleState.devices.find((device) => device.id === deviceId)
        ?? bleState.getLastConnectedDeviceForChannel(channelId);
      if (knownDevice) {
        setLastConnectedDevice(channelId, knownDevice);
      }
    } catch (error) {
      console.error('Error connecting device:', error);
      updateChannelState(channelId, 'error');
      throw error;
    }

    // Discover GATT services after connection is established.
    // Failures here should not revert the connection state.
    try {
      await discoverServices(deviceId, channelId);
    } catch (error) {
      console.warn('GATT service discovery failed:', error);
    }
  };

  const reconnectLastDevice = async (channelId: string, deviceId?: string) => {
    const targetDeviceId = deviceId ?? useBleStore.getState().lastConnectedDeviceIds[channelId];
    if (!targetDeviceId) {
      throw new Error('No previous BLE device available to reconnect');
    }

    await scanForReconnectAttempt(channelId, 3000);

    try {
      await connectDevice(targetDeviceId, channelId);
      return targetDeviceId;
    } catch (initialError) {
      await scanForReconnectAttempt(channelId, 10000);
      try {
        await connectDevice(targetDeviceId, channelId);
        return targetDeviceId;
      } catch (retryError) {
        throw retryError instanceof Error ? retryError : initialError;
      }
    }
  };

  const disconnectDevice = async (deviceId: string, channelId: string) => {
    try {
      await invoke('disconnect_ble_device', { deviceId });
      updateChannelState(channelId, 'disconnected');
      clearChannelConnection(channelId);
      unregisterChannelConnection(channelId);
    } catch (error) {
      console.error('Error disconnecting device:', error);
      updateChannelState(channelId, 'error');
    }
  };

  const getPairingStatuses = async (deviceIds: string[]) => {
    try {
      return await invoke<BlePairingStatus[]>('get_ble_pairing_statuses', { deviceIds });
    } catch (error) {
      console.error('Error getting BLE pairing status:', error);
      throw error;
    }
  };

  const discoverServices = async (deviceId: string, channelId?: string) => {
    try {
      const services = await invoke<GattService[]>('get_gatt_services', { deviceId });
      setGattServices(services, channelId);
      return services;
    } catch (error) {
      console.error('Error discovering services:', error);
      throw error;
    }
  };

  const readCharacteristic = async (deviceId: string, serviceUuid: string, charUuid: string) => {
    try {
      const data = await invoke<number[]>('read_ble_characteristic', { deviceId, serviceUuid, charUuid });
      return data;
    } catch (error) {
      console.error('Error reading characteristic:', error);
      throw error;
    }
  };

  const writeCharacteristic = async (deviceId: string, serviceUuid: string, charUuid: string, data: number[]) => {
    try {
      await invoke('write_ble_characteristic', { deviceId, serviceUuid, charUuid, data });
    } catch (error) {
      console.error('Error writing characteristic:', error);
      throw error;
    }
  };

  const subscribeNotifications = async (deviceId: string, serviceUuid: string, charUuid: string) => {
    try {
      await invoke('subscribe_ble_notifications', { deviceId, serviceUuid, charUuid });
    } catch (error) {
      console.error('Error subscribing to notifications:', error);
      throw error;
    }
  };

  const unsubscribeNotifications = async (deviceId: string, serviceUuid: string, charUuid: string) => {
    try {
      await invoke('unsubscribe_ble_notifications', { deviceId, serviceUuid, charUuid });
    } catch (error) {
      console.error('Error unsubscribing from notifications:', error);
      throw error;
    }
  };

  return {
    startScan,
    stopScan,
    connectDevice,
    reconnectLastDevice,
    disconnectDevice,
    getPairingStatuses,
    discoverServices,
    readCharacteristic,
    writeCharacteristic,
    subscribeNotifications,
    unsubscribeNotifications,
    scanning,
    devices
  };
}
