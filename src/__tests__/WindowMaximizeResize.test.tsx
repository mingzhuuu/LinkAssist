import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainLayout } from '../components/layout/MainLayout';
import { useUIStore } from '../stores';

let resizeCallback: (() => void) | null = null;

const { appWindowMock, invokeMock } = vi.hoisted(() => ({
  appWindowMock: {
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockImplementation((cb: () => void) => {
      resizeCallback = cb;
      return Promise.resolve(() => {});
    }),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    startDragging: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
  invokeMock: vi.fn().mockResolvedValue(false),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => appWindowMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('../components/layout/LeftPanel', () => ({
  LeftPanel: () => <div data-testid="left-panel" />,
}));

vi.mock('../components/layout/CenterPanel', () => ({
  CenterPanel: () => <div data-testid="center-panel" />,
}));

vi.mock('../components/layout/RightPanel', () => ({
  RightPanel: () => <div data-testid="canvas-panel" />,
}));

vi.mock('../components/layout/ResizeHandle', () => ({
  ResizeHandle: () => <div data-testid="resize-handle" />,
}));

vi.mock('../components/layout/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

describe('Window resize and maximize transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resizeCallback = null;
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    useUIStore.setState(useUIStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('keeps frame inset at 0 and rounded corners when windowed and resizing', async () => {
    appWindowMock.isMaximized.mockResolvedValue(false);

    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<MainLayout />);
    });
    expect(renderResult).toBeDefined();

    const outerFrame = document.querySelector('.rounded-\\[14px\\]') as HTMLElement;
    expect(outerFrame).toBeTruthy();
    expect(outerFrame.style.inset).toBe('0px');

    // Simulate resizing the windowed window
    expect(resizeCallback).toBeTypeOf('function');
    act(() => {
      resizeCallback?.();
    });

    // Outer frame must remain at inset: 0 and NOT jump to -14px (no flicker of right-angle edge)
    expect(outerFrame.style.inset).toBe('0px');
  });

  it('synchronously applies rounded window frame before unmaximize completes', async () => {
    appWindowMock.isMaximized.mockResolvedValue(true);

    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<MainLayout />);
    });
    expect(renderResult).toBeDefined();

    const outerFrame = document.querySelector('.rounded-\\[14px\\]') as HTMLElement;
    expect(outerFrame).toBeTruthy();
    expect(outerFrame.style.inset).toBe('-14px');

    let insetDuringUnmaximize: string | null = null;
    appWindowMock.unmaximize.mockImplementation(() => {
      // Check the outer frame style at the moment unmaximize is called
      insetDuringUnmaximize = outerFrame.style.inset;
      appWindowMock.isMaximized.mockResolvedValue(false);
      return Promise.resolve();
    });

    const titleBar = document.querySelector('[data-window-titlebar]');
    expect(titleBar).toBeTruthy();

    // Trigger unmaximize via double-click on titlebar
    await act(async () => {
      fireEvent.mouseDown(titleBar as Element, { button: 0, detail: 2 });
    });

    expect(appWindowMock.unmaximize).toHaveBeenCalledTimes(1);
    // At the time unmaximize was called, inset must already be '0' (or '0px'), not '-14px'
    expect(insetDuringUnmaximize).toBe('0px');
    expect(outerFrame.style.inset).toBe('0px');
  });

  it('synchronously switches to rounded window frame when onResized fires while maximized', async () => {
    appWindowMock.isMaximized.mockResolvedValue(true);

    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<MainLayout />);
    });
    expect(renderResult).toBeDefined();

    const outerFrame = document.querySelector('.rounded-\\[14px\\]') as HTMLElement;
    expect(outerFrame).toBeTruthy();
    expect(outerFrame.style.inset).toBe('-14px');

    // Simulate Aero Snap drag tear-off: window resizes while previously maximized
    expect(resizeCallback).toBeTypeOf('function');
    appWindowMock.isMaximized.mockResolvedValue(false);

    act(() => {
      resizeCallback?.();
    });

    // Inset must IMMEDIATELY switch to '0px' synchronously
    expect(outerFrame.style.inset).toBe('0px');
  });
});
