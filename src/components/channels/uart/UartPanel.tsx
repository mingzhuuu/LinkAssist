import React, { useEffect, useCallback } from 'react';
import { useSerial } from '../../../hooks/useSerial';
import { useSerialStore, useChannelStore, DEFAULT_SERIAL_CONFIG } from '../../../stores';
import { toast } from '../../../stores/toastStore';
import { RoundedSelect } from '../../common/RoundedSelect';

export const UartPanel = React.memo(function UartPanel({ channelId }: { channelId: string }) {
  const { refreshPorts, openPort, closePort, ports, setActiveConfig } = useSerial();
  const savedConfig = useSerialStore(s => s.channelConfigs[channelId]);
  const setChannelConfig = useSerialStore(s => s.setChannelConfig);
  const channelState = useChannelStore(s => s.channels.find(c => c.id === channelId)?.state ?? 'disconnected');
  const connectionMap = useSerialStore(s => s.connectionMap);
  const currentConnectionId = Object.entries(connectionMap).find(([, cid]) => cid === channelId)?.[0] ?? null;
  const isOpen = channelState === 'connected' || channelState === 'connecting';

  const config = savedConfig ?? { ...DEFAULT_SERIAL_CONFIG };
  const selectedPort = config.path;

  const uartLabelClassName = 'channel-config-label w-[96px]';
  const uartFieldClassName = 'channel-config-control w-[140px] min-w-[140px] max-w-none';
  const uartInputClassName = `${uartFieldClassName} serial-timeout-input bg-surface border border-border rounded-lg px-3 py-1.5 font-mono text-[13px] text-text-primary outline-none focus:border-accent-mauve/40 disabled:opacity-50`;

  useEffect(() => {
    void refreshPorts();
    const intervalId = window.setInterval(() => {
      void refreshPorts();
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [refreshPorts]);

  useEffect(() => {
    if (!savedConfig && ports.length > 0 && !selectedPort) {
      setChannelConfig(channelId, { ...DEFAULT_SERIAL_CONFIG, path: ports[0].path });
    }
  }, [channelId, ports, savedConfig, selectedPort, setChannelConfig]);

  const handleOpenClose = useCallback(async () => {
    if (isOpen && currentConnectionId) {
      try {
        await closePort(currentConnectionId, channelId);
        toast.info('Port closed');
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      try {
        await openPort(config, channelId);
        setActiveConfig(config);
        toast.success('Port opened successfully');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [isOpen, currentConnectionId, closePort, channelId, openPort, config, setActiveConfig]);

  return (
    <div className="flex w-full max-h-full flex-col items-stretch">
      {/* Top bar — OUTSIDE the bordered content area */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 mb-2 transition-all duration-300 min-h-[40px]">
        {/* Left side: "Refresh Ports" button + port info when open */}
        <div className="min-w-0 overflow-hidden">
          {isOpen ? (
            // When connected: show port name + baud rate info
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <span className="min-w-0 truncate text-text-primary font-medium text-lg">{selectedPort}</span>
              <span className="shrink-0 text-text-muted font-mono text-sm ml-2">{config.baudRate} baud</span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <span className="truncate text-text-secondary text-sm">
                {ports.length === 0 ? 'Scanning ports...' : `${ports.length} port${ports.length === 1 ? '' : 's'} available`}
              </span>
            </div>
          )}
        </div>
        {/* Right side: Open/Close button */}
        <div className="ml-4 shrink-0">
          <button
            onClick={handleOpenClose}
            className={`btn-channel-action ${
              isOpen
                ? 'bg-accent-red hover:bg-accent-red/80 text-surface'
                : 'bg-accent-mauve hover:bg-accent-mauve/80 text-surface'
            }`}
          >
            {isOpen ? 'Close Port' : 'Open Port'}
          </button>
        </div>
      </div>

      {/* Content area — rounded bordered container */}
      <div className="bg-surface border border-border rounded-lg flex min-h-0 flex-col overflow-y-auto scrollbar-stable">
        <div>
          <div className="channel-config-row">
            <label className={uartLabelClassName}>Port</label>
            <RoundedSelect
              value={selectedPort}
              onChange={(path) => setChannelConfig(channelId, { ...config, path })}
              disabled={isOpen || ports.length === 0}
              className={uartFieldClassName}
              tone="mauve"
              placeholder=""
              options={ports.map(port => ({
                value: port.path,
                label: port.path,
                title: port.product ?? port.manufacturer ?? port.path
              }))}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Baud Rate</label>
            <RoundedSelect
              value={String(config.baudRate)}
              onChange={value => setChannelConfig(channelId, { ...config, baudRate: parseInt(value) })}
              disabled={isOpen}
              className={uartFieldClassName}
              tone="mauve"
              options={[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(baudRate => ({
                value: String(baudRate),
                label: String(baudRate)
              }))}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Data Bits</label>
            <RoundedSelect
              value={String(config.dataBits)}
              onChange={value => setChannelConfig(channelId, { ...config, dataBits: parseInt(value) as 5 | 6 | 7 | 8 })}
              disabled={isOpen}
              className={uartFieldClassName}
              tone="mauve"
              options={[5, 6, 7, 8].map(dataBits => ({
                value: String(dataBits),
                label: String(dataBits)
              }))}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Stop Bits</label>
            <RoundedSelect
              value={String(config.stopBits)}
              onChange={value => setChannelConfig(channelId, { ...config, stopBits: parseInt(value) as 1 | 2 })}
              disabled={isOpen}
              className={uartFieldClassName}
              tone="mauve"
              options={[1, 2].map(stopBits => ({
                value: String(stopBits),
                label: String(stopBits)
              }))}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Parity</label>
            <RoundedSelect
              value={config.parity}
              onChange={value => setChannelConfig(channelId, { ...config, parity: value as 'none' | 'odd' | 'even' })}
              disabled={isOpen}
              className={uartFieldClassName}
              tone="mauve"
              options={['none', 'odd', 'even'].map(parity => ({
                value: parity,
                label: parity
              }))}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Flow Control</label>
            <RoundedSelect
              value={config.flowControl}
              onChange={value => setChannelConfig(channelId, { ...config, flowControl: value as 'none' | 'rts_cts' | 'dtr_dsr' | 'xon_xoff' })}
              disabled={isOpen}
              className={uartFieldClassName}
              tone="mauve"
              options={[
                { value: 'none', label: 'None' },
                { value: 'rts_cts', label: 'RTS/CTS' },
                { value: 'dtr_dsr', label: 'DTR/DSR' },
                { value: 'xon_xoff', label: 'XON/XOFF' }
              ]}
            />
          </div>

          <div className="channel-config-row">
            <label className={uartLabelClassName}>Recv Timeout</label>
            <input
              type="number"
              min={1}
              step={1}
              value={config.receiveTimeoutMs}
              onChange={(event) => {
                const nextValue = Number.parseInt(event.target.value, 10);
                setChannelConfig(channelId, {
                  ...config,
                  receiveTimeoutMs: Number.isFinite(nextValue)
                    ? Math.max(1, nextValue)
                    : DEFAULT_SERIAL_CONFIG.receiveTimeoutMs,
                });
              }}
              disabled={isOpen}
              className={uartInputClassName}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
