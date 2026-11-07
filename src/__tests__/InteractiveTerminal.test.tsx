import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalLeafPane } from '../components/layout/TerminalLeafPane';
import { TerminalContextMenu } from '../components/layout/TerminalContextMenu';
import { useInteractiveTerminalInput } from '../components/layout/InteractiveTerminal';
import { useChannelStore, useSerialStore, useUIStore } from '../stores';
import { useTerminalStore } from '../stores/terminalStore';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), emit: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ emit: mocks.emit }));

let paneId: string;

const InputHarness: React.FC<{ enabled?: boolean }> = ({ enabled = true }) => {
  const {
    handleInteractiveKeyDown,
    handleInteractivePaste,
    handleInteractiveCompositionStart,
    handleInteractiveCompositionEnd,
  } = useInteractiveTerminalInput({
    paneId,
    channelId: 'serial',
    enabled,
  });
  const cmdInput = useTerminalStore(s => s.panes[paneId]?.cmdInput ?? '');
  return (
    <input
      aria-label="terminal-input"
      value={cmdInput}
      onChange={e => {
        if (!enabled) {
          useTerminalStore.getState().setCmdInput(paneId, e.target.value);
        }
      }}
      onKeyDown={e => { handleInteractiveKeyDown(e); }}
      onPaste={handleInteractivePaste}
      onCompositionStart={handleInteractiveCompositionStart}
      onCompositionEnd={handleInteractiveCompositionEnd}
    />
  );
};

beforeEach(() => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  mocks.emit.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useTerminalStore.setState(useTerminalStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useSerialStore.setState(useSerialStore.getInitialState(), true);
  useUIStore.setState(useUIStore.getInitialState(), true);
  paneId = useTerminalStore.getState().focusedPaneId!;
  useChannelStore.getState().addChannel('serial', 'Console', 'serial');
  useSerialStore.setState({ connectionMap: { port: 'serial' } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('interactive terminal transport', () => {
  it('renders an inline terminal cursor without the bottom command prompt when interactive mode is toggled and used', async () => {
    const store = useTerminalStore.getState();
    store.addTab(paneId, 'serial', 'Console');
    store.appendEntryToChannel('serial', 'rx', 'RX: 4F 4B', 1000, [0x4f, 0x4b]);
    store.setCmdInput(paneId, '01 02');

    const { container } = render(<TerminalLeafPane paneId={paneId} />);
    const inputBefore = container.querySelector('input') as HTMLInputElement;
    expect(inputBefore).not.toBeNull();
    expect(inputBefore.value).toBe('01 02');
    expect(screen.queryByTestId('terminal-inline-cursor')).toBeNull();

    act(() => {
      useUIStore.getState().setTerminalChannelSettings('serial', {
        sendFormat: 'ascii',
        receiveFormat: 'ascii',
        showInputPrefix: false,
        showTimestamp: false,
        interactiveMode: true,
      });
    });

    expect(screen.getByTestId('terminal-inline-cursor')).not.toBeNull();

    const inputAfter = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      fireEvent.keyDown(inputAfter, { key: 'a' });
      fireEvent.keyDown(inputAfter, { key: 'Enter' });
    });

    expect(mocks.invoke.mock.calls).toEqual([
      ['send_serial_data', { connectionId: 'port', data: [0x61] }],
      ['send_serial_data', { connectionId: 'port', data: [0x0d] }],
    ]);
    expect(inputAfter.value).toBe('01 02');
    expect(useTerminalStore.getState().panes[paneId].cmdInput).toBe('01 02');
  });

  it('sends spaces, slash characters, control keys, pasted text, and IME composition in order without changing entries or history', async () => {
    render(<InputHarness />);
    const input = screen.getByLabelText('terminal-input');
    const entriesBefore = useTerminalStore.getState().panes[paneId].entries;

    await act(async () => {
      fireEvent.keyDown(input, { key: '/' });
      fireEvent.keyDown(input, { key: ' ' });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Backspace' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'Tab' });
      fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
      fireEvent.paste(input, { clipboardData: { getData: () => 'help\r' } });
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input, { data: '中文' });
    });

    const encode = (text: string) => Array.from(new TextEncoder().encode(text));
    expect(mocks.invoke.mock.calls).toEqual([
      ['send_serial_data', { connectionId: 'port', data: encode('/') }],
      ['send_serial_data', { connectionId: 'port', data: encode(' ') }],
      ['send_serial_data', { connectionId: 'port', data: encode('\r') }],
      ['send_serial_data', { connectionId: 'port', data: encode('\x7f') }],
      ['send_serial_data', { connectionId: 'port', data: encode('\x1b[A') }],
      ['send_serial_data', { connectionId: 'port', data: encode('\t') }],
      ['send_serial_data', { connectionId: 'port', data: [0x03] }],
      ['send_serial_data', { connectionId: 'port', data: encode('help\r') }],
      ['send_serial_data', { connectionId: 'port', data: encode('中文') }],
    ]);
    expect(useTerminalStore.getState().panes[paneId].cmdHistory).toEqual([]);
    expect(useTerminalStore.getState().panes[paneId].entries).toEqual(entriesBefore);
  });

  it('waits for each transport write and drops queued keys when unmounted', async () => {
    let finish!: () => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const { unmount } = render(<InputHarness />);
    const input = screen.getByLabelText('terminal-input');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'a' });
      fireEvent.keyDown(input, { key: 'b' });
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => finish());
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it('discards remaining queued input after a transport failure and recovers on subsequent keystrokes', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('disconnected'));
    render(<InputHarness />);
    const input = screen.getByLabelText('terminal-input');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'a' });
      fireEvent.keyDown(input, { key: 'b' });
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'c' });
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith('send_serial_data', { connectionId: 'port', data: [99] });
  });

  it('recovers Enter key transmission if IME composition is interrupted without compositionEnd', async () => {
    render(<InputHarness />);
    const input = screen.getByLabelText('terminal-input');

    await act(async () => {
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(mocks.invoke).toHaveBeenCalledWith('send_serial_data', { connectionId: 'port', data: [0x0d] });
  });

  it('retains focus on input across consecutive Enter presses and incoming rx lines in interactive mode', async () => {
    const store = useTerminalStore.getState();
    const tabId = store.addTab(paneId, 'serial', 'Console');
    useUIStore.getState().setTerminalChannelSettings(`tab:${tabId}`, {
      sendFormat: 'ascii',
      receiveFormat: 'ascii',
      showInputPrefix: false,
      showTimestamp: false,
      interactiveMode: true,
    });

    const { container } = render(<TerminalLeafPane paneId={paneId} />);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();

    input.focus();
    expect(document.activeElement).toBe(input);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(mocks.invoke).toHaveBeenCalledWith('send_serial_data', { connectionId: 'port', data: [0x0d] });

    act(() => {
      useTerminalStore.getState().appendEntryToChannel(
        'serial',
        'rx',
        '<FutureMatrix>',
        Date.now(),
        Array.from(new TextEncoder().encode('<FutureMatrix>')),
      );
    });

    expect(document.activeElement).toBe(input);

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(mocks.invoke.mock.calls.filter(c => c[0] === 'send_serial_data')).toEqual([
      ['send_serial_data', { connectionId: 'port', data: [0x0d] }],
      ['send_serial_data', { connectionId: 'port', data: [0x0d] }],
    ]);
  });

  it('isolates terminal interactiveMode between different tabs in the same pane', () => {
    const store = useTerminalStore.getState();
    const tab1Id = store.addTab(paneId, 'serial', 'Serial 1');
    const tab2Id = store.addTab(paneId, 'serial', 'Serial 2');

    const uiStore = useUIStore.getState();
    expect(uiStore.terminalChannelSettings[`tab:${tab1Id}`]?.interactiveMode).toBeFalsy();
    expect(uiStore.terminalChannelSettings[`tab:${tab2Id}`]?.interactiveMode).toBeFalsy();

    act(() => {
      uiStore.setTerminalChannelSettings(`tab:${tab1Id}`, {
        sendFormat: 'ascii',
        receiveFormat: 'ascii',
        showInputPrefix: false,
        showTimestamp: false,
        interactiveMode: true,
      });
    });

    const { rerender } = render(<TerminalLeafPane paneId={paneId} />);

    act(() => {
      useTerminalStore.getState().selectPaneTab(paneId, tab1Id);
    });
    rerender(<TerminalLeafPane paneId={paneId} />);
    expect(screen.getByTestId('terminal-inline-cursor')).not.toBeNull();

    act(() => {
      useTerminalStore.getState().selectPaneTab(paneId, tab2Id);
    });
    rerender(<TerminalLeafPane paneId={paneId} />);
    expect(screen.queryByTestId('terminal-inline-cursor')).toBeNull();
  });
});

describe('terminal interaction menu', () => {
  it('places Terminal interaction at the very bottom below Timestamps', () => {
    render(<TerminalContextMenu x={100} y={100} showReceived sendFormat="hex" receiveFormat="ascii"
      showInputPrefix={false} showTimestamp={false} interactiveMode={false} onToggleInteractiveMode={() => {}}
      onClear={() => {}} onToggleReceived={() => {}} onSetSendFormat={() => {}} onSetReceiveFormat={() => {}}
      onToggleInputPrefix={() => {}} onToggleTimestamps={() => {}} onClose={() => {}} />);
    const buttons = screen.getAllByRole('button');
    const timestampsIndex = buttons.findIndex(b => b.textContent?.includes('Timestamps'));
    const interactiveItem = screen.getByRole('menuitemcheckbox', { name: /Terminal interaction/ });
    const allItems = screen.getByRole('menu').querySelectorAll('button');
    const lastItem = allItems[allItems.length - 1];
    expect(timestampsIndex).toBeGreaterThan(-1);
    expect(lastItem).toBe(interactiveItem);
  });

  it('shows OFF, toggles and closes, and handles Escape', () => {
    const toggle = vi.fn();
    const close = vi.fn();
    const { rerender, unmount } = render(<TerminalContextMenu x={5000} y={5000} showReceived sendFormat="hex" receiveFormat="ascii"
      showInputPrefix={false} showTimestamp={false} interactiveMode={false} onToggleInteractiveMode={toggle}
      onClear={() => {}} onToggleReceived={() => {}} onSetSendFormat={() => {}} onSetReceiveFormat={() => {}}
      onToggleInputPrefix={() => {}} onToggleTimestamps={() => {}} onClose={close} />);
    const item = screen.getByRole('menuitemcheckbox', { name: /Terminal interaction\s*OFF/ });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(toggle).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
    rerender(<span />);
    unmount();
  });
});
