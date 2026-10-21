export interface SerialPortInfo {
  path: string;
  portType: string;
  manufacturer?: string;
  product?: string;
}

export interface SerialConfig {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: 'none' | 'odd' | 'even';
  flowControl: 'none' | 'rts_cts' | 'dtr_dsr' | 'xon_xoff';
  receiveTimeoutMs: number;
}
