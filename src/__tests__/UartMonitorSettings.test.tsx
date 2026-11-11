import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UartPanel } from '../components/channels/uart/UartPanel';
import { useSerialStore, DEFAULT_SERIAL_CONFIG } from '../stores/serialStore';
import { useChannelStore } from '../stores/channelStore';
import { useUIStore } from '../stores/uiStore';
import type { MonitorDiscovery } from '../types';

const api = vi.hoisted(() => ({ inspectMonitor: vi.fn(), refreshPorts: vi.fn(), openPort: vi.fn(), closePort: vi.fn(), setActiveConfig: vi.fn() }));
vi.mock('../hooks', () => ({ useSerial: () => ({ ...api, ports: [
  { path: 'COM3', portType: 'USB' },
  { path: 'COM4', portType: 'USB' },
  { path: 'COM6', portType: 'Unknown' },
] }) }));
vi.mock('../components/common/RoundedSelect', () => ({ RoundedSelect: ({ value, options, onChange, disabled }: {
  value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean;
}) => <select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }));

const ready: MonitorDiscovery = { status: 'ready', message: 'COM3 identified', capture: { bus: 2, address: 5, inEndpoint: 131, outEndpoint: 4, profile: 'ftdi', packetSize: 512 } };
const actionButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('.btn-channel-action')!;
beforeEach(() => {
  vi.clearAllMocks();
  useUIStore.setState({ showSerialMode: true });
  useSerialStore.setState({ channelConfigs: { test: { ...DEFAULT_SERIAL_CONFIG, path: 'COM3', monitor: true } }, connectionMap: {} });
  useChannelStore.setState({ channels: [{ id: 'test', name: 'Test', type: 'serial', state: 'disconnected', createdAt: 0 }] });
  api.inspectMonitor.mockResolvedValue(ready);
  api.openPort.mockResolvedValue('monitor:test');
});
afterEach(cleanup);

describe('automatic USB monitor settings', () => {
  it('automatically filters unsupported ports in Monitor and keeps the saved Normal port until the user picks a USB port', async () => {
    useSerialStore.getState().setChannelConfig('test', { path: 'COM6' });
    const { container } = render(<UartPanel channelId="test" />);
    expect(screen.queryByRole('option', { name: 'COM6' })).toBeNull();
    expect(screen.getByRole('option', { name: 'COM4' })).toBeDefined();
    expect(actionButton(container).disabled).toBe(true);
    expect(api.inspectMonitor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }));
    expect(screen.getByDisplayValue('COM6')).toBeDefined();
    expect(actionButton(container).textContent).toBe('Open');
  });
  it('keeps an active monitor stoppable when mode selection is turned off', async () => {
    useSerialStore.setState({ connectionMap: { 'monitor:test': 'test' } });
    useChannelStore.getState().updateChannelState('test', 'connected');
    const { container } = render(<UartPanel channelId="test" />);
    act(() => useUIStore.getState().setShowSerialMode(false));
    expect(actionButton(container).textContent).toBe('Stop');
    fireEvent.click(actionButton(container));
    await waitFor(() => expect(api.closePort).toHaveBeenCalledWith('monitor:test', 'test'));
    expect(api.openPort).not.toHaveBeenCalled();
  });
  it('detects the selected COM port, hides verbose status/guidance, and defaults technical inputs to auto', async () => {
    const { container } = render(<UartPanel channelId="test" />);
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM3'));
    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByText('COM3 identified')).toBeNull();
    expect(screen.queryByText(/Retry detection/i)).toBeNull();
    expect(screen.queryByText(/Advanced USB settings/i)).toBeNull();
    expect(screen.queryByText(/USB settings are detected automatically by default/i)).toBeNull();
    expect(screen.queryByText(/Endpoint values are decimal/i)).toBeNull();
    expect(screen.queryByLabelText('Configure USB settings manually')).toBeNull();
    const addressInput = screen.getByLabelText('USB address') as HTMLInputElement;
    expect(addressInput.value).toBe('');
    expect(addressInput.placeholder).toBe('Auto');
    expect(addressInput.disabled).toBe(false);
    expect(actionButton(container).textContent).toBe('Monitor');
    fireEvent.click(actionButton(container));
    await waitFor(() => expect(api.openPort).toHaveBeenCalled());
    expect(api.openPort.mock.calls[0][0].monitorManual).not.toBe(true);
  });
  it('prevents manual parameters from enabling monitor mode when discovery fails without rendering red warning text', async () => {
    api.inspectMonitor.mockResolvedValue({ status: 'unsupported', message: 'Onboard UART cannot use USBPcap', capture: null });
    const { container } = render(<UartPanel channelId="test" />);
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM3'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(screen.getByLabelText('USB address'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('USBPcap bus'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('IN endpoint'), { target: { value: '129' } });
    fireEvent.change(screen.getByLabelText('OUT endpoint'), { target: { value: '2' } });
    expect(actionButton(container).disabled).toBe(true);
    fireEvent.click(actionButton(container));
    expect(api.openPort).not.toHaveBeenCalled();
    expect(screen.queryByText('Install / repair USBPcap')).toBeNull();
  });
  it('requests capture permission only from Monitor and leaves the button available after cancellation', async () => {
    api.inspectMonitor.mockResolvedValue({ status: 'access_denied', message: 'Access denied', capture: null });
    api.openPort.mockResolvedValueOnce(null);
    const { container } = render(<UartPanel channelId="test" />);
    const button = actionButton(container);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Retry detection')).toBeNull();
    expect(api.openPort).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(button));
    expect(api.openPort).toHaveBeenCalledWith(expect.objectContaining({ monitor: true }), 'test', true);
    expect(api.setActiveConfig).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
  });
  it('shows missing tool errors while keeping installation controls in settings', async () => {
    api.inspectMonitor.mockResolvedValueOnce({ status: 'missing_tool', message: 'USBPcapCMD missing', capture: null });
    const { container } = render(<UartPanel channelId="test" />);
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM3'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(actionButton(container).disabled).toBe(true);
    expect(screen.queryByText('Install / repair USBPcap')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry detection' })).toBeNull();
  });
  it('ignores stale discovery after changing ports and resets manual override', async () => {
    let resolveOld: (value: MonitorDiscovery) => void = () => {};
    api.inspectMonitor.mockReturnValueOnce(new Promise<MonitorDiscovery>(resolve => { resolveOld = resolve; }));
    api.inspectMonitor.mockResolvedValueOnce({ ...ready, message: 'COM4 identified', capture: { ...ready.capture!, address: 7 } });
    render(<UartPanel channelId="test" />);
    fireEvent.change(screen.getByLabelText('USB address'), { target: { value: '7' } });
    fireEvent.change(screen.getByDisplayValue('COM3'), { target: { value: 'COM4' } });
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM4'));
    await act(async () => resolveOld(ready));
    expect((screen.getByLabelText('USB address') as HTMLInputElement).value).toBe('');
    expect(useSerialStore.getState().channelConfigs.test.monitorManual).toBe(false);
  });
  it('seeds explicit manual settings and delegates start errors without rendering red warning text', async () => {
    api.openPort.mockImplementationOnce(async () => {
      useChannelStore.getState().updateChannelState('test', 'connecting');
      await new Promise(resolve => setTimeout(resolve, 0));
      useChannelStore.getState().updateChannelState('test', 'error');
      throw new Error('Device disconnected during discovery');
    });
    const { container } = render(<UartPanel channelId="test" />);
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM3'));
    fireEvent.change(screen.getByLabelText('USB address'), { target: { value: '5' } });
    expect(useSerialStore.getState().channelConfigs.test.monitorManual).toBe(true);
    expect(useSerialStore.getState().channelConfigs.test.usbCapture?.address).toBe(5);
    fireEvent.click(actionButton(container));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('hides mode selection by default and displays it when showSerialMode is enabled', async () => {
    useUIStore.setState({ showSerialMode: false });
    useSerialStore.setState({ channelConfigs: { test: { ...DEFAULT_SERIAL_CONFIG, path: 'COM3' } } });
    const { rerender } = render(<UartPanel channelId="test" />);
    expect(screen.queryByText('Normal')).toBeNull();
    expect(screen.queryByText('Monitor')).toBeNull();
    expect(screen.queryByText(/port.*available/i)).toBeNull();

    act(() => {
      useUIStore.setState({ showSerialMode: true });
    });
    rerender(<UartPanel channelId="test" />);
    expect(screen.getByText('Normal')).toBeDefined();
    expect(screen.getByText('Monitor')).toBeDefined();
    expect(screen.queryByText(/port.*available/i)).toBeNull();
  });
  it('omits standard serial rows in monitor mode so the last monitor row is the terminal element without an overlapping divider', async () => {
    // When profile is FTDI, USB packet is the last element
    useUIStore.setState({ showSerialMode: true });
    useSerialStore.setState({ channelConfigs: { test: { ...DEFAULT_SERIAL_CONFIG, path: 'COM3', monitor: true } } });
    const { container, rerender } = render(<UartPanel channelId="test" />);
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM3'));

    expect(screen.queryByText('Baud Rate')).toBeNull();
    const rowsContainer = container.querySelector('.channel-panel-card > div');
    expect(rowsContainer).not.toBeNull();
    expect(rowsContainer?.lastElementChild?.textContent).toContain('USB packet');
    expect(rowsContainer?.lastElementChild?.classList.contains('channel-config-row')).toBe(true);

    // When profile is not FTDI (e.g. raw bulk / serial), USB payload is the last element
    api.inspectMonitor.mockResolvedValueOnce({
      status: 'ready',
      message: 'COM4 identified',
      capture: { bus: 2, address: 5, inEndpoint: 131, outEndpoint: 4, profile: 'raw', packetSize: 64 },
    });
    await act(async () => {
      useSerialStore.setState({
        channelConfigs: {
          test: {
            ...DEFAULT_SERIAL_CONFIG,
            path: 'COM4',
            monitor: true,
            usbCapture: { bus: 2, address: 5, inEndpoint: 131, outEndpoint: 4, profile: 'raw', packetSize: 64 },
          },
        },
      });
      rerender(<UartPanel channelId="test" />);
    });
    await waitFor(() => expect(api.inspectMonitor).toHaveBeenCalledWith('COM4'));

    expect(rowsContainer?.lastElementChild?.textContent).toContain('USB payload');
    expect(rowsContainer?.lastElementChild?.classList.contains('channel-config-row')).toBe(true);
  });
});
