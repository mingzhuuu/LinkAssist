import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMainWindowReveal } from '../hooks/useMainWindowReveal';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('useMainWindowReveal', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    document.documentElement.classList.remove(
      'main-window-revealing',
      'main-window-revealed',
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(1);
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.classList.remove(
      'main-window-revealing',
      'main-window-revealed',
    );
  });

  it('keeps an MCP-created headless window hidden after hydration', async () => {
    invokeMock.mockResolvedValue(false);

    renderHook(() => useMainWindowReveal(false, true));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('main_window_ready'));
    await waitFor(() =>
      expect(document.documentElement.classList.contains('main-window-revealing')).toBe(false),
    );
    expect(document.documentElement.classList.contains('main-window-revealed')).toBe(false);
  });

  it('reveals a normal UI only after persistence is ready', async () => {
    invokeMock.mockResolvedValue(true);
    const { rerender } = renderHook(
      ({ ready }) => useMainWindowReveal(false, ready),
      { initialProps: { ready: false } },
    );

    expect(invokeMock).not.toHaveBeenCalled();
    rerender({ ready: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('main_window_ready'));
    await waitFor(() => {
      expect(document.documentElement.classList.contains('main-window-revealing')).toBe(true);
      expect(document.documentElement.classList.contains('main-window-revealed')).toBe(true);
    });
  });

  it('does not register a detached window as the main window', () => {
    renderHook(() => useMainWindowReveal(true, true));

    expect(invokeMock).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('main-window-revealing')).toBe(false);
  });

  it('fails closed when the runtime mode cannot be resolved', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error('IPC unavailable'));

    renderHook(() => useMainWindowReveal(false, true));

    await waitFor(() => expect(warning).toHaveBeenCalled());
    expect(document.documentElement.classList.contains('main-window-revealing')).toBe(false);
    expect(document.documentElement.classList.contains('main-window-revealed')).toBe(false);
    warning.mockRestore();
  });
});
