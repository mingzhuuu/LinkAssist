import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalStore, type PaneState } from '../stores/terminalStore';

function createTestPaneState(): PaneState {
  const terminalTabId = crypto.randomUUID();

  return {
    tabs: [{ id: terminalTabId, channelId: null, label: 'TERMINAL', isPinned: true }],
    activeTabId: terminalTabId,
    showCommandsPanel: false,
    entries: [],
    tabEntries: { [terminalTabId]: [] },
    tabWriteTargets: { [terminalTabId]: null },
    cmdInput: '',
    cmdHistory: [],
    historyIndex: -1,
    autoScroll: true,
    selectedWriteTarget: null,
    selectMode: false,
    selectOptions: [],
    udpTargetAddr: null,
    selectedTcpClientId: null,
  };
}

function resetTerminalStore(): string {
  const paneId = crypto.randomUUID();

  useTerminalStore.setState({
    root: { type: 'leaf', paneId },
    panes: { [paneId]: createTestPaneState() },
    focusedPaneId: paneId,
  });

  return paneId;
}

function findNonPinnedTab(pane: PaneState) {
  return pane.tabs.find(tab => !tab.isPinned) ?? null;
}

function findTabByChannelId(pane: PaneState, channelId: string) {
  return pane.tabs.find(tab => tab.channelId === channelId) ?? null;
}

describe('terminalStore history retention', () => {
  beforeEach(() => {
    resetTerminalStore();
  });

  it('retains channel history for inactive tabs until they are selected', () => {
    const paneId = useTerminalStore.getState().focusedPaneId;
    expect(paneId).toBeTruthy();

    const store = useTerminalStore.getState();
    const backgroundTabId = store.addTab(paneId as string, 'channel-background', 'Background Channel');
    const activeTabId = store.addTab(paneId as string, 'channel-active', 'Active Channel');

    store.appendEntryToChannel('channel-background', 'rx', 'RX hidden', 123);

    let pane = useTerminalStore.getState().panes[paneId as string];
    const terminalTab = pane.tabs.find(tab => tab.channelId === null);
    expect(terminalTab).toBeTruthy();
    expect(pane.activeTabId).toBe(activeTabId);
    expect(pane.entries).toEqual([]);
    expect(pane.tabEntries[activeTabId]).toEqual([]);
    expect(pane.tabEntries[backgroundTabId]).toHaveLength(1);
    expect(pane.tabEntries[terminalTab!.id]).toHaveLength(1);
    expect(pane.tabEntries[terminalTab!.id][0].sourceLabel).toBe('Background Channel');
    expect(pane.tabEntries[backgroundTabId][0]).toMatchObject({
      kind: 'rx',
      text: 'RX hidden',
      timestamp: 123,
    });

    store.selectPaneTab(paneId as string, backgroundTabId);

    pane = useTerminalStore.getState().panes[paneId as string];
    expect(pane.entries).toHaveLength(1);
    expect(pane.entries[0]).toMatchObject({
      kind: 'rx',
      text: 'RX hidden',
      timestamp: 123,
    });
  });

  it('routes unbound transport activity only to the aggregate TERMINAL tab', () => {
    const paneId = useTerminalStore.getState().focusedPaneId as string;
    const store = useTerminalStore.getState();
    const channelTabId = store.addTab(paneId, 'channel-one', 'Channel One');

    store.appendEntryToTerminal('rx', 'RX: AA', 456, [0xaa], undefined, 'TEST · BLE · device-2');

    const pane = useTerminalStore.getState().panes[paneId];
    const terminalTab = pane.tabs.find(tab => tab.channelId === null)!;
    expect(pane.tabEntries[channelTabId]).toEqual([]);
    expect(pane.tabEntries[terminalTab.id][0]).toMatchObject({
      text: 'RX: AA',
      sourceLabel: 'TEST · BLE · device-2',
    });
  });

  it('copies active tab history into a new split pane', () => {
    const sourcePaneId = useTerminalStore.getState().focusedPaneId;
    expect(sourcePaneId).toBeTruthy();

    const store = useTerminalStore.getState();
    const tabId = store.addTab(sourcePaneId as string, 'channel-split', 'Split Channel');
    store.appendEntry(sourcePaneId as string, 'rx', 'RX 01', 100);
    store.appendEntry(sourcePaneId as string, 'tx', 'TX 02', 101);

    const sourceEntries = useTerminalStore.getState().panes[sourcePaneId as string].tabEntries[tabId];

    store.splitPane(sourcePaneId as string);

    const state = useTerminalStore.getState();
    const splitPaneId = Object.keys(state.panes).find(id => id !== sourcePaneId);
    expect(splitPaneId).toBeTruthy();

    const splitPane = state.panes[splitPaneId as string];
    const splitTab = findNonPinnedTab(splitPane);
    expect(splitTab).toBeTruthy();
    expect(splitPane.entries).toEqual(sourceEntries);
    expect(splitPane.tabEntries[splitTab!.id]).toEqual(sourceEntries);
    expect(splitPane.tabEntries[splitTab!.id]).not.toBe(sourceEntries);
    expect(state.panes[sourcePaneId as string].tabEntries[tabId]).toEqual(sourceEntries);
  });

  it('preserves tab history when moving a tab to another pane', () => {
    const sourcePaneId = useTerminalStore.getState().focusedPaneId;
    expect(sourcePaneId).toBeTruthy();

    const store = useTerminalStore.getState();
    store.splitPane(sourcePaneId as string);
    const targetPaneId = useTerminalStore.getState().focusedPaneId;
    expect(targetPaneId).toBeTruthy();

    const tabId = store.addTab(sourcePaneId as string, 'channel-move', 'Move Channel');
    store.appendEntry(sourcePaneId as string, 'rx', 'Move RX', 200);
    store.appendEntry(sourcePaneId as string, 'system', 'Move system', 201);

    const sourceEntries = useTerminalStore.getState().panes[sourcePaneId as string].tabEntries[tabId];

    store.moveTab(sourcePaneId as string, tabId, targetPaneId as string);

    const state = useTerminalStore.getState();
    const targetPane = state.panes[targetPaneId as string];
    const movedTab = findTabByChannelId(targetPane, 'channel-move');
    expect(movedTab).toBeTruthy();
    expect(targetPane.activeTabId).toBe(movedTab!.id);
    expect(targetPane.entries).toEqual(sourceEntries);
    expect(targetPane.tabEntries[movedTab!.id]).toEqual(sourceEntries);
    expect(targetPane.tabEntries[movedTab!.id]).not.toBe(sourceEntries);
    expect(state.panes[sourcePaneId as string].tabs.some(tab => tab.id === tabId)).toBe(false);
    expect(state.panes[sourcePaneId as string].tabEntries[tabId]).toBeUndefined();
  });

  it('preserves tab history when dropping a tab into a split zone', () => {
    const sourcePaneId = useTerminalStore.getState().focusedPaneId;
    expect(sourcePaneId).toBeTruthy();

    const store = useTerminalStore.getState();
    store.splitPane(sourcePaneId as string);
    const targetPaneId = useTerminalStore.getState().focusedPaneId;
    expect(targetPaneId).toBeTruthy();

    const tabId = store.addTab(sourcePaneId as string, 'channel-drop', 'Drop Channel');
    store.appendEntry(sourcePaneId as string, 'rx', 'Drop RX', 300);
    store.appendEntry(sourcePaneId as string, 'tx', 'Drop TX', 301);

    const sourceEntries = useTerminalStore.getState().panes[sourcePaneId as string].tabEntries[tabId];

    store.dropTabOnZone(sourcePaneId as string, tabId, targetPaneId as string, 'right');

    const state = useTerminalStore.getState();
    const droppedPane = Object.values(state.panes).find(pane =>
      pane.tabs.some(tab => tab.channelId === 'channel-drop' && tab.label === 'Drop Channel')
    );

    expect(droppedPane).toBeTruthy();

  const droppedTab = findTabByChannelId(droppedPane as PaneState, 'channel-drop');
    expect(droppedTab).toBeTruthy();
    expect((droppedPane as PaneState).entries).toEqual(sourceEntries);
    expect((droppedPane as PaneState).tabEntries[droppedTab!.id]).toEqual(sourceEntries);
    expect((droppedPane as PaneState).tabEntries[droppedTab!.id]).not.toBe(sourceEntries);
    expect(state.panes[sourcePaneId as string].tabs.some(tab => tab.id === tabId)).toBe(false);
  });
});
