import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../components/layout/SettingsDialog';
import { useMcpStore } from '../stores';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

describe('SettingsDialog MCP metadata loading', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useMcpStore.setState({
      scripts: [{
        id: 'missing-script',
        luaPath: 'Z:\\missing\\tool.lua',
        exposeToMcp: true,
      }],
    });
  });

  afterEach(() => {
    cleanup();
    useMcpStore.getState().reset();
  });

  it('does not query script metadata while the settings dialog is closed', async () => {
    render(<SettingsDialog open={false} onClose={vi.fn()} />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('queries a failing path once without creating an IPC retry loop', async () => {
    invokeMock.mockRejectedValue(new Error('file not found'));

    const onClose = vi.fn();
    const { rerender } = render(<SettingsDialog open onClose={onClose} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('get_mcp_tool_meta', {
        filePath: 'Z:\\missing\\tool.lua',
      });
      expect(useMcpStore.getState().scripts[0].exposeToMcp).toBe(false);
    });

    // Force a subsequent render after the failed request updates the store.
    // A fixed sleep can pass before a retry scheduled by a later render occurs.
    rerender(<SettingsDialog open onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('shows and updates the global MCP tools switch', () => {
    useMcpStore.setState({ enabled: true, scripts: [] });
    render(<SettingsDialog open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'MCP' }));
    const mcpSwitch = screen.getByRole('switch', { name: 'Enable MCP tools' });
    expect(mcpSwitch.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(mcpSwitch);
    expect(useMcpStore.getState().enabled).toBe(false);
    expect(mcpSwitch.getAttribute('aria-checked')).toBe('false');
  });
});
