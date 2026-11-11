import React, { useEffect, useCallback, useState } from 'react';
import { useSerial } from '../../../hooks';
import { useSerialStore, useChannelStore, useUIStore, DEFAULT_SERIAL_CONFIG, normalizeSerialConfig } from '../../../stores';
import { toast } from '../../../stores/toastStore';
import { RoundedSelect } from '../../common/RoundedSelect';
import type { MonitorDiscovery, UsbCaptureConfig, SerialConfig } from '../../../types';

export const UartPanel = React.memo(function UartPanel({ channelId }: { channelId: string }) {
  const [pending, setPending] = useState(false);
  const { refreshPorts, inspectMonitor, openPort, closePort, ports, setActiveConfig } = useSerial();
  const [detection, setDetection] = useState<{ path: string; channelId: string; report: MonitorDiscovery } | null>(null);

  const showSerialMode = useUIStore(s => s.showSerialMode);
  const savedConfig = useSerialStore(s => s.channelConfigs[channelId]);
  const setChannelConfig = useSerialStore(s => s.setChannelConfig);
  const channelState = useChannelStore(s => s.channels.find(c => c.id === channelId)?.state ?? 'disconnected');
  const connectionMap = useSerialStore(s => s.connectionMap);
  const currentConnectionId = Object.entries(connectionMap).find(([, cid]) => cid === channelId)?.[0] ?? null;
  const isOpen = channelState === 'connected' || channelState === 'connecting';

  const config = savedConfig ?? { ...DEFAULT_SERIAL_CONFIG };
  const isMonitor = isOpen && currentConnectionId
    ? currentConnectionId.startsWith('monitor:')
    : showSerialMode && !!config.monitor;
  const selectedPort = config.path;
  const report = detection?.path === selectedPort && detection.channelId === channelId ? detection.report : null;

  const isManual = !!config.monitorManual;
  const reportCapture = report?.capture;
  const fallbackCapture = normalizeSerialConfig(config).usbCapture!;
  const baseCapture = reportCapture ?? fallbackCapture;
  const capture: UsbCaptureConfig = {
    bus: isManual && config.usbCapture?.bus !== undefined ? config.usbCapture.bus : baseCapture.bus,
    address: isManual && config.usbCapture?.address !== undefined ? config.usbCapture.address : baseCapture.address,
    inEndpoint: isManual && config.usbCapture?.inEndpoint !== undefined ? config.usbCapture.inEndpoint : baseCapture.inEndpoint,
    outEndpoint: isManual && config.usbCapture?.outEndpoint !== undefined ? config.usbCapture.outEndpoint : baseCapture.outEndpoint,
    profile: isManual && config.usbCapture?.profile !== undefined ? config.usbCapture.profile : baseCapture.profile,
    packetSize: isManual && config.usbCapture?.packetSize !== undefined ? config.usbCapture.packetSize : baseCapture.packetSize,
  };
  const visiblePorts = isMonitor ? ports.filter(port => port.portType === 'USB') : ports;
  const portPresent = visiblePorts.some(port => port.path === selectedPort);
  const validManual = capture.bus > 0 && capture.address >= 1 && capture.address <= 127
    && capture.inEndpoint >= 129 && capture.inEndpoint <= 143 && capture.outEndpoint >= 1 && capture.outEndpoint <= 15;
  const monitorReady = portPresent && !!report && report.status !== 'unsupported'
    && (isManual ? validManual : report.status === 'ready' || report.status === 'access_denied');

  useEffect(() => {
    if (!isMonitor || isOpen) return;
    let cancelled = false;
    setDetection(null);
    if (selectedPort && portPresent) {
      void inspectMonitor(selectedPort).then(report => {
        if (!cancelled) setDetection({ path: selectedPort, channelId, report });
      }).catch(error => {
        if (!cancelled) setDetection({ path: selectedPort, channelId, report: { status: 'error', message: String(error), capture: null } });
      });
    }
    return () => { cancelled = true; };
  }, [channelId, selectedPort, portPresent, isMonitor, isOpen, inspectMonitor]);

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
        toast.info(isMonitor ? 'Monitoring stopped' : 'Port closed');
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      try {
        const effectiveConfig: SerialConfig = {
          ...config,
          monitor: isMonitor,
          monitorManual: isManual,
          usbCapture: isManual ? capture : undefined,
        };
        if (await openPort(effectiveConfig, channelId, isMonitor) === null) return;
        setActiveConfig(effectiveConfig);
        toast.success(isMonitor ? 'Monitoring started' : 'Port opened successfully');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [isOpen, currentConnectionId, closePort, channelId, openPort, config, setActiveConfig, isMonitor, isManual, capture]);

  return (
    <div className="flex w-full max-h-full flex-col items-stretch">
      {/* Top bar — OUTSIDE the bordered content area */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 mb-2 transition-all duration-300 min-h-[40px]">
        {/* Left side: mode selector + port info when open */}
        <div className="min-w-0">
          {isOpen ? (
            // When connected: show port name + baud rate info
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <span className="min-w-0 truncate text-text-primary font-medium text-lg">{selectedPort}</span>
              <span className="shrink-0 text-text-secondary font-mono text-sm ml-2">
                {isMonitor ? 'Monitor' : `${config.baudRate} baud`}
              </span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              {showSerialMode && (
                <div className="flex shrink-0 items-center gap-1.5 mt-1.5">
                  {(['normal', 'monitor'] as const).map(m => {
                    const isCurrent = m === 'monitor' ? !!config.monitor : !config.monitor;
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={isOpen || pending}
                        onClick={() => setChannelConfig(channelId, { monitor: m === 'monitor' })}
                        className={`inline-flex h-6 min-w-[48px] shrink-0 items-center justify-center rounded-md px-2 text-xs font-semibold transition-all duration-150 border disabled:opacity-50 disabled:pointer-events-none ${
                          isCurrent
                            ? 'bg-accent-mauve/15 border-accent-mauve/30 text-accent-mauve'
                            : 'bg-transparent border-border text-text-muted hover:bg-[var(--layer-hover)] hover:text-text-primary'
                        }`}
                      >
                        {m === 'normal' ? 'Normal' : 'Monitor'}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        {/* Right side: Open/Close button */}
        <div className="shrink-0">
          <button
            disabled={pending || (!isOpen && isMonitor && !monitorReady)}
            onClick={() => { setPending(true); void handleOpenClose().finally(() => setPending(false)); }}
            className={`btn-channel-action ${
              isOpen
                ? 'bg-accent-red hover:bg-accent-red/80 text-surface'
                : 'bg-accent-mauve hover:bg-accent-mauve/80 text-surface'
            }`}
          >
            {isMonitor ? (isOpen ? 'Stop' : 'Monitor') : (isOpen ? 'Close' : 'Open')}
          </button>
        </div>
      </div>

      {/* Content area — rounded bordered container */}
      <div className="channel-panel-card bg-surface border border-border rounded-lg flex min-h-0 flex-col overflow-y-auto scrollbar-stable">
        <div>
          <div className="channel-config-row">
            <label className={uartLabelClassName}>Port</label>
            <RoundedSelect
              value={isMonitor && !portPresent ? '' : selectedPort}
              onChange={(path) => setChannelConfig(channelId, { ...config, path, monitorManual: false, usbCapture: undefined })}
              disabled={isOpen || pending || visiblePorts.length === 0}
              className={uartFieldClassName}
              tone="mauve"
              placeholder=""
              options={visiblePorts.map(port => ({
                value: port.path,
                label: port.path,
                title: port.product ?? port.manufacturer ?? port.path
              }))}
            />
          </div>

          {isMonitor ? (
            <>
              {!isOpen && portPresent && !report && <p role="status" className="px-3 py-2 text-sm text-text-secondary">Checking USB capture for {selectedPort}…</p>}
              {([['bus', 'USBPcap bus'], ['address', 'USB address'], ['inEndpoint', 'IN endpoint'], ['outEndpoint', 'OUT endpoint']] as const).map(([key, label]) => (
                <div className="channel-config-row" key={key}>
                  <label className={uartLabelClassName} htmlFor={`${channelId}-${key}`}>{label}</label>
                  <input
                    id={`${channelId}-${key}`}
                    type="number"
                    disabled={isOpen || pending}
                    value={isManual && config.usbCapture?.[key] !== undefined ? config.usbCapture[key] : ''}
                    placeholder="Auto"
                    className={uartInputClassName}
                    onChange={e => {
                      const raw = e.target.value.trim();
                      if (raw === '') {
                        const nextCapture = { ...(config.usbCapture ?? baseCapture) };
                        delete (nextCapture as Record<string, unknown>)[key];
                        const remainingManual = (['bus', 'address', 'inEndpoint', 'outEndpoint', 'profile'] as const).some(
                          k => k !== key && config.usbCapture?.[k] !== undefined
                        );
                        setChannelConfig(channelId, {
                          monitorManual: remainingManual,
                          usbCapture: remainingManual ? nextCapture : undefined,
                        });
                      } else {
                        const num = Number(raw);
                        setChannelConfig(channelId, {
                          monitorManual: true,
                          usbCapture: { ...(config.usbCapture ?? baseCapture), [key]: num },
                        });
                      }
                    }}
                  />
                </div>
              ))}
              <div className="channel-config-row">
                <label className={uartLabelClassName}>USB payload</label>
                <RoundedSelect
                  value={isManual && config.usbCapture?.profile ? config.usbCapture.profile : ''}
                  placeholder="Auto"
                  disabled={isOpen || pending}
                  className={uartFieldClassName}
                  tone="mauve"
                  options={[
                    { value: '', label: 'Auto' },
                    { value: 'raw', label: 'Raw bulk' },
                    { value: 'serial', label: 'Serial passthrough' },
                    { value: 'ftdi', label: 'FTDI' },
                  ]}
                  onChange={value => {
                    if (!value || value === 'auto') {
                      const nextCapture = { ...(config.usbCapture ?? baseCapture) };
                      delete (nextCapture as Record<string, unknown>).profile;
                      const remainingManual = (['bus', 'address', 'inEndpoint', 'outEndpoint'] as const).some(
                        k => config.usbCapture?.[k] !== undefined
                      );
                      setChannelConfig(channelId, {
                        monitorManual: remainingManual,
                        usbCapture: remainingManual ? nextCapture : undefined,
                      });
                    } else {
                      setChannelConfig(channelId, {
                        monitorManual: true,
                        usbCapture: {
                          ...(config.usbCapture ?? baseCapture),
                          profile: value as 'raw' | 'serial' | 'ftdi',
                        },
                      });
                    }
                  }}
                />
              </div>
              {((isManual && config.usbCapture?.profile === 'ftdi') || (!isManual && baseCapture.profile === 'ftdi')) && (
                <div className="channel-config-row">
                  <label className={uartLabelClassName}>USB packet</label>
                  <RoundedSelect
                    value={isManual && config.usbCapture?.packetSize ? String(config.usbCapture.packetSize) : ''}
                    placeholder="Auto"
                    disabled={isOpen || pending}
                    className={uartFieldClassName}
                    tone="mauve"
                    options={[
                      { value: '', label: 'Auto' },
                      ...[8, 16, 32, 64, 512, 1024].map(n => ({ value: String(n), label: String(n) })),
                    ]}
                    onChange={value => {
                      if (!value) {
                        const nextCapture = { ...(config.usbCapture ?? baseCapture) };
                        delete (nextCapture as Record<string, unknown>).packetSize;
                        setChannelConfig(channelId, {
                          usbCapture: nextCapture,
                        });
                      } else {
                        setChannelConfig(channelId, {
                          monitorManual: true,
                          usbCapture: {
                            ...(config.usbCapture ?? baseCapture),
                            packetSize: Number(value),
                          },
                        });
                      }
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
});
