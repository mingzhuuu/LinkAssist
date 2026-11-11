import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsbPcapSettings } from '../components/layout/UsbPcapSettings';
import { useUIStore } from '../stores/uiStore';

const { invoke, open } = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('../components/display/canvasLifecycleRuntime', () => ({ runLinkedCanvasDeactivateHooks: vi.fn() }));

beforeEach(() => {
  invoke.mockReset().mockResolvedValue('C:\\USBPcap\\USBPcapCMD.exe');
  open.mockReset();
  useUIStore.setState({ usbpcapDirectory: '' });
});
afterEach(cleanup);

describe('USBPcap setup', () => {
  it('checks automatic discovery and reports errors with a retry', async () => {
    invoke.mockRejectedValueOnce('USBPcapCMD.exe not found');
    render(<UsbPcapSettings />);
    await screen.findByText('USBPcapCMD.exe not found');
    expect(screen.getByText('USBPcap installation guide')).toBeDefined();
    expect(screen.queryByText(/Folder containing USBPcapCMD/i)).toBeNull();
    expect(invoke).toHaveBeenCalledWith('check_usbpcap', { usbpcapDirectory: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Tool and capture interfaces detected: C:\\USBPcap\\USBPcapCMD.exe/);
    expect(screen.queryByText('USBPcap installation guide')).toBeNull();
  });

  it('does not report setup success when the executable exists but the driver is not loaded', async () => {
    invoke.mockRejectedValueOnce('Tool found: C:\\USBPcap\\USBPcapCMD.exe. Restart Windows to finish loading the USB filter driver.');
    render(<UsbPcapSettings />);
    await screen.findByText(/Restart Windows to finish loading/);
    expect(screen.queryByText(/Tool and capture interfaces detected:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/Tool and capture interfaces detected:/);
  });

  it('browses a directory, preserves it on cancel and resets to auto', async () => {
    open.mockResolvedValueOnce('D:\\Tools\\USBPcap').mockResolvedValueOnce(null);
    render(<UsbPcapSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(useUIStore.getState().usbpcapDirectory).toBe('D:\\Tools\\USBPcap'));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true, multiple: false }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('check_usbpcap', { usbpcapDirectory: 'D:\\Tools\\USBPcap' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Browse' }) as HTMLButtonElement).disabled).toBe(false));
    expect(useUIStore.getState().usbpcapDirectory).toBe('D:\\Tools\\USBPcap');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(useUIStore.getState().usbpcapDirectory).toBe('');
  });

  it('does not show an obsolete check after the directory changes', async () => {
    let resolveOld: (path: string) => void = () => {};
    invoke.mockReturnValueOnce(new Promise<string>(resolve => { resolveOld = resolve; }));
    render(<UsbPcapSettings />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('USBPcap installation directory'), { target: { value: 'D:\\USBPcap' } });
    await act(async () => resolveOld('obsolete.exe'));
    expect(screen.queryByText(/obsolete.exe/)).toBeNull();
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('check_usbpcap', { usbpcapDirectory: 'D:\\USBPcap' }));
  });

  it('opens the official guide and retains launch failures', async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === 'open_usbpcap_install_guide') throw new Error('Browser launch failed');
      throw new Error('USBPcapCMD.exe not found');
    });
    render(<UsbPcapSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open USBPcap website' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Browser launch failed');
  });
});
