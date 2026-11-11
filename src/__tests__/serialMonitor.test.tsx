import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSerial } from '../hooks/useSerial';
import { normalizeSerialConfig, useSerialStore } from '../stores/serialStore';
import { prepareTerminalNetworkSend } from '../lib/terminalSend';
import { useTerminalStore } from '../stores/terminalStore';
import { useUIStore } from '../stores/uiStore';
import { useChannelStore } from '../stores/channelStore';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../components/display/canvasLifecycleRuntime', () => ({ runLinkedCanvasDeactivateHooks: vi.fn() }));

describe('serial monitor isolation', () => {
  it('returns a canceled UAC request to disconnected without registering a monitor', async () => {
    useChannelStore.setState({ channels: [{ id: 'channel', name: 'Test', type: 'serial', state: 'disconnected', createdAt: 0 }] });
    invoke.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useSerial());
    await act(async () => {
      expect(await result.current.openPort(normalizeSerialConfig({ path: 'COM4', monitor: true }), 'channel', true)).toBeNull();
    });
    expect(invoke).toHaveBeenCalledWith('start_serial_monitor', expect.objectContaining({ requestElevation: true }));
    expect(useChannelStore.getState().channels[0].state).toBe('disconnected');
    expect(useSerialStore.getState().connectionMap).toEqual({});
  });
  beforeEach(() => { invoke.mockReset(); useUIStore.setState({ usbpcapDirectory: '' }); useSerialStore.setState({ openConnections: [], connectionMap: {} }); });
  it('restores old settings as normal and preserves explicit monitor settings', () => {
    expect(normalizeSerialConfig({ path: 'COM3' }).monitor).toBe(false);
    expect(normalizeSerialConfig({ path: 'COM3', monitor: true }).monitor).toBe(true);
    expect(normalizeSerialConfig({ monitor: 'true' }).monitor).toBe(false);
    expect(normalizeSerialConfig({monitor: true}).usbCapture?.address).toBe(0);
    expect(normalizeSerialConfig({usbCapture: {bus:2,address:5,inEndpoint:131,outEndpoint:4,profile:'ftdi',packetSize:512}}).usbCapture)
      .toEqual({bus:2,address:5,inEndpoint:131,outEndpoint:4,profile:'ftdi',packetSize:512});
  });
  it('starts and stops subscriptions without opening or closing the physical port', async () => {
    invoke.mockResolvedValue('monitor:test');
    const { result } = renderHook(() => useSerial());
    await act(async () => { await result.current.openPort(normalizeSerialConfig({ path: 'COM3', monitor: true }), 'channel'); });
    expect(invoke).toHaveBeenCalledWith('start_serial_monitor', { path: 'COM3', channelId: 'channel', capture: normalizeSerialConfig({}).usbCapture, manual: false, usbpcapDirectory: '' });
    expect(useSerialStore.getState().connectionMap['monitor:test']).toBe('channel');
    await act(async () => { await result.current.closePort('monitor:test', 'channel'); });
    expect(invoke).toHaveBeenCalledWith('stop_serial_monitor', { connectionId: 'monitor:test' });
    expect(invoke.mock.calls.some(([command]) => command === 'open_serial_port' || command === 'close_serial_port')).toBe(false);
  });
  it('requires an explicit manual override and exposes discovery', async () => {
    expect(normalizeSerialConfig({ monitor: true, monitorManual: 'true' }).monitorManual).toBe(false);
    invoke.mockResolvedValueOnce({ status: 'unsupported', message: 'Not USB', capture: null });
    const { result } = renderHook(() => useSerial());
    expect(await result.current.inspectMonitor('COM1')).toEqual({ status: 'unsupported', message: 'Not USB', capture: null });
    expect(invoke).toHaveBeenCalledWith('inspect_serial_monitor', { path: 'COM1', usbpcapDirectory: '' });
    invoke.mockResolvedValue('monitor:manual');
    await act(async () => { await result.current.openPort(normalizeSerialConfig({ path: 'COM3', monitor: true, monitorManual: true }), 'channel'); });
    expect(invoke).toHaveBeenCalledWith('start_serial_monitor', expect.objectContaining({ manual: true }));
  });
  it('blocks sending through a monitor connection before invoking the backend', () => {
    useSerialStore.setState({ connectionMap: { 'monitor:test': 'channel' } });
    const state = useTerminalStore.getState();
    const pane = Object.values(state.panes)[0];
    expect(pane).toBeDefined();
    if (!pane) throw new Error('Missing initial pane');
    expect(() => prepareTerminalNetworkSend({ id: 'channel', name: 'Monitor', type: 'serial', state: 'connected', createdAt: 0 }, pane, [1], () => {})).toThrow('read-only');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('uses the latest installation directory for checking, discovery and capture', async () => {
    const { result } = renderHook(() => useSerial());
    act(() => useUIStore.getState().setUsbpcapDirectory('D:\\USBPcap'));
    invoke.mockResolvedValue('monitor:test');
    await result.current.checkUsbpcap();
    await result.current.inspectMonitor('COM3');
    await act(async () => { await result.current.openPort(normalizeSerialConfig({ path: 'COM3', monitor: true }), 'channel'); });
    for (const command of ['check_usbpcap', 'inspect_serial_monitor', 'start_serial_monitor']) {
      expect(invoke).toHaveBeenCalledWith(command, expect.objectContaining({ usbpcapDirectory: 'D:\\USBPcap' }));
    }
    await result.current.openUsbpcapGuide();
    expect(invoke).toHaveBeenCalledWith('open_usbpcap_install_guide');
  });
});

