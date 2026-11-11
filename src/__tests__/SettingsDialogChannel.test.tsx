import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../components/layout/SettingsDialog';
import { UartPanel } from '../components/channels/uart/UartPanel';
import { useUIStore } from '../stores/uiStore';
import { useSerialStore, DEFAULT_SERIAL_CONFIG } from '../stores/serialStore';
import { useChannelStore } from '../stores/channelStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const api = vi.hoisted(() => ({
  inspectMonitor: vi.fn().mockResolvedValue({ status: 'ready', message: 'COM1 identified', capture: null }),
  refreshPorts: vi.fn(),
  openPort: vi.fn(),
  closePort: vi.fn(),
  setActiveConfig: vi.fn(),
  checkUsbpcap: vi.fn().mockResolvedValue('C:\\USBPcap\\USBPcapCMD.exe'),
  openUsbpcapGuide: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../hooks', () => ({
  useSerial: () => ({ ...api, ports: [{ path: 'COM1' }] }),
  useBle: () => ({ scanning: false, devices: [], startScan: vi.fn(), stopScan: vi.fn(), connectDevice: vi.fn(), disconnectDevice: vi.fn() }),
  useTcp: () => ({
    connectTcp: vi.fn(),
    disconnectTcp: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    disconnectClient: vi.fn(),
    bindUdp: vi.fn(),
    unbindUdp: vi.fn(),
  }),
}));

vi.mock('../components/common/RoundedSelect', () => ({
  RoundedSelect: ({ value, options, onChange, disabled, placeholder }: {
    value: string;
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
  }) => (
    <select
      value={value}
      disabled={disabled}
      data-placeholder={placeholder}
      onChange={event => onChange(event.target.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

describe('SettingsDialog Channel section and UartPanel mode selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ showSerialMode: false });
    useSerialStore.setState({
      channelConfigs: {
        ch1: { ...DEFAULT_SERIAL_CONFIG, path: 'COM1', monitor: false },
      },
      connectionMap: {},
    });
    useChannelStore.setState({
      channels: [{ id: 'ch1', name: 'Serial 1', type: 'serial', state: 'disconnected', createdAt: 0 }],
      activeChannelId: 'ch1',
    });
  });

  afterEach(cleanup);

  it('renders Channel settings with the mode selection switch and updates showSerialMode', async () => {
    api.checkUsbpcap.mockRejectedValueOnce('USBPcapCMD.exe not found');
    render(<SettingsDialog open={true} onClose={vi.fn()} />);

    // Click on Channel in sidebar
    fireEvent.click(screen.getByRole('button', { name: /Channel/i }));

    const toggle = screen.getByRole('switch', { name: /Supports monitor mode/i });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByLabelText('USBPcap installation directory')).toBeNull();
    expect(screen.queryByText('USBPcap installation guide')).toBeNull();

    // Click toggle to enable
    fireEvent.click(toggle);
    expect(useUIStore.getState().showSerialMode).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('USBPcap installation directory')).toBeDefined();
    expect(await screen.findByText('USBPcap installation guide')).toBeDefined();
    fireEvent.change(screen.getByLabelText('USBPcap installation directory'), { target: { value: 'D:\\USBPcap' } });

    // Click toggle to disable
    fireEvent.click(toggle);
    expect(useUIStore.getState().showSerialMode).toBe(false);
    expect(screen.queryByLabelText('USBPcap installation directory')).toBeNull();
    expect(useUIStore.getState().usbpcapDirectory).toBe('D:\\USBPcap');
  });

  it('renders mode buttons only when showSerialMode is true', async () => {
    const { rerender } = render(<UartPanel channelId="ch1" />);

    // Initially showSerialMode is false: mode buttons are hidden
    expect(screen.queryByRole('button', { name: 'Normal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Monitor' })).toBeNull();
    expect(screen.queryByText(/port.*available/i)).toBeNull();

    // Enable showSerialMode
    act(() => {
      useUIStore.setState({ showSerialMode: true });
    });
    rerender(<UartPanel channelId="ch1" />);

    // Mode buttons are now present
    const normalBtn = screen.getByRole('button', { name: 'Normal' });
    const monitorBtn = screen.getByRole('button', { name: 'Monitor' });
    expect(normalBtn).toBeDefined();
    expect(monitorBtn).toBeDefined();

    // Ensure "(read-only)" or "(rea...)" text is not present
    expect(screen.queryByText(/read-only/i)).toBeNull();
    expect(screen.queryByText(/port.*available/i)).toBeNull();

    // Switch to Monitor mode
    await act(async () => {
      fireEvent.click(monitorBtn);
    });
    expect(useSerialStore.getState().channelConfigs.ch1.monitor).toBe(true);

    // Advanced USB settings summary/details and verbose hints should not be displayed
    expect(document.querySelector('details')).toBeNull();
    expect(screen.queryByText(/Advanced USB settings/i)).toBeNull();
    expect(screen.queryByText(/Configure USB settings manually/i)).toBeNull();
    expect(screen.queryByText(/USB settings are detected automatically by default/i)).toBeNull();
    expect(screen.queryByText(/Endpoint values are decimal/i)).toBeNull();
    expect(screen.queryByText(/Retry detection/i)).toBeNull();

    // USB address and other fields default to placeholder Auto
    const addressInput = screen.getByLabelText('USB address') as HTMLInputElement;
    expect(addressInput.value).toBe('');
    expect(addressInput.placeholder).toBe('Auto');
    expect(addressInput.disabled).toBe(false);
  });
});
