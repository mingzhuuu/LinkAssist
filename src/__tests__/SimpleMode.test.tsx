import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainLayout } from '../components/layout/MainLayout';
import { useUIStore } from '../stores';

const { appWindowMock, invokeMock } = vi.hoisted(() => ({
  appWindowMock: {
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => {}),
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
  RightPanel: ({
    roundMaximizedCanvasTopLeft,
    seamlessMaximizedCanvas,
  }: {
    roundMaximizedCanvasTopLeft?: boolean;
    seamlessMaximizedCanvas?: boolean;
  }) => (
    <div
      data-testid="canvas-panel"
      data-round-maximized-top-left={String(roundMaximizedCanvasTopLeft ?? false)}
      data-seamless-maximized={String(seamlessMaximizedCanvas ?? false)}
    />
  ),
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

describe('Title-bar panel visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    useUIStore.setState(useUIStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('toggles each region independently and can restore a fully hidden layout', async () => {
    await act(async () => { render(<MainLayout />); });
    const titleBar = document.querySelector('[data-window-titlebar]')!;
    const toggle = (label: string, hidden: boolean) => {
      fireEvent.contextMenu(titleBar);
      expect(screen.getAllByRole('menuitemcheckbox').map(item => item.textContent?.replace('✓', '').trim())).toEqual([
        'Channels', 'Channel Configuration', 'Commands', 'Canvas',
      ]);
      const item = screen.getByRole('menuitemcheckbox', { name: label });
      expect(item.getAttribute('aria-checked')).toBe(String(!hidden));
      fireEvent.click(item);
      expect(screen.queryByRole('menu')).toBeNull();
    };
    expect(screen.queryByTitle('Hide center panels')).toBeNull();
    expect(screen.queryByTitle('Hide right panel')).toBeNull();
    toggle('Channel Configuration', true);
    toggle('Commands', false);
    expect(useUIStore.getState().centerTopVisible).toBe(true);
    toggle('Channel Configuration', false);
    expect(screen.getByTestId('center-panel').parentElement?.hidden).toBe(true);
    expect(screen.getByTestId('canvas-panel').getAttribute('data-round-maximized-top-left')).toBe('true');
    toggle('Canvas', false);
    expect(screen.queryByTestId('canvas-panel')).toBeNull();
    toggle('Channels', false);
    expect(screen.queryByTestId('left-panel')).toBeNull();
    expect(titleBar.querySelector('button.rounded-full')).toBeNull();
    toggle('Channels', true);
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(titleBar.querySelector('button.rounded-full')).toBeTruthy();
    toggle('Canvas', true);
    toggle('Commands', true);
    expect(screen.getByTestId('center-panel').parentElement?.hidden).toBe(false);
    expect(screen.getByTestId('canvas-panel')).toBeTruthy();
  });

  it('preserves title-bar dragging and double-click maximize', async () => {
    await act(async () => { render(<MainLayout />); });
    const titleBar = document.querySelector('[data-window-titlebar]')!;
    fireEvent.mouseDown(titleBar as Element, { button: 2, detail: 1 });
    expect(appWindowMock.startDragging).not.toHaveBeenCalled();

    fireEvent.mouseDown(titleBar as Element, { button: 0, detail: 1 });
    expect(appWindowMock.startDragging).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.mouseDown(titleBar as Element, { button: 0, detail: 2 }); });
    expect(appWindowMock.maximize).toHaveBeenCalledTimes(1);
    expect(appWindowMock.startDragging).toHaveBeenCalledTimes(1);
  });

  it('restores old canvas-only layouts using the four independent flags', () => {
    const ui = useUIStore.getState();
    ui.restorePanelVisibility({ simple_mode: true, right_panel_visible: false });
    expect(useUIStore.getState()).toMatchObject({
      centerTopVisible: false, centerBottomVisible: false, channelPanelVisible: false, rightPanelVisible: true,
    });
    ui.restorePanelVisibility({ simple_mode: false, center_bottom_visible: true });
    expect(useUIStore.getState()).toMatchObject({ centerBottomVisible: true, channelPanelVisible: false });
  });
});
