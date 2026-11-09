import React, { useState } from 'react';
import type { RemoteChannel, RemoteWorkspaceSnapshot, SerialConfig } from '../../types';
import type { TcpChannelConfig } from '../../stores/tcpStore';
import { parseRemoteInput } from '../../lib/remoteValidation';

export type RemoteAction = (action: string, args?: Record<string, unknown>) => Promise<unknown>;

export const RemoteChannelPanel: React.FC<{ item: RemoteChannel; snapshot: RemoteWorkspaceSnapshot; act: RemoteAction }> = ({ item, snapshot, act }) => {
  const { channel } = item;
  const [editor, setEditor] = useState<RemoteChannel | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [characteristic, setCharacteristic] = useState('');
  const [clientId, setClientId] = useState('');
  const [target, setTarget] = useState(item.tcp.udpTargetAddress);
  const [input, setInput] = useState('');
  const [format, setFormat] = useState<'hex' | 'text'>('hex');
  const [error, setError] = useState('');
  const [readResult, setReadResult] = useState('');
  const busy = channel.state === 'connecting';
  const connected = channel.state === 'connected';
  const characteristics = item.ble?.gattServices.flatMap(service => service.characteristics.map(char => ({ ...char, serviceUuid: service.uuid }))) ?? [];
  const selected = characteristics.find(char => `${char.serviceUuid}/${char.uuid}` === characteristic);
  const bleTarget = { serviceUuid: selected?.serviceUuid, charUuid: selected?.uuid };
  const call = async (name: string, args: Record<string, unknown> = {}) => act(name, { channelId: channel.id, ...args });
  const send = async () => {
    setError('');
    try { await call('channel.send', { data: parseRemoteInput(input, format), ...bleTarget, clientId, target }); }
    catch (error) { setError(String(error)); }
  };
  return <section className="space-y-3 border-b border-border bg-surface p-3 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="min-w-0 flex-1 truncate">{channel.name}</strong><span className={connected ? 'text-accent-green' : 'text-text-secondary'}>{channel.state}</span>
      <button className="btn-channel-action px-3" disabled={busy} onClick={() => void call(connected ? 'channel.disconnect' : 'channel.connect', { revision: item.revision, deviceId: deviceId || undefined }).catch(() => {})}>{connected ? 'Disconnect' : 'Connect'}</button>
      {channel.type !== 'ble' && <button className="btn-channel-action px-3" disabled={connected || busy} onClick={() => setEditor(structuredClone(item))}>Configure</button>}
    </div>
    {channel.type === 'serial' && <p className="text-xs text-text-secondary">{item.serial.path || 'Select a serial port in Configure'} · {item.serial.baudRate} baud</p>}
    {channel.type === 'tcp' && <p className="text-xs text-text-secondary">{item.tcp.mode === 'client' ? `TCP → ${item.tcp.clientAddress}` : item.tcp.mode === 'server' ? `TCP listen ${item.tcp.serverAddress}` : `UDP ${item.tcp.udpBindAddress}`}</p>}
    {channel.type === 'ble' && <>
      <div className="flex gap-2"><select aria-label="Remote BLE device" className="input-base min-w-0 flex-1" value={deviceId} onChange={event => setDeviceId(event.target.value)} disabled={connected}>
        <option value="">Select device / reconnect remembered device</option>
        {(item.ble?.devices ?? []).map(device => <option key={device.id} value={device.id}>{device.name || device.id} ({device.rssi} dBm)</option>)}
      </select><button className="btn-channel-action px-3" onClick={() => void call(snapshot.scanning ? 'ble.stopScan' : 'ble.scan').catch(() => {})}>{snapshot.scanning ? 'Stop scan' : 'Scan'}</button></div>
      {connected && <div className="flex flex-wrap gap-2"><select aria-label="Remote BLE characteristic" className="input-base min-w-0 flex-1 font-mono text-xs" value={characteristic} onChange={event => setCharacteristic(event.target.value)}>
        <option value="">Select characteristic</option>{characteristics.map(char => <option key={`${char.serviceUuid}/${char.uuid}`} value={`${char.serviceUuid}/${char.uuid}`}>{char.uuid} · {char.properties.join(', ')}</option>)}
      </select>
        <button className="btn-channel-action px-2" disabled={!selected?.properties.includes('read')} onClick={() => void call('ble.read', bleTarget).then(value => setReadResult(JSON.stringify(value))).catch(() => {})}>Read</button>
        <button className="btn-channel-action px-2" disabled={!selected || !selected.properties.some(p => p === 'notify' || p === 'indicate')} onClick={() => void call('ble.subscribe', bleTarget).catch(() => {})}>Subscribe</button>
        <button className="btn-channel-action px-2" disabled={!selected} onClick={() => void call('ble.unsubscribe', bleTarget).catch(() => {})}>Unsubscribe</button>
      </div>}
      {readResult && <pre className="max-h-20 overflow-auto text-xs">{readResult}</pre>}
    </>}
    {channel.type === 'tcp' && item.tcp.mode === 'server' && <select aria-label="Remote TCP client" className="input-base w-full" value={clientId} onChange={event => setClientId(event.target.value)}><option value="">Select TCP client</option>{item.clients.map(client => <option value={client.id} key={client.id}>{client.addr}</option>)}</select>}
    {channel.type === 'tcp' && item.tcp.mode === 'udp' && <label className="flex items-center gap-2 text-xs">UDP target<input className="input-base flex-1" value={target} onChange={event => setTarget(event.target.value)} /></label>}
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void send(); }}>
      <select aria-label="Send format" className="input-base" value={format} onChange={event => setFormat(event.target.value as 'hex' | 'text')}><option value="hex">HEX</option><option value="text">Text</option></select>
      <input aria-label="Remote send data" className="input-base min-w-0 flex-1 font-mono" placeholder={format === 'hex' ? '01 A2 FF' : 'Text to send'} value={input} onChange={event => setInput(event.target.value)} />
      <button type="submit" className="btn-channel-action px-4" disabled={!connected || !input}>Send</button>
    </form>
    {error && <p role="alert" className="text-accent-red">{error}</p>}
    {editor && <ChannelEditor item={editor} ports={snapshot.ports} act={act} onClose={() => setEditor(null)} />}
  </section>;
};

const ChannelEditor: React.FC<{ item: RemoteChannel; ports: RemoteWorkspaceSnapshot['ports']; act: RemoteAction; onClose: () => void }> = ({ item, ports, act, onClose }) => {
  const [serial, setSerial] = useState(item.serial);
  const [tcp, setTcp] = useState(item.tcp);
  const [name, setName] = useState(item.channel.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const field = (label: string, key: keyof TcpChannelConfig) => <label className="flex items-center justify-between gap-3">{label}<input className="input-base w-64 max-w-[65%]" value={tcp[key]} onChange={event => setTcp({ ...tcp, [key]: event.target.value })} /></label>;
  const save = async () => {
    setSaving(true); setError('');
    try {
      await act('channel.configure', { channelId: item.channel.id, revision: item.revision, config: item.channel.type === 'serial' ? serial : tcp });
      onClose();
    } catch (error) { setError(String(error)); } finally { setSaving(false); }
  };
  return <div className="space-y-3 rounded-xl border border-border bg-surface-secondary p-3" role="region" aria-label="Remote channel configuration">
    <div className="flex items-center gap-2"><input aria-label="Channel name" className="input-base min-w-0 flex-1" value={name} onChange={event => setName(event.target.value)} /><button className="btn-channel-action px-2" disabled={saving || name === item.channel.name} onClick={() => void act('channel.rename', { channelId: item.channel.id, revision: item.revision, name }).then(onClose).catch(error => setError(String(error)))}>Rename</button></div>
    {item.channel.type === 'serial' ? <>
      <label className="flex items-center justify-between gap-2">Port<div className="flex gap-2"><input aria-label="Serial port path" list="remote-ports" className="input-base w-40" value={serial.path} onChange={event => setSerial({ ...serial, path: event.target.value })} /><datalist id="remote-ports">{ports.map(port => <option key={port.path} value={port.path}>{port.product}</option>)}</datalist><button className="btn-channel-action px-2" onClick={() => void act('serial.refresh').catch(() => {})}>Refresh</button></div></label>
      <label className="flex items-center justify-between">Baud rate<input type="number" min={1} className="input-base w-40" value={serial.baudRate} onChange={event => setSerial({ ...serial, baudRate: Number(event.target.value) })} /></label>
      <div className="flex flex-wrap gap-3">
        <label>Data bits<select className="input-base ml-2" value={serial.dataBits} onChange={event => setSerial({ ...serial, dataBits: Number(event.target.value) as SerialConfig['dataBits'] })}>{[5, 6, 7, 8].map(n => <option key={n}>{n}</option>)}</select></label>
        <label>Stop bits<select className="input-base ml-2" value={serial.stopBits} onChange={event => setSerial({ ...serial, stopBits: Number(event.target.value) as 1 | 2 })}><option>1</option><option>2</option></select></label>
        <label>Parity<select className="input-base ml-2" value={serial.parity} onChange={event => setSerial({ ...serial, parity: event.target.value as SerialConfig['parity'] })}>{['none', 'odd', 'even'].map(n => <option key={n}>{n}</option>)}</select></label>
        <label>Flow control<select className="input-base ml-2" value={serial.flowControl} onChange={event => setSerial({ ...serial, flowControl: event.target.value as SerialConfig['flowControl'] })}>{['none', 'rts_cts', 'dtr_dsr', 'xon_xoff'].map(n => <option key={n}>{n}</option>)}</select></label>
      </div>
    </> : <>
      <label className="flex items-center justify-between">Mode<select className="input-base w-64 max-w-[65%]" value={tcp.mode} onChange={event => setTcp({ ...tcp, mode: event.target.value as TcpChannelConfig['mode'] })}><option value="client">TCP client</option><option value="server">TCP server</option><option value="udp">UDP</option></select></label>
      {tcp.mode === 'client' ? field('Server address', 'clientAddress') : tcp.mode === 'server' ? field('Listen address', 'serverAddress') : <>{field('Bind address', 'udpBindAddress')}{field('Target address', 'udpTargetAddress')}</>}
    </>}
    {error && <p role="alert" className="text-accent-red">{error}</p>}
    <div className="flex gap-2"><button className="btn-channel-action px-3" disabled={saving} onClick={() => void save()}>Save on host</button><button className="btn-channel-action px-3" onClick={onClose}>Cancel</button><button className="btn-channel-action ml-auto px-3 text-accent-red" disabled={saving} onClick={() => void act('channel.remove', { channelId: item.channel.id, revision: item.revision }).then(onClose).catch(error => setError(String(error)))}>Remove channel</button></div>
  </div>;
};
