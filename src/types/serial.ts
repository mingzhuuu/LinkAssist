export interface SerialPortInfo {
  path: string;
  portType: string;
  manufacturer?: string;
  product?: string;
  vid?: number | null;
  pid?: number | null;
}

export interface UsbCaptureConfig {
  bus: number;
  address: number;
  inEndpoint: number;
  outEndpoint: number;
  profile: 'raw' | 'serial' | 'ftdi';
  packetSize: number;
}

export interface MonitorDiscovery {
  status: 'ready' | 'unsupported' | 'missing_tool' | 'driver_not_ready' | 'access_denied' | 'unresolved' | 'error';
  message: string;
  capture: UsbCaptureConfig | null;
}

export interface SerialConfig {
  monitor?: boolean;
  monitorManual?: boolean;
  usbCapture?: UsbCaptureConfig;
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'rts_cts' | 'dtr_dsr' | 'xon_xoff';
  receiveTimeoutMs: number;
}
