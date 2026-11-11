import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useValidTerminalChannels } from '../components/layout/TerminalChannels';
import { useChannelStore, useTerminalStore } from '../stores';

const TerminalWatcher: React.FC<{ paneId: string }> = ({ paneId }) => {
  const tabs = useTerminalStore(s => s.panes[paneId]?.tabs);
  const channels = useChannelStore(s => s.channels);
  useValidTerminalChannels(paneId, tabs, channels);
  return null;
};

describe('useValidTerminalChannels', () => {
  let paneId: string;

  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState(), true);
    useChannelStore.setState({ channels: [], activeChannelId: null });
    paneId = useTerminalStore.getState().focusedPaneId!;
  });

  it('removes a non-pinned tab when its channel is deleted instead of switching to another channel', () => {
    const channelA = useChannelStore.getState().addChannel('serial', 'COM1', 'ch-a');
    const channelB = useChannelStore.getState().addChannel('serial', 'COM2', 'ch-b');

    const tabAId = useTerminalStore.getState().addTab(paneId, channelA, 'COM1');
    render(<TerminalWatcher paneId={paneId} />);

    let pane = useTerminalStore.getState().panes[paneId];
    expect(pane.tabs.map(t => t.id)).toContain(tabAId);

    // Delete Channel A
    act(() => {
      useChannelStore.getState().removeChannel(channelA);
    });

    pane = useTerminalStore.getState().panes[paneId];
    // Tab A should be directly closed, not switched to Channel B
    expect(pane.tabs.map(t => t.id)).not.toContain(tabAId);
    expect(pane.tabs.some(t => t.channelId === channelB)).toBe(false);
  });

  it('keeps tab and updates channels when only some of its receive channels are deleted', () => {
    const channelA = useChannelStore.getState().addChannel('serial', 'COM1', 'ch-a');
    const channelB = useChannelStore.getState().addChannel('serial', 'COM2', 'ch-b');

    const tabId = useTerminalStore.getState().addTab(paneId, channelA, 'MIXED', [channelA, channelB]);
    render(<TerminalWatcher paneId={paneId} />);

    // Delete Channel A
    act(() => {
      useChannelStore.getState().removeChannel(channelA);
    });

    let pane = useTerminalStore.getState().panes[paneId];
    const updatedTab = pane.tabs.find(t => t.id === tabId);
    expect(updatedTab).toBeDefined();
    expect(updatedTab?.receiveChannels).toEqual([channelB]);
    expect(updatedTab?.channelId).toBe(channelB);

    // Now delete Channel B
    act(() => {
      useChannelStore.getState().removeChannel(channelB);
    });

    pane = useTerminalStore.getState().panes[paneId];
    expect(pane.tabs.find(t => t.id === tabId)).toBeUndefined();
  });

  it('removes non-pinned tabs when all channels in workspace are deleted', () => {
    const channelA = useChannelStore.getState().addChannel('serial', 'COM1', 'ch-a');
    const tabAId = useTerminalStore.getState().addTab(paneId, channelA, 'COM1');
    render(<TerminalWatcher paneId={paneId} />);

    expect(useTerminalStore.getState().panes[paneId].tabs.map(t => t.id)).toContain(tabAId);

    act(() => {
      useChannelStore.getState().removeChannel(channelA);
    });

    const pane = useTerminalStore.getState().panes[paneId];
    expect(pane.tabs.map(t => t.id)).not.toContain(tabAId);
    // Pinned master tab remains
    expect(pane.tabs.length).toBe(1);
    expect(pane.tabs[0].isPinned).toBe(true);
  });

  it('pinned master tab is never removed and reverts to all if its channels are deleted', () => {
    const channelA = useChannelStore.getState().addChannel('serial', 'COM1', 'ch-a');
    const masterTabId = useTerminalStore.getState().panes[paneId].tabs[0].id;

    // Configure pinned tab to receive only ch-a
    useTerminalStore.getState().configureTab(paneId, masterTabId, [channelA], channelA);
    render(<TerminalWatcher paneId={paneId} />);

    act(() => {
      useChannelStore.getState().removeChannel(channelA);
    });

    const pane = useTerminalStore.getState().panes[paneId];
    expect(pane.tabs.length).toBe(1);
    expect(pane.tabs[0].id).toBe(masterTabId);
    expect(pane.tabs[0].receiveChannels).toBe('all');
    expect(pane.tabs[0].channelId).toBeNull();
  });

  it('removes non-pinned tab configured with all when all workspace channels are deleted', () => {
    const channelA = useChannelStore.getState().addChannel('serial', 'COM1', 'ch-a');
    const tabId = useTerminalStore.getState().addTab(paneId, null, 'ALL_CUSTOM', 'all');
    render(<TerminalWatcher paneId={paneId} />);

    act(() => {
      useChannelStore.getState().removeChannel(channelA);
    });

    const pane = useTerminalStore.getState().panes[paneId];
    expect(pane.tabs.find(t => t.id === tabId)).toBeUndefined();
    expect(pane.tabs[0].isPinned).toBe(true);
  });
});
