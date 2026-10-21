import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeftPanel } from '../components/layout/LeftPanel';
import { useChannelStore } from '../stores';

describe('LeftPanel channel rename', () => {
  beforeEach(() => {
    useChannelStore.setState({
      channels: [
        {
          id: 'test-ch-1',
          name: 'My BLE Device',
          type: 'ble',
          state: 'disconnected',
          createdAt: Date.now(),
        },
      ],
      activeChannelId: 'test-ch-1',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('selects initial text on open, but allows typing without re-selecting on every keystroke', () => {
    render(
      <LeftPanel
        collapsed={false}
        expansionProgress={1}
        showSettings={false}
        onToggleSettings={vi.fn()}
      />
    );

    const channelItem = screen.getByText('My BLE Device');
    fireEvent.contextMenu(channelItem, { clientX: 100, clientY: 100 });

    const renameOption = screen.getByText('Rename Channel');
    fireEvent.click(renameOption);

    const input = screen.getByDisplayValue('My BLE Device') as HTMLInputElement;
    expect(input).toBeDefined();

    const selectSpy = vi.spyOn(input, 'select');

    // Simulate user typing consecutively
    fireEvent.change(input, { target: { value: 'My BLE Device 1' } });
    fireEvent.change(input, { target: { value: 'My BLE Device 12' } });

    // select should NOT be called during typing
    expect(selectSpy).not.toHaveBeenCalled();

    // Commit change
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useChannelStore.getState().channels[0].name).toBe('My BLE Device 12');
  });
});
