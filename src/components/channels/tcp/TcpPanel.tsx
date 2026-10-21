import React, { useState, useCallback, useEffect } from 'react';
import { useTcp } from '../../../hooks/useTcp';
import { useTcpStore, DEFAULT_TCP_CONFIG } from '../../../stores';
import { toast } from '../../../stores/toastStore';
import { WifiIcon } from '../../common/Icons';

export const TcpPanel = React.memo(function TcpPanel({ channelId }: { channelId: string }) {
  const { mode, setMode, connectTcp, disconnectTcp, startServer, stopServer, disconnectClient, serverClients, serverListening, bindUdp, unbindUdp, udpBound } = useTcp();
  const savedConfig = useTcpStore(s => s.channelConfigs[channelId]);
  const setChannelConfig = useTcpStore(s => s.setChannelConfig);
  
  const [address, setAddress] = useState(savedConfig?.clientAddress ?? DEFAULT_TCP_CONFIG.clientAddress);
  const [currentConnectionId, setCurrentConnectionId] = useState<string | null>(null);
  
  const [serverAddress, setServerAddress] = useState(savedConfig?.serverAddress ?? DEFAULT_TCP_CONFIG.serverAddress);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  
  const [udpBindAddress, setUdpBindAddress] = useState(savedConfig?.udpBindAddress ?? DEFAULT_TCP_CONFIG.udpBindAddress);

  // Initialize mode from saved config
  useEffect(() => {
    if (savedConfig?.mode && savedConfig.mode !== mode) {
      setMode(savedConfig.mode);
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync config changes back to store for persistence
  useEffect(() => {
    setChannelConfig(channelId, {
      mode,
      clientAddress: address,
      serverAddress,
      udpBindAddress,
    });
  }, [channelId, mode, address, serverAddress, udpBindAddress, setChannelConfig]);
  const tcpAddressRowClassName = "relative flex min-h-[40px] items-center justify-between gap-3 px-4 py-1.5 hover:bg-[var(--layer-hover)] transition-all duration-150 after:absolute after:bottom-0 after:left-2 after:right-2 after:border-b after:border-border after:content-[''] last:after:hidden";
  const tcpLabelClassName = 'channel-config-label w-[40px]';
  const tcpFieldClassName = 'channel-config-control w-[184px] min-w-[184px] max-w-none bg-surface border border-border rounded-lg px-3 py-1.5 font-mono text-[13px] text-text-primary outline-none focus:border-accent-green/40 disabled:opacity-50';

  const modeLabels: Record<'client' | 'server' | 'udp', string> = {
    client: 'Client',
    server: 'Server',
    udp: 'UDP'
  };

  const handleConnectClient = useCallback(async () => {
    if (currentConnectionId) {
      try {
        await disconnectTcp(currentConnectionId, channelId);
        setCurrentConnectionId(null);
        toast.info('Disconnected from server');
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      try {
        const id = await connectTcp(address, channelId);
        setCurrentConnectionId(id);
        toast.success('Connected to server');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [currentConnectionId, address, channelId, connectTcp, disconnectTcp]);

  const handleToggleServer = useCallback(async () => {
    if (serverListening) {
      try {
        await stopServer(channelId);
        setSelectedClient(null);
        toast.info('Server stopped');
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      try {
        await startServer(serverAddress, channelId);
        toast.success('Server started');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [serverListening, channelId, serverAddress, startServer, stopServer]);

  const handleToggleUdp = useCallback(async () => {
    if (udpBound) {
      try {
        await unbindUdp(channelId);
        toast.info('UDP unbound');
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      try {
        await bindUdp(udpBindAddress, channelId);
        toast.success('UDP bound');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [udpBound, channelId, udpBindAddress, bindUdp, unbindUdp]);

  // Determine if the current mode is "active" (connected/listening/bound)
  const isActive = (mode === 'client' && !!currentConnectionId)
    || (mode === 'server' && serverListening)
    || (mode === 'udp' && udpBound);

  // Action button label
  const actionLabel = mode === 'client'
    ? (currentConnectionId ? 'Disconnect' : 'Connect')
    : mode === 'server'
      ? (serverListening ? 'Stop' : 'Start')
      : (udpBound ? 'Unbind' : 'Bind');

  // Action button handler
  const handleAction = mode === 'client'
    ? handleConnectClient
    : mode === 'server'
      ? handleToggleServer
      : handleToggleUdp;

  // Status text for connected state
  const statusText = mode === 'client'
    ? address
    : mode === 'server'
      ? `${serverAddress} (${serverClients.length} client${serverClients.length !== 1 ? 's' : ''})`
      : udpBindAddress;

  return (
    <div className="flex w-full max-h-full flex-col items-stretch">
      {/* Top bar — OUTSIDE the bordered content area */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 mb-2 transition-all duration-300 min-h-[40px]">
        {/* Left side: mode selector + status info */}
        <div className="min-w-0 overflow-hidden">
          {isActive ? (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <WifiIcon className="w-5 h-5 shrink-0 text-accent-green" />
              <span className="shrink-0 text-text-primary font-medium text-lg">{modeLabels[mode]}</span>
              <span className="min-w-0 truncate text-text-muted font-mono text-sm ml-2">{statusText}</span>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              {(['client', 'server', 'udp'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`inline-flex h-6 min-w-[60px] shrink-0 items-center justify-center rounded-md px-2 text-[11px] font-semibold transition-all duration-150 border
                    ${mode === m
                      ? 'bg-accent-green/15 border-accent-green/30 text-accent-green'
                      : 'bg-[var(--layer-hover)] border-border text-text-muted hover:bg-[var(--layer-selected)] hover:text-text-primary'}`}
                >
                  {modeLabels[m]}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Right side: action button */}
        <div className="ml-4 shrink-0">
          <button
            onClick={handleAction}
            className={`btn-channel-action ${
              isActive
                ? 'bg-accent-red hover:bg-accent-red/80 text-surface'
                : 'bg-accent-green hover:bg-accent-green/80 text-surface'
            }`}
          >
            {actionLabel}
          </button>
        </div>
      </div>

      {/* Content area — rounded bordered container */}
      <div className="bg-surface border border-border rounded-lg flex min-h-0 flex-col overflow-y-auto scrollbar-stable">
        <div>
          {mode === 'client' && (
              <div className={tcpAddressRowClassName}>
                <label className={tcpLabelClassName}>Remote</label>
              <input 
                type="text" 
                value={address}
                onChange={e => setAddress(e.target.value)}
                disabled={!!currentConnectionId}
                placeholder="127.0.0.1:8080"
                className={tcpFieldClassName}
              />
            </div>
          )}

          {mode === 'server' && (
            <>
              <div className={tcpAddressRowClassName}>
                <label className={tcpLabelClassName}>Listen</label>
                <input 
                  type="text" 
                  value={serverAddress}
                  onChange={e => setServerAddress(e.target.value)}
                  disabled={serverListening}
                  placeholder="0.0.0.0:8080"
                  className={tcpFieldClassName}
                />
              </div>

              {serverListening && (
                <div>
                  <div className="channel-config-row">
                    <span className="channel-config-label">Connected Clients</span>
                    <span className="text-[10px] text-text-faint font-mono uppercase">
                      {serverClients.length} active
                    </span>
                  </div>
                  <div>
                    {serverClients.length === 0 && (
                      <div className="relative min-h-[40px] flex items-center px-4 py-1.5 text-text-muted text-sm italic after:absolute after:bottom-0 after:left-2 after:right-2 after:border-b after:border-border after:content-['']">
                        No clients connected
                      </div>
                    )}
                    {serverClients.map(client => (
                      <div 
                        key={client.id}
                        onClick={() => setSelectedClient(client.id)}
                        className={`relative flex min-h-[40px] items-center justify-between gap-3 px-4 py-1.5 cursor-pointer transition-all duration-150 after:absolute after:bottom-0 after:left-2 after:right-2 after:border-b after:border-border after:content-[''] last:after:hidden
                          ${selectedClient === client.id
                            ? 'bg-accent-green/15'
                            : 'hover:bg-[var(--layer-hover)]'}`}
                      >
                        <span className="text-sm text-text-primary font-mono truncate">{client.addr}</span>
                        <button 
                          onClick={e => { e.stopPropagation(); disconnectClient(client.id); }}
                          className="bg-[var(--layer-hover)] hover:bg-[var(--layer-active)] text-accent-red px-2 py-0.5 rounded-md text-xs transition-all duration-150"
                        >
                          Kick
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {mode === 'udp' && (
            <>
              <div className={tcpAddressRowClassName}>
                <label className={tcpLabelClassName}>Bind</label>
                <input 
                  type="text" 
                  value={udpBindAddress}
                  onChange={e => setUdpBindAddress(e.target.value)}
                  disabled={udpBound}
                  placeholder="0.0.0.0:8080"
                  className={tcpFieldClassName}
                />
              </div>

              {udpBound && (
                <div className="channel-config-row">
                  <span className="channel-config-label">Hint</span>
                  <span className="channel-config-control flex items-center justify-end text-sm text-text-muted italic">
                    Use <span className="text-accent-green font-mono ml-1">/udptarget &lt;addr&gt;</span>
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
});
