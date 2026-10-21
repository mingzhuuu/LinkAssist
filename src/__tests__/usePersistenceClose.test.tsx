import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CloseRequestedEvent } from '@tauri-apps/api/window';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePersistence } from '../hooks/usePersistence';
import { useBleStore } from '../stores';

type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;
type LaunchMode = 'ui' | 'headless';

const {
  appWindowMock,
  closeHandlerRef,
  getCurrentWindowMock,
  invokeMock,
  unlistenMock,
} = vi.hoisted(() => ({
  appWindowMock: {
    destroy: vi.fn(),
    hide: vi.fn(),
    innerSize: vi.fn(),
    isMaximized: vi.fn(),
    onCloseRequested: vi.fn(),
    outerPosition: vi.fn(),
  },
  closeHandlerRef: { current: null as CloseHandler | null },
  getCurrentWindowMock: vi.fn(),
  invokeMock: vi.fn(),
  unlistenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: getCurrentWindowMock,
  PhysicalPosition: class PhysicalPosition {
    constructor(public x: number, public y: number) {}
  },
  PhysicalSize: class PhysicalSize {
    constructor(public width: number, public height: number) {}
  },
}));

const defaultConfig = {
  channels: [],
  ui: {
    left_panel_width: 48,
    right_panel_width: 360,
    center_split_ratio: 0.5,
    data_view_mode: 'text',
    theme_mode: 'dark',
  },
  protocol: {
    mode: 'Passthrough',
    field_definitions: [],
    lua_script: '',
    linked_channel_id: null,
    linked_service_uuid: null,
    linked_char_uuid: null,
  },
};

type LoadedConfig = typeof defaultConfig & {
  ble_uuid_names?: {
    services: Record<string, unknown>;
    characteristics: Record<string, unknown>;
  };
};

let saveOperation: () => Promise<void>;
let modeOperation: () => Promise<LaunchMode>;
let loadedConfig: LoadedConfig;

async function mountPersistence() {
  const hook = renderHook(() => usePersistence());
  await waitFor(() => expect(hook.result.current).toBe(true));
  await waitFor(() => expect(closeHandlerRef.current).not.toBeNull());
  return hook;
}

function triggerClose() {
  const handler = closeHandlerRef.current;
  if (!handler) throw new Error('Close handler was not registered');

  const preventDefault = vi.fn();
  const event = { preventDefault } as unknown as CloseRequestedEvent;
  const completion = Promise.resolve(handler(event));
  return { completion, preventDefault };
}

function saveInvokeCount() {
  return invokeMock.mock.calls.filter(([command]) => command === 'save_app_config').length;
}

describe('usePersistence close handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closeHandlerRef.current = null;
    getCurrentWindowMock.mockReturnValue(appWindowMock);
    appWindowMock.destroy.mockResolvedValue(undefined);
    appWindowMock.hide.mockResolvedValue(undefined);
    appWindowMock.innerSize.mockResolvedValue({ width: 1400, height: 900 });
    appWindowMock.isMaximized.mockResolvedValue(false);
    appWindowMock.outerPosition.mockResolvedValue({ x: 20, y: 30 });
    appWindowMock.onCloseRequested.mockImplementation((handler: CloseHandler) => {
      closeHandlerRef.current = handler;
      return Promise.resolve(unlistenMock);
    });

    saveOperation = () => Promise.resolve();
    modeOperation = () => Promise.resolve('ui');
    loadedConfig = defaultConfig;
    useBleStore.setState({ customUuidNames: { services: {}, characteristics: {} } });
    invokeMock.mockImplementation((command: string) => {
      if (command === 'load_app_config') return Promise.resolve(loadedConfig);
      if (command === 'save_app_config') return saveOperation();
      if (command === 'get_launch_mode') return modeOperation();
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reaches destroy after a bounded save without querying live window state', async () => {
    saveOperation = () => new Promise<void>(() => {});
    await mountPersistence();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { completion, preventDefault } = triggerClose();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(saveInvokeCount()).toBe(1);
    expect(appWindowMock.outerPosition).not.toHaveBeenCalled();
    expect(appWindowMock.innerSize).not.toHaveBeenCalled();
    expect(appWindowMock.isMaximized).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await completion;
    });

    expect(invokeMock).toHaveBeenCalledWith('get_launch_mode');
    expect(appWindowMock.destroy).toHaveBeenCalledOnce();
    expect(appWindowMock.hide).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('falls back to hiding when launch-mode resolution times out', async () => {
    modeOperation = () => new Promise<LaunchMode>(() => {});
    await mountPersistence();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { completion } = triggerClose();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      await completion;
    });

    expect(appWindowMock.hide).toHaveBeenCalledOnce();
    expect(appWindowMock.destroy).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('still attempts the fallback close action when save and mode queries fail', async () => {
    saveOperation = () => Promise.reject(new Error('save failed'));
    modeOperation = () => Promise.reject(new Error('mode failed'));
    await mountPersistence();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { completion } = triggerClose();
    await completion;

    expect(appWindowMock.hide).toHaveBeenCalledOnce();
    expect(appWindowMock.destroy).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('does not start a duplicate beforeunload save after close begins', async () => {
    saveOperation = () => new Promise<void>(() => {});
    modeOperation = () => Promise.resolve('headless');
    await mountPersistence();
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { completion } = triggerClose();
    window.dispatchEvent(new Event('beforeunload'));
    expect(saveInvokeCount()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      await completion;
    });

    expect(appWindowMock.hide).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it('restores normalized BLE UUID names and writes them back on save', async () => {
    loadedConfig = {
      ...defaultConfig,
      ble_uuid_names: {
        services: { ' ABCD ': ' Private Service ', ignored: 42 },
        characteristics: { EF01: 'Private Characteristic' },
      },
    };
    await mountPersistence();

    expect(useBleStore.getState().customUuidNames).toEqual({
      services: { abcd: 'Private Service' },
      characteristics: { ef01: 'Private Characteristic' },
    });

    useBleStore.getState().setCustomUuidName('characteristic', 'EF02', 'Control Point');
    const { completion } = triggerClose();
    await completion;

    const saveCall = invokeMock.mock.calls.find(([command]) => command === 'save_app_config');
    expect(saveCall?.[1]).toMatchObject({
      config: {
        ble_uuid_names: {
          services: { abcd: 'Private Service' },
          characteristics: {
            ef01: 'Private Characteristic',
            ef02: 'Control Point',
          },
        },
      },
    });
  });

  it('coalesces repeated native close requests while a save is pending', async () => {
    let finishSave!: () => void;
    saveOperation = () => new Promise<void>(resolve => { finishSave = resolve; });
    await mountPersistence();
    const first = triggerClose();
    const second = triggerClose();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(saveInvokeCount()).toBe(1);
    expect(appWindowMock.destroy).not.toHaveBeenCalled();
    finishSave();
    await Promise.all([first.completion, second.completion]);
    expect(appWindowMock.destroy).toHaveBeenCalledOnce();
  });

  it('allows a later close attempt when the native destroy operation fails', async () => {
    appWindowMock.destroy.mockRejectedValueOnce(new Error('native close failed'));
    await mountPersistence();
    await triggerClose().completion;
    await triggerClose().completion;
    expect(saveInvokeCount()).toBe(2);
    expect(appWindowMock.destroy).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending debounced save and removes listeners on unmount', async () => {
    const hook = await mountPersistence();
    vi.useFakeTimers();
    useBleStore.getState().setCustomUuidName('service', '180d', 'Heart Rate');
    expect(saveInvokeCount()).toBe(0);
    hook.unmount();
    window.dispatchEvent(new Event('beforeunload'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveInvokeCount()).toBe(0);
    expect(unlistenMock).toHaveBeenCalledOnce();
  });
});
