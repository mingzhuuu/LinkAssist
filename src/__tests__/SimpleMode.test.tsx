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
    expect(useUIStore.getState().centerTopVisible).toBe(true);
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
    expect(titleBar.querySelectorAll('button')).toHaveLength(3);
    const mainContentArea = document.querySelector<HTMLElement>('[data-main-content-area]')!;
    const outerFrame = document.querySelector<HTMLElement>('[data-windowed-frame]')!;
    expect(mainContentArea.hidden).toBe(true);
    expect(mainContentArea.className.split(' ')).toContain('hidden');
    expect(outerFrame.style.inset).toBe('0px');
    // Right-clicking the main window frame itself opens the visibility control menu when all panels are hidden
    fireEvent.contextMenu(outerFrame);
    const channelsItem = screen.getByRole('menuitemcheckbox', { name: 'Channels' });
    expect(channelsItem.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(channelsItem);
    expect(mainContentArea.hidden).toBe(false);
    expect(outerFrame.style.inset).toBe('0px');
    expect(screen.getByTestId('left-panel')).toBeTruthy();
    expect(titleBar.querySelector('button.rounded-full')).toBeTruthy();
    toggle('Canvas', true);
    toggle('Channel Configuration', true);
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

  it('extends the active panel to the main frame border with a straight top border when channels are hidden and only canvas or only center is visible', async () => {
    await act(async () => { render(<MainLayout />); });
    const titleBar = document.querySelector<HTMLElement>('[data-window-titlebar]')!;
    const frameContent = titleBar.parentElement!;
    const centerRegion = () => document.querySelector<HTMLElement>('[data-center-panel-region]')!;
    const rightRegion = () => document.querySelector<HTMLElement>('[data-right-panel-region]');

    // Default: all visible -> inset frame with rounded-xl panels
    expect(frameContent.className.split(' ')).toContain('p-0.5');
    expect(centerRegion().className.split(' ')).toContain('rounded-xl');
    expect(rightRegion()?.className.split(' ')).toContain('rounded-xl');

    // Hide channels while both center and canvas are visible -> still inset and rounded
    act(() => {
      useUIStore.setState({
        channelPanelVisible: false,
        centerTopVisible: true,
        centerBottomVisible: true,
        rightPanelVisible: true,
      });
    });
    expect(frameContent.className.split(' ')).toContain('p-0.5');
    expect(centerRegion().className.split(' ')).toContain('rounded-xl');
    expect(rightRegion()?.className.split(' ')).toContain('rounded-xl');

    // Only canvas visible with channels hidden -> extends left/right/bottom to frame, straight top border
    act(() => {
      useUIStore.setState({
        channelPanelVisible: false,
        centerTopVisible: false,
        centerBottomVisible: false,
        rightPanelVisible: true,
      });
    });
    expect(frameContent.className.split(' ')).toContain('pt-0.5');
    expect(frameContent.className.split(' ')).not.toContain('p-0.5');
    expect(titleBar.className.split(' ')).toContain('px-0.5');
    expect(rightRegion()?.className.split(' ')).toContain('border-t');
    expect(rightRegion()?.className.split(' ')).not.toContain('rounded-xl');
    expect(rightRegion()?.className.split(' ')).not.toContain('border');

    // Only center (commands only) visible with channels hidden -> extends left/right/bottom to frame, straight top border
    act(() => {
      useUIStore.setState({
        channelPanelVisible: false,
        centerTopVisible: false,
        centerBottomVisible: true,
        rightPanelVisible: false,
      });
    });
    expect(frameContent.className.split(' ')).toContain('pt-0.5');
    expect(frameContent.className.split(' ')).not.toContain('p-0.5');
    expect(titleBar.className.split(' ')).toContain('px-0.5');
    expect(centerRegion().className.split(' ')).toContain('border-t');
    expect(centerRegion().className.split(' ')).not.toContain('rounded-xl');
    expect(centerRegion().className.split(' ')).not.toContain('border');

    // Only center (channel configuration only) visible with channels hidden -> extends left/right/bottom to frame, straight top border
    act(() => {
      useUIStore.setState({
        channelPanelVisible: false,
        centerTopVisible: true,
        centerBottomVisible: false,
        rightPanelVisible: false,
      });
    });
    expect(frameContent.className.split(' ')).toContain('pt-0.5');
    expect(centerRegion().className.split(' ')).toContain('border-t');
    expect(centerRegion().className.split(' ')).not.toContain('rounded-xl');
  });
});
