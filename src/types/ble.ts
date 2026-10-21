export interface BleDevice {
  id: string;
  name: string | null;
  rssi: number;
  serviceUuids: string[];
  manufacturerData: Record<string, number[]>;
  isConnectable?: boolean;
  serviceData?: Record<string, number[]>;
  txPowerLevel?: number | null;
  addressType?: string | null;
  class?: number | null;
  advertisementName?: string | null;
  appearance?: number | null;
}

export interface BlePairingStatus {
  deviceId: string;
  supported: boolean;
  isPaired: boolean;
  canPair: boolean;
  error?: string;
}

export interface BleConnectionParameters {
  intervalUs: number;
  latency: number;
  supervisionTimeoutUs: number;
}

export interface BleConnectionInfo {
  deviceId: string;
  isConnected: boolean;
  connectionParameters?: BleConnectionParameters;
}

export interface GattService {
  uuid: string;
  characteristics: GattCharacteristic[];
}

export interface GattCharacteristic {
  uuid: string;
  serviceUuid: string;
  properties: CharacteristicProperty[];
  value?: number[];
}

export type CharacteristicProperty = 'read' | 'write' | 'write_without_response' | 'notify' | 'indicate' | 'broadcast' | 'authenticated_signed_writes';
