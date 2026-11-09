import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CloseRequestedEvent } from '@tauri-apps/api/window';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePersistence } from '../hooks/usePersistence';
import { useBleStore, useUIStore, useRemoteStore } from '../stores';
import { useCloseStore } from '../stores/closeStore';

type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;
const { appWindowMock, handler, invokeMock, unlisten } = vi.hoisted(() => ({
  appWindowMock: { onCloseRequested: vi.fn(), innerSize: vi.fn(), isMaximized: vi.fn(), outerPosition: vi.fn() },
  handler: { current: null as CloseHandler | null }, invokeMock: vi.fn(), unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => appWindowMock,
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
  PhysicalSize: class { constructor(public width: number, public height: number) {} },
}));
let enabled = false;
let config: Record<string, unknown>;
let save: () => Promise<void>;
async function mount(preference: 'exit' | 'background' | null = null) {
  config = { ...config, ui: { left_panel_width: 40, right_panel_width: 360, center_split_ratio: 0.5, data_view_mode: 'text', theme_mode: 'light', close_behavior: preference } };
  const hook = renderHook(() => usePersistence());
  await waitFor(() => expect(hook.result.current).toBe(true));
  await waitFor(() => expect(handler.current).not.toBeNull());
  return hook;
}
function close() {
  const preventDefault = vi.fn();
  const done = Promise.resolve(handler.current!({ preventDefault } as unknown as CloseRequestedEvent));
  return { done, preventDefault };
}
async function answer(choice: 'exit' | 'background' | 'cancel', always = false) {
  await waitFor(() => expect(useCloseStore.getState().reason).not.toBeNull());
  act(() => useCloseStore.getState().resolve?.(choice, always));
}
const saves = () => invokeMock.mock.calls.filter(([name]) => name === 'save_app_config');
beforeEach(() => {
  vi.clearAllMocks(); handler.current = null; enabled = false;
  useCloseStore.setState({ reason: null, resolve: null });
  useRemoteStore.setState({ active: false, connected: false });
  useUIStore.setState({ closeBehavior: null });
  config = { channels: [], protocol: { mode: 'Passthrough', field_definitions: [], lua_script: '', linked_channel_id: null, linked_service_uuid: null, linked_char_uuid: null } };
  save = async () => {};
  appWindowMock.innerSize.mockResolvedValue({ width: 1400, height: 900 });
  appWindowMock.outerPosition.mockResolvedValue({ x: 20, y: 30 });
  appWindowMock.isMaximized.mockResolvedValue(false);
  appWindowMock.onCloseRequested.mockImplementation((callback: CloseHandler) => { handler.current = callback; return Promise.resolve(unlisten); });
  invokeMock.mockImplementation(async (command: string) => {
    if (command === 'load_app_config') return config;
    if (command === 'remote_status') return { enabled };
    if (command === 'save_app_config') return save();
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('main-window close decisions', () => {
  it('asks once, remembers background, and saves before hiding', async () => {
    await mount(); const first = close();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    await answer('background', true); await first.done;
    expect(useUIStore.getState().closeBehavior).toBe('background');
    expect(invokeMock).toHaveBeenCalledWith('close_main_window', { background: true });
    expect(saves()[0][1].config.ui.close_behavior).toBe('background');
    await close().done;
    expect(useCloseStore.getState().reason).toBeNull();
  });
  it('asks again when Always is unchecked', async () => {
    await mount(); const first = close(); await answer('background'); await first.done;
    expect(useUIStore.getState().closeBehavior).toBeNull();
    const second = close(); await answer('cancel'); await second.done;
    expect(invokeMock.mock.calls.filter(([name]) => name === 'close_main_window')).toHaveLength(1);
  });
  it('honors a remembered exit even with remote access enabled', async () => {
    await mount(); enabled = true;
    const first = close(); await answer('exit', true); await first.done;
    expect(saves()[0][1].config.ui.close_behavior).toBe('exit');
    await close().done;
    expect(useCloseStore.getState().reason).toBeNull();
    expect(invokeMock.mock.calls.filter(([name]) => name === 'close_main_window')).toHaveLength(2);
  });
  it('cancels first close without saving or closing', async () => {
    await mount(); const pending = close(); await answer('cancel'); await pending.done;
    expect(useUIStore.getState().closeBehavior).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('close_main_window', expect.anything());
    expect(saves()).toHaveLength(0);
  });
  it('exits directly when the saved preference is exit and remote access is off', async () => {
    await mount('exit'); await close().done;
    expect(invokeMock).toHaveBeenCalledWith('close_main_window', { background: false });
    expect(appWindowMock.outerPosition).not.toHaveBeenCalled();
    expect(appWindowMock.innerSize).not.toHaveBeenCalled();
  });
  it('asks with remote enabled and does not remember an unchecked choice', async () => {
    await mount(); enabled = true; const pending = close();
    await waitFor(() => expect(useCloseStore.getState().reason).toBe('remote'));
    await answer('background'); await pending.done;
    expect(useUIStore.getState().closeBehavior).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith('close_main_window', { background: true });
  });
  it('allows explicit exit even when remote access is enabled', async () => {
    await mount(); enabled = true; const pending = close(); await answer('exit'); await pending.done;
    expect(invokeMock).toHaveBeenCalledWith('close_main_window', { background: false });
  });
  it('coalesces repeated close requests while the dialog is pending', async () => {
    await mount(); const first = close(), second = close(); await answer('exit');
    await Promise.all([first.done, second.done]);
    expect(saves()).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([name]) => name === 'close_main_window')).toHaveLength(1);
  });
  it('keeps the window visible if saving fails and permits a later retry', async () => {
    await mount('exit'); save = () => Promise.reject(new Error('disk failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await close().done;
    expect(invokeMock).not.toHaveBeenCalledWith('close_main_window', expect.anything());
    save = async () => {}; await close().done;
    expect(invokeMock).toHaveBeenCalledWith('close_main_window', { background: false });
  });
  it('does not save remote workspace stores over the local configuration', async () => {
    await mount('background'); useRemoteStore.setState({ active: true });
    useBleStore.getState().setCustomUuidName('service', '180d', 'Remote name');
    await close().done;
    expect(saves()[0][1].config).toMatchObject({ channels: [], ui: { close_behavior: 'background' } });
    expect(saves()[0][1].config.ble_uuid_names).toBeUndefined();
  });
  it('restores normalized BLE names and retains them in local saves', async () => {
    config.ble_uuid_names = { services: { ' ABCD ': ' Private Service ', ignored: 42 }, characteristics: { EF01: 'Private Characteristic' } };
    await mount('exit');
    expect(useBleStore.getState().customUuidNames.services).toEqual({ abcd: 'Private Service' });
    useBleStore.getState().setCustomUuidName('characteristic', 'EF02', 'Control Point'); await close().done;
    expect(saves()[0][1].config.ble_uuid_names.characteristics.ef02).toBe('Control Point');
  });
  it('cancels debounced saves and removes its listener on unmount', async () => {
    const hook = await mount(); vi.useFakeTimers();
    useBleStore.getState().setCustomUuidName('service', '180d', 'Heart'); hook.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves()).toHaveLength(0); expect(unlisten).toHaveBeenCalledOnce();
  });
});
