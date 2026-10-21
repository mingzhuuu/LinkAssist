import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainLayout } from '../components/layout/MainLayout';
import { ChannelQuickOpenButton } from '../components/layout/TitleBar';
import { useChannelStore, useUIStore } from '../stores';

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

describe('ChannelQuickOpenButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    useUIStore.setState(useUIStore.getInitialState(), true);
    useChannelStore.setState({
      channels: [
        { id: 'ch-1', name: 'Serial Port 1', type: 'serial', state: 'disconnected', createdAt: Date.now() },
        { id: 'ch-2', name: 'BLE Sensor', type: 'ble', state: 'disconnected', createdAt: Date.now() },
      ],
      activeChannelId: 'ch-1',
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens picker and selects channel with a single click', () => {
    render(<ChannelQuickOpenButton />);

    // Initially no channels are selected
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual([]);

    // Left clicking when empty opens the picker
    const quickBtn = document.querySelector('button.rounded-full') as HTMLButtonElement;
    expect(quickBtn).toBeTruthy();
    fireEvent.click(quickBtn);

    // Picker header is shown
    expect(screen.getByText('Open channels')).toBeTruthy();

    // The channels are rendered as buttons with role="checkbox"
    const channelItems = screen.getAllByRole('checkbox');
    expect(channelItems).toHaveLength(2);
    expect(channelItems[0].getAttribute('aria-checked')).toBe('false');

    // Single click on channel 1 selects it
    fireEvent.click(channelItems[0]);
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual(['ch-1']);
    expect(channelItems[0].getAttribute('aria-checked')).toBe('true');

    // Single click on channel 2 selects it as well
    fireEvent.click(channelItems[1]);
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual(['ch-1', 'ch-2']);

    // Single click again deselects channel 1
    fireEvent.click(channelItems[0]);
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual(['ch-2']);
  });

  it('right-click toggles the channel picker', () => {
    render(<ChannelQuickOpenButton />);

    const quickBtn = document.querySelector('button.rounded-full') as HTMLButtonElement;
    expect(quickBtn).toBeTruthy();

    // Open via right-click
    fireEvent.contextMenu(quickBtn);
    expect(screen.getByText('Open channels')).toBeTruthy();

    // Close via right-click
    fireEvent.contextMenu(quickBtn);
    expect(screen.queryByText('Open channels')).toBeNull();
  });

  it('does not trigger window drag or window maximize when clicking inside channel picker in MainLayout', async () => {
    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<MainLayout />);
    });
    expect(renderResult).toBeDefined();

    const quickBtn = document.querySelector('button.rounded-full') as HTMLButtonElement;
    expect(quickBtn).toBeTruthy();

    // Open the picker
    act(() => {
      fireEvent.click(quickBtn);
    });
    expect(screen.getByText('Open channels')).toBeTruthy();

    const channelButtons = screen.getAllByRole('checkbox');
    expect(channelButtons).toHaveLength(2);

    // Single click on channel button
    act(() => {
      fireEvent.mouseDown(channelButtons[0], { button: 0, detail: 1 });
      fireEvent.click(channelButtons[0]);
    });

    // Channel should be selected on single click
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual(['ch-1']);
    // Window dragging should NOT be invoked
    expect(appWindowMock.startDragging).not.toHaveBeenCalled();
    // Window maximize should NOT be invoked
    expect(appWindowMock.maximize).not.toHaveBeenCalled();
    expect(appWindowMock.unmaximize).not.toHaveBeenCalled();

    // Double click inside channel button or picker should NOT maximize window
    act(() => {
      fireEvent.mouseDown(channelButtons[0], { button: 0, detail: 2 });
      fireEvent.doubleClick(channelButtons[0]);
    });

    expect(appWindowMock.maximize).not.toHaveBeenCalled();
    expect(appWindowMock.unmaximize).not.toHaveBeenCalled();
    expect(appWindowMock.startDragging).not.toHaveBeenCalled();
  });

  it('does not trigger title-bar Simple mode context menu when right-clicking quick open button', async () => {
    let renderResult: ReturnType<typeof render> | undefined;
    await act(async () => {
      renderResult = render(<MainLayout />);
    });
    expect(renderResult).toBeDefined();

    const quickBtn = document.querySelector('button.rounded-full') as HTMLButtonElement;
    expect(quickBtn).toBeTruthy();

    act(() => {
      fireEvent.contextMenu(quickBtn);
    });

    // Channel picker opens
    expect(screen.getByText('Open channels')).toBeTruthy();
    // Simple mode context menu must NOT appear
    expect(screen.queryByRole('menuitem', { name: /Simple mode/i })).toBeNull();
  });
});
