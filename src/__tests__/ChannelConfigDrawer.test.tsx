import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CenterPanel } from '../components/layout/CenterPanel';
import { LeftPanel } from '../components/layout/LeftPanel';
import { useChannelStore, useUIStore } from '../stores';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock('../components/layout/PaneTreeRenderer', () => ({
  PaneTreeRenderer: () => <button>Terminal command</button>,
}));
vi.mock('../components/channels/uart', async () => {
  const { RoundedSelect } = await import('../components/common/RoundedSelect');
  return {
    UartPanel: ({ channelId }: { channelId: string }) => (
      <div>
        <input aria-label="Baud rate" defaultValue="115200" />
        <RoundedSelect value="one" options={[{ value: 'one', label: 'Port one' }, { value: 'two', label: 'Port two' }]} onChange={vi.fn()} />
        <span>{channelId}</span>
      </div>
    ),
  };
});

function renderWorkspace() {
  return render(<>
    <LeftPanel collapsed={false} expansionProgress={1} showSettings={false} onToggleSettings={vi.fn()} />
    <CenterPanel />
    <button onPointerDown={(event) => event.stopPropagation()}>Canvas</button>
  </>);
}

const drawer = () => document.getElementById('channel-config-drawer')!;
const cardBody = () => document.querySelector<HTMLElement>('[data-channel-card-body]')!;
const cardPath = () => document.querySelector<SVGPathElement>('.channel-card-outline path')!;
const terminal = () => document.querySelector<HTMLElement>('[data-terminal-area]')!;
const channel = (name = 'UART') => screen.getByRole('button', { name: `${name} channel settings` });

describe('channel settings interaction', () => {
  beforeEach(() => {
    useUIStore.setState(useUIStore.getInitialState(), true);
    useChannelStore.setState({
      channels: [
        { id: 'serial-1', name: 'UART', type: 'serial', state: 'disconnected', createdAt: 1 },
        { id: 'serial-2', name: 'Sensor', type: 'serial', state: 'disconnected', createdAt: 2 },
      ],
      activeChannelId: 'serial-1',
    });
  });
  afterEach(cleanup);

  it('previews on double-click when unpinned, connected to the channel item with top alignment and concave arc, and dismisses outside', () => {
    useUIStore.setState({ centerTopVisible: false });
    renderWorkspace();
    expect(drawer().getAttribute('data-state')).toBe('hidden');
    expect(drawer().className).toContain('channel-card-accent-mauve');
    expect(terminal().style.top).toBe('0%');
    expect(channel().className).not.toContain('channel-item-connected');

    fireEvent.click(channel('Sensor'));
    expect(useChannelStore.getState().activeChannelId).toBe('serial-2');
    expect(drawer().getAttribute('data-state')).toBe('hidden');
    fireEvent.doubleClick(channel());
    expect(drawer().getAttribute('data-state')).toBe('preview');
    expect(drawer().getAttribute('data-attached')).toBe('true');
    expect(terminal().style.top).toBe('0%');
    expect(cardBody().style.top).toBe('12px');
    expect(cardBody().style.left).toBe('-8px');
    expect(cardPath().getAttribute('d')).toContain('A 8 8 0 0 0');
    expect(channel().className).toContain('channel-item-connected');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Terminal command' }));
    expect(drawer().getAttribute('data-state')).toBe('hidden');
    expect(drawer().hasAttribute('inert')).toBe(true);
    expect(channel().className).not.toContain('channel-item-connected');

    fireEvent.doubleClick(channel());
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Canvas' }));
    expect(drawer().getAttribute('data-state')).toBe('hidden');
  });

  it('starts pinned by default disconnected from the channel bar and keeps the terminal top divider and split when selecting channels', () => {
    renderWorkspace();
    expect(drawer().getAttribute('data-state')).toBe('pinned');
    expect(drawer().className).toContain('z-10');
    expect(terminal().className).toContain('z-10');
    expect(terminal().className).toContain('border-t');
    expect(terminal().className).toContain('border-border');
    expect(cardBody().style.height).toBe('50%');

    fireEvent.click(channel(), { detail: 1 });
    fireEvent.click(channel(), { detail: 2 });
    fireEvent.doubleClick(channel());

    expect(drawer().getAttribute('data-state')).toBe('pinned');
    expect(drawer().getAttribute('data-attached')).toBe('false');
    expect(terminal().style.top).toBe('50%');
    expect(cardBody().style.left).toBe('0px');
    expect(cardBody().style.top).toBe('0px');
    expect(channel().className).not.toContain('channel-item-connected');

    // Outside clicks do not dismiss when pinned
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Terminal command' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Canvas' }));
    expect(drawer().getAttribute('data-state')).toBe('pinned');
    expect(terminal().style.top).toBe('50%');

    // Switching channels while pinned keeps it pinned and detached from the channel bar
    fireEvent.click(channel('Sensor'));
    expect(useChannelStore.getState().activeChannelId).toBe('serial-2');
    expect(drawer().getAttribute('data-state')).toBe('pinned');
    expect(drawer().getAttribute('data-attached')).toBe('false');
    expect(terminal().style.top).toBe('50%');
    expect(terminal().className).toContain('border-t');
    expect(channel('UART').className).not.toContain('channel-item-connected');
    expect(channel('Sensor').className).not.toContain('channel-item-connected');

    fireEvent.doubleClick(channel('UART'));
    expect(useChannelStore.getState().activeChannelId).toBe('serial-1');
    expect(drawer().getAttribute('data-state')).toBe('pinned');
    expect(terminal().style.top).toBe('50%');
  });

  it('keeps controls mounted when pinning and hiding with the layout controls', () => {
    useUIStore.setState({ centerTopVisible: false });
    renderWorkspace();
    fireEvent.doubleClick(channel());
    fireEvent.change(screen.getByLabelText('Baud rate'), { target: { value: '9600' } });
    act(() => useUIStore.getState().setCenterTopVisible(true));
    expect(drawer().getAttribute('data-state')).toBe('pinned');
    act(() => useUIStore.getState().setCenterTopVisible(false));
    expect(drawer().getAttribute('data-state')).toBe('hidden');
    fireEvent.doubleClick(channel());
    expect(screen.getByLabelText<HTMLInputElement>('Baud rate').value).toBe('9600');
  });

  it('tracks independent edge drags outside the card and stops on pointer release', () => {
    useUIStore.setState({ centerTopVisible: false });
    renderWorkspace();
    fireEvent.doubleClick(channel());
    const width = parseFloat(cardBody().style.width);
    const height = parseFloat(cardBody().style.height);
    const dragEdge = (edge: string, dx: number, dy: number) => {
      const handle = drawer().querySelector<HTMLElement>(`[data-channel-card-resize="${edge}"]`)!;
      handle.setPointerCapture = vi.fn();
      const pointer = { pointerId: 1, isPrimary: true, button: 0 };
      fireEvent.pointerDown(handle, { ...pointer, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(document, { ...pointer, clientX: 200 + dx, clientY: 200 + dy });
      fireEvent.pointerUp(document, pointer);
      fireEvent.pointerMove(document, { ...pointer, clientX: 100, clientY: 100 });
    };
    dragEdge('right', -60, 40);
    dragEdge('bottom', 30, 75);
    expect(parseFloat(cardBody().style.width)).toBe(width - 60);
    expect(parseFloat(cardBody().style.height)).toBe(height + 75);
    expect(cardBody().style.left).toBe('-8px');
    expect(terminal().style.top).toBe('0%');
  });

  it('allows interaction with portalled menus without dismissing the preview', () => {
    useUIStore.setState({ centerTopVisible: false });
    renderWorkspace();
    fireEvent.doubleClick(channel());
    fireEvent.click(screen.getByRole('button', { name: /Port one/ }));
    const option = screen.getByRole('button', { name: 'Port two' });
    expect(drawer().contains(option)).toBe(false);
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(drawer().getAttribute('data-state')).toBe('preview');
  });

  it('switches channels in preview and supports keyboard selection, preview and Escape', () => {
    useUIStore.setState({ centerTopVisible: false });
    renderWorkspace();
    fireEvent.doubleClick(channel());
    expect(drawer().getAttribute('data-state')).toBe('preview');
    fireEvent.pointerDown(channel());
    fireEvent.click(channel());
    expect(drawer().getAttribute('data-state')).toBe('preview');
    fireEvent.pointerDown(channel('Sensor'));
    fireEvent.click(channel('Sensor'));
    expect(drawer().textContent).toContain('serial-2');
    expect(useChannelStore.getState().activeChannelId).toBe('serial-2');
    expect(drawer().getAttribute('data-state')).toBe('preview');
    expect(channel('Sensor').className).toContain('channel-item-connected');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer().getAttribute('data-state')).toBe('hidden');
    expect(document.activeElement).toBe(channel('Sensor'));

    fireEvent.keyDown(channel('Sensor'), { key: ' ' });
    expect(drawer().getAttribute('data-state')).toBe('hidden');

    fireEvent.keyDown(channel('Sensor'), { key: 'Enter', shiftKey: true });
    expect(drawer().getAttribute('data-state')).toBe('preview');
  });

  it('can preview a channel while the command window stays hidden', () => {
    useUIStore.setState({ centerTopVisible: false, centerBottomVisible: false, rightPanelVisible: false });
    renderWorkspace();
    expect(cardBody().style.height).toBe('288px');

    fireEvent.doubleClick(channel());
    expect(terminal()).toBeNull();
    expect(drawer().getAttribute('data-state')).toBe('preview');
    expect(cardBody().style.height).toBe('288px');

    act(() => useUIStore.getState().setCenterTopVisible(false));
    expect(drawer().getAttribute('data-state')).toBe('hidden');
  });

  it('shows Configure Channel in context menu only when channel config is hidden, and triggers preview matching double-click', () => {
    useUIStore.setState({ centerTopVisible: true });
    renderWorkspace();
    fireEvent.contextMenu(channel('UART'));
    expect(screen.queryByText('Configure Channel')).toBeNull();
    expect(screen.getByText('Rename Channel')).toBeDefined();

    fireEvent.mouseDown(document.body);

    act(() => useUIStore.getState().setCenterTopVisible(false));
    expect(drawer().getAttribute('data-state')).toBe('hidden');

    fireEvent.contextMenu(channel('Sensor'));
    const configOption = screen.getByText('Configure Channel');
    expect(configOption).toBeDefined();

    fireEvent.click(configOption);
    expect(drawer().getAttribute('data-state')).toBe('preview');
    expect(useChannelStore.getState().activeChannelId).toBe('serial-2');
    expect(channel('Sensor').className).toContain('channel-item-connected');
    expect(screen.queryByText('Configure Channel')).toBeNull();
  });
});
