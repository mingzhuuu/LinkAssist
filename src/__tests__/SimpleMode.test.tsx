import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('Simple mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    useUIStore.setState(useUIStore.getInitialState(), true);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows only the canvas and exits from the title-bar context menu', async () => {
    useUIStore.setState({
      simpleMode: true,
      channelPanelVisible: true,
      centerTopVisible: true,
      centerBottomVisible: true,
      rightPanelVisible: false,
    });

    await act(async () => { render(<MainLayout />); });

    expect(screen.queryByTestId('left-panel')).toBeNull();
    expect(screen.queryByTestId('center-panel')).toBeNull();
    expect(screen.getByTestId('canvas-panel').getAttribute('data-round-maximized-top-left')).toBe('true');
    expect(screen.getByTestId('canvas-panel').getAttribute('data-seamless-maximized')).toBe('true');
    expect(screen.queryByTitle('Hide center panels')).toBeNull();
    expect(screen.queryByTitle('Show right panel')).toBeNull();

    const titleBar = document.querySelector('[data-window-titlebar]');
    expect(titleBar).toBeTruthy();
    expect(titleBar?.parentElement?.className.split(' ')).toContain('pl-0');
    expect(titleBar?.parentElement?.className.split(' ')).not.toContain('pl-0.5');
    expect(document.querySelector('[data-tauri-drag-region]')).toBeNull();
    fireEvent.contextMenu(titleBar as Element);

    const exitItem = screen.getByRole('menuitem', { name: 'Exit simple mode' });
    expect(exitItem.parentElement?.className).toContain('w-max');
    expect(exitItem.parentElement?.className).not.toContain('py-1');
    expect(exitItem.className).toContain('whitespace-nowrap');
    await act(async () => { fireEvent.click(exitItem); });

    expect(useUIStore.getState().simpleMode).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(screen.getByTestId('center-panel')).toBeTruthy();
    expect(screen.queryByTestId('canvas-panel')).toBeNull();
    expect(screen.getByTitle('Hide center panels')).toBeTruthy();
    expect(screen.getByTitle('Show right panel')).toBeTruthy();
    expect(titleBar?.parentElement?.className.split(' ')).toContain('pl-0.5');
  });

  it('enters simple mode from the normal title-bar context menu', async () => {
    await act(async () => { render(<MainLayout />); });

    const titleBar = document.querySelector('[data-window-titlebar]');
    expect(titleBar).toBeTruthy();
    expect(document.querySelector('[data-tauri-drag-region]')).toBeNull();
    const canvasPanel = screen.getByTestId('canvas-panel');
    expect(canvasPanel.getAttribute('data-seamless-maximized')).toBe('true');
    expect(canvasPanel.parentElement?.className.split(' ')).toContain('relative');
    expect(canvasPanel.parentElement?.className.split(' ')).toContain('z-0');

    const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      titleBar?.dispatchEvent(contextMenuEvent);
    });

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    const simpleModeItem = screen.getByRole('menuitem', { name: 'Simple mode' });
    await act(async () => { fireEvent.click(simpleModeItem); });

    expect(useUIStore.getState().simpleMode).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByTestId('left-panel')).toBeNull();
    expect(screen.queryByTestId('center-panel')).toBeNull();
    expect(screen.getByTestId('canvas-panel')).toBeTruthy();

    fireEvent.mouseDown(titleBar as Element, { button: 2, detail: 1 });
    expect(appWindowMock.startDragging).not.toHaveBeenCalled();

    fireEvent.mouseDown(titleBar as Element, { button: 0, detail: 1 });
    expect(appWindowMock.startDragging).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.mouseDown(titleBar as Element, { button: 0, detail: 2 }); });
    expect(appWindowMock.maximize).toHaveBeenCalledTimes(1);
    expect(appWindowMock.startDragging).toHaveBeenCalledTimes(1);
  });

  it('uses the outer frame when the canvas fills the content area outside simple mode', () => {
    useUIStore.setState({
      simpleMode: false,
      channelPanelVisible: true,
      centerTopVisible: false,
      centerBottomVisible: false,
      rightPanelVisible: true,
    });

    render(<MainLayout />);

    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(screen.queryByTestId('center-panel')).toBeNull();
    expect(screen.getByTestId('canvas-panel').getAttribute('data-round-maximized-top-left')).toBe('true');
    expect(screen.getByTestId('canvas-panel').getAttribute('data-seamless-maximized')).toBe('true');
  });

  it('keeps tray visibility synchronized after persistence is ready', async () => {
    useUIStore.setState({ simpleMode: true });
    const { rerender } = render(<MainLayout persistenceReady={false} />);

    expect(invokeMock).not.toHaveBeenCalledWith('set_tray_visible', expect.anything());

    rerender(<MainLayout persistenceReady />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_tray_visible', { visible: false });
    });

    act(() => useUIStore.getState().setSimpleMode(false));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_tray_visible', { visible: true });
    });
  });
});
