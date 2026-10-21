import { create } from 'zustand';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntryKind = 'rx' | 'tx' | 'system';

export interface BleTerminalMetadata {
  serviceUuid: string;
  charUuid: string;
}

export interface TerminalEntry {
  id: number;
  kind: EntryKind;
  timestamp: number;
  text: string;
  data?: number[];
  bleMetadata?: BleTerminalMetadata;
  /** Shown only by the aggregate TERMINAL tab to identify the traffic source. */
  sourceLabel?: string;
}

export interface ChannelTab {
  id: string;
  channelId: string | null;
  label: string;
  isPinned?: boolean;
  meta?: {
    originPaneId?: string;
  };
}

export interface BleWriteTarget {
  serviceUuid: string;
  charUuid: string;
}

export interface SelectOption {
  idx: number;
  serviceUuid: string;
  charUuid: string;
  label: string;
}

export interface PaneState {
  tabs: ChannelTab[];
  activeTabId: string | null;
  showCommandsPanel: boolean;
  entries: TerminalEntry[];
  tabEntries: Record<string, TerminalEntry[]>;
  tabWriteTargets: Record<string, BleWriteTarget | null>;
  cmdInput: string;
  cmdHistory: string[];
  historyIndex: number;
  autoScroll: boolean;
  selectedWriteTarget: BleWriteTarget | null;
  selectMode: boolean;
  selectOptions: SelectOption[];
  udpTargetAddr: string | null;
  /** TCP server send target: a client id, 'all' for broadcast, null = first client. */
  selectedTcpClientId: string | null;
}

export interface TerminalLayoutTabSnapshot {
  id: string;
  channelId: string | null;
  label: string;
  isPinned?: boolean;
  meta?: {
    originPaneId?: string;
  };
}

export interface TerminalLayoutPaneSnapshot {
  tabs: TerminalLayoutTabSnapshot[];
  activeTabId: string | null;
  showCommandsPanel?: boolean;
  cmdHistory?: string[];
}

export interface TerminalLayoutSnapshot {
  root: PaneNode;
  panes: Record<string, TerminalLayoutPaneSnapshot>;
  focusedPaneId: string | null;
}

export type SplitDirection = 'horizontal' | 'vertical';

export type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

export type PaneNode =
  | { type: 'leaf'; paneId: string }
  | { type: 'split'; id: string; direction: SplitDirection; ratio: number; left: PaneNode; right: PaneNode };

// ─── Store interface ───────────────────────────────────────────────────────────

interface TerminalStore {
  root: PaneNode;
  panes: Record<string, PaneState>;
  focusedPaneId: string | null;

  getLayoutSnapshot: () => TerminalLayoutSnapshot;
  restoreLayoutSnapshot: (snapshot: TerminalLayoutSnapshot) => void;

  addTab: (paneId: string, channelId: string, label: string) => string;
  renameTab: (paneId: string, tabId: string, label: string) => void;
  removeTab: (paneId: string, tabId: string) => void;

  setFocusedPane: (paneId: string) => void;
  selectPaneTab: (paneId: string, tabId: string) => void;
  splitPane: (paneId: string) => void;
  toggleCommandsPanel: (paneId: string) => void;
  closePane: (paneId: string) => void;
  resizeSplit: (splitId: string, ratio: number) => void;
  moveTab: (sourcePaneId: string, tabId: string, targetPaneId: string) => void;
  reorderTab: (paneId: string, fromIndex: number, toIndex: number) => void;
  dropTabOnZone: (sourcePaneId: string, tabId: string, targetPaneId: string, zone: DropZone) => void;

  setCmdInput: (paneId: string, value: string) => void;
  pushCmdHistory: (paneId: string, command: string) => void;
  setAutoScroll: (paneId: string, value: boolean) => void;
  setSelectedWriteTarget: (paneId: string, target: BleWriteTarget | null) => void;
  setSelectMode: (paneId: string, value: boolean, options?: SelectOption[]) => void;
  setUdpTargetAddr: (paneId: string, addr: string | null) => void;
  setSelectedTcpClient: (paneId: string, clientId: string | null) => void;
  clearEntries: (paneId: string) => void;
  appendEntry: (paneId: string, kind: EntryKind, text: string, timestamp?: number, data?: number[], bleMetadata?: BleTerminalMetadata, sourceLabel?: string) => void;
  appendEntryToChannel: (channelId: string, kind: EntryKind, text: string, timestamp?: number, data?: number[], bleMetadata?: BleTerminalMetadata, sourceLabel?: string) => void;
  appendEntryToTerminal: (kind: EntryKind, text: string, timestamp?: number, data?: number[], bleMetadata?: BleTerminalMetadata, sourceLabel?: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _entryCounter = 0;

function makeTerminalTab(isPinned = true): ChannelTab {
  return { id: crypto.randomUUID(), channelId: null, label: 'TERMINAL', isPinned };
}

function makeEntry(
  kind: EntryKind,
  text: string,
  timestamp?: number,
  data?: number[],
  bleMetadata?: BleTerminalMetadata,
  sourceLabel?: string,
): TerminalEntry {
  return {
    id: _entryCounter++,
    kind,
    timestamp: timestamp ?? Date.now(),
    text,
    data: data ? [...data] : undefined,
    bleMetadata: bleMetadata ? { ...bleMetadata } : undefined,
    sourceLabel,
  };
}

function appendBounded(entries: TerminalEntry[], entry: TerminalEntry): TerminalEntry[] {
  const next = [...entries, entry];
  return next.length > 5000 ? next.slice(next.length - 5000) : next;
}

function makePaneState(isPinnedTerminal = true): PaneState {
  const masterTab = makeTerminalTab(isPinnedTerminal);
  return {
    tabs: [masterTab],
    activeTabId: masterTab.id,
    showCommandsPanel: false,
    entries: [],
    tabEntries: { [masterTab.id]: [] },
    tabWriteTargets: { [masterTab.id]: null },
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

function cloneTerminalEntries(entries: TerminalEntry[] | undefined): TerminalEntry[] {
  return (entries ?? []).map(entry => ({ ...entry }));
}

function cloneChannelTab(tab: ChannelTab, id = crypto.randomUUID()): ChannelTab {
  return {
    id,
    channelId: tab.channelId,
    label: tab.label,
    isPinned: tab.isPinned,
    meta: tab.meta ? { ...tab.meta } : undefined,
  };
}

function collectLeafPaneIds(node: PaneNode, paneIds = new Set<string>()): Set<string> {
  if (node.type === 'leaf') {
    paneIds.add(node.paneId);
    return paneIds;
  }
  collectLeafPaneIds(node.left, paneIds);
  collectLeafPaneIds(node.right, paneIds);
  return paneIds;
}

function sanitizePaneState(snapshot: TerminalLayoutPaneSnapshot): PaneState {
  // Filter out legacy __saved_commands__ tabs from old persisted layouts
  const cleanTabs = snapshot.tabs.filter(tab => tab.channelId !== '__saved_commands__');
  const tabs = cleanTabs.length > 0
    ? cleanTabs.map(tab => ({
        ...tab,
        ...(tab.meta?.originPaneId ? { meta: { originPaneId: tab.meta.originPaneId } } : {}),
      }))
    : [makeTerminalTab(true)];
  const activeTabId = tabs.some(tab => tab.id === snapshot.activeTabId)
    ? snapshot.activeTabId
    : tabs[0]?.id ?? null;
  const tabEntries = Object.fromEntries(tabs.map(tab => [tab.id, [] as TerminalEntry[]]));
  const tabWriteTargets = Object.fromEntries(tabs.map(tab => [tab.id, null as BleWriteTarget | null]));
  return {
    tabs,
    activeTabId,
    showCommandsPanel: snapshot.showCommandsPanel ?? false,
    entries: activeTabId ? (tabEntries[activeTabId] ?? []) : [],
    tabEntries,
    tabWriteTargets,
    cmdInput: '',
    cmdHistory: snapshot.cmdHistory ?? [],
    historyIndex: -1,
    autoScroll: true,
    selectedWriteTarget: null,
    selectMode: false,
    selectOptions: [],
    udpTargetAddr: null,
    selectedTcpClientId: null,
  };
}

function findLeafParent(
  node: PaneNode,
  paneId: string,
  parent: Extract<PaneNode, { type: 'split' }> | null = null,
  side: 'left' | 'right' | null = null
): { parent: Extract<PaneNode, { type: 'split' }> | null; side: 'left' | 'right' | null } | null {
  if (node.type === 'leaf') {
    if (node.paneId === paneId) return { parent, side };
    return null;
  }
  const leftResult = findLeafParent(node.left, paneId, node, 'left');
  if (leftResult) return leftResult;
  return findLeafParent(node.right, paneId, node, 'right');
}

function replaceNodeInTree(root: PaneNode, targetPaneId: string, replacement: PaneNode): PaneNode {
  if (root.type === 'leaf') {
    return root.paneId === targetPaneId ? replacement : root;
  }
  return {
    ...root,
    left: replaceNodeInTree(root.left, targetPaneId, replacement),
    right: replaceNodeInTree(root.right, targetPaneId, replacement),
  };
}

function replaceSplitInTree(root: PaneNode, splitId: string, replacement: PaneNode): PaneNode {
  if (root.type === 'leaf') return root;
  if (root.id === splitId) return replacement;
  return {
    ...root,
    left: replaceSplitInTree(root.left, splitId, replacement),
    right: replaceSplitInTree(root.right, splitId, replacement),
  };
}

function updateSplitRatioInTree(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.type === 'leaf') return root;
  if (root.id === splitId) return { ...root, ratio };
  return {
    ...root,
    left: updateSplitRatioInTree(root.left, splitId, ratio),
    right: updateSplitRatioInTree(root.right, splitId, ratio),
  };
}

/** Remove a non-pinned tab from a pane and return the updated PaneState. */
function removeTabFromPane(pane: PaneState, tabId: string): PaneState {
  const newTabs = pane.tabs.filter(t => t.id !== tabId);
  const newTabEntries = { ...pane.tabEntries };
  const newTabWriteTargets = { ...pane.tabWriteTargets };
  delete newTabEntries[tabId];
  delete newTabWriteTargets[tabId];
  let newActiveTabId = pane.activeTabId;
  if (pane.activeTabId === tabId) {
    newActiveTabId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
  }
  const nextEntries = newActiveTabId ? (newTabEntries[newActiveTabId] ?? []) : [];
  const nextSelectedWriteTarget = newActiveTabId ? (newTabWriteTargets[newActiveTabId] ?? null) : null;
  return {
    ...pane,
    tabs: newTabs,
    activeTabId: newActiveTabId,
    entries: nextEntries,
    tabEntries: newTabEntries,
    tabWriteTargets: newTabWriteTargets,
    selectedWriteTarget: nextSelectedWriteTarget,
  };
}

// ─── Initial state ────────────────────────────────────────────────────────────

const initialPaneId = crypto.randomUUID();

// ─── Store ────────────────────────────────────────────────────────────────────

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  root: { type: 'leaf', paneId: initialPaneId },
  panes: { [initialPaneId]: makePaneState(true) },
  focusedPaneId: initialPaneId,

  getLayoutSnapshot: () => {
    const state = get();
    const paneIds = collectLeafPaneIds(state.root);
    const panes: Record<string, TerminalLayoutPaneSnapshot> = {};
    for (const paneId of paneIds) {
      const pane = state.panes[paneId];
      if (!pane) continue;
      panes[paneId] = {
        tabs: pane.tabs.map(tab => ({
          id: tab.id,
          channelId: tab.channelId,
          label: tab.label,
          isPinned: tab.isPinned,
          meta: tab.meta ? { ...tab.meta } : undefined,
        })),
        activeTabId: pane.activeTabId,
        showCommandsPanel: pane.showCommandsPanel,
        cmdHistory: pane.cmdHistory.slice(0, 100),
      };
    }

    return {
      root: state.root,
      panes,
      focusedPaneId: state.focusedPaneId,
    };
  },

  restoreLayoutSnapshot: (snapshot) => {
    const paneIds = collectLeafPaneIds(snapshot.root);
    const panes: Record<string, PaneState> = {};
    for (const paneId of paneIds) {
      const paneSnapshot = snapshot.panes[paneId];
      if (!paneSnapshot) continue;
      panes[paneId] = sanitizePaneState(paneSnapshot);
    }

    const restoredPaneIds = Object.keys(panes);
    if (restoredPaneIds.length === 0) {
      const fallbackPaneId = crypto.randomUUID();
      set({
        root: { type: 'leaf', paneId: fallbackPaneId },
        panes: { [fallbackPaneId]: makePaneState(true) },
        focusedPaneId: fallbackPaneId,
      });
      return;
    }

    const focusedPaneId = snapshot.focusedPaneId && panes[snapshot.focusedPaneId]
      ? snapshot.focusedPaneId
      : restoredPaneIds[0];

    set({
      root: snapshot.root,
      panes,
      focusedPaneId,
    });
  },

  addTab: (paneId, channelId, label) => {
    const tabId = crypto.randomUUID();
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            tabs: [...pane.tabs, { id: tabId, channelId, label }],
            activeTabId: tabId,
            entries: [],
            tabEntries: { ...pane.tabEntries, [tabId]: [] },
            tabWriteTargets: { ...pane.tabWriteTargets, [tabId]: null },
            selectedWriteTarget: null,
          },
        },
      };
    });
    return tabId;
  },

  renameTab: (paneId, tabId, label) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            tabs: pane.tabs.map(t => t.id === tabId ? { ...t, label } : t),
          },
        },
      };
    });
  },

  removeTab: (paneId, tabId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      const tabToRemove = pane.tabs.find(t => t.id === tabId);
      if (tabToRemove?.isPinned) return {};

      const newTabs = pane.tabs.filter(t => t.id !== tabId);
      const newTabEntries = { ...pane.tabEntries };
      const newTabWriteTargets = { ...pane.tabWriteTargets };
      delete newTabEntries[tabId];
      delete newTabWriteTargets[tabId];

      // If pane will be empty and it's not the only pane, close the pane
      const isLastPane = state.root.type === 'leaf' && state.root.paneId === paneId;
      if (newTabs.length === 0 && !isLastPane) {
        // Delegate to closePane logic inline to avoid calling get() in set()
        const found = findLeafParent(state.root, paneId);
        if (!found || !found.parent || !found.side) return {};

        const sibling = found.side === 'left' ? found.parent.right : found.parent.left;
        const newRoot = replaceSplitInTree(state.root, found.parent.id, sibling);

        const newPanes = { ...state.panes };
        delete newPanes[paneId];

        let newFocused = state.focusedPaneId;
        if (newFocused === paneId) {
          newFocused = findFirstLeaf(newRoot);
        }

        return { root: newRoot, panes: newPanes, focusedPaneId: newFocused };
      }

      // Determine new activeTabId
      let newActiveTabId = pane.activeTabId;
      if (pane.activeTabId === tabId) {
        newActiveTabId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
      }

      const nextEntries = newActiveTabId ? (newTabEntries[newActiveTabId] ?? []) : [];
      const nextSelectedWriteTarget = newActiveTabId ? (newTabWriteTargets[newActiveTabId] ?? null) : null;

      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            tabs: newTabs,
            activeTabId: newActiveTabId,
            entries: nextEntries,
            tabEntries: newTabEntries,
            tabWriteTargets: newTabWriteTargets,
            selectedWriteTarget: nextSelectedWriteTarget,
          },
        },
      };
    });
  },

  setFocusedPane: (paneId) => {
    set({ focusedPaneId: paneId });
  },

  selectPaneTab: (paneId, tabId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      // Validate that the tab exists in this pane
      if (!pane.tabs.some(t => t.id === tabId)) return {};
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            activeTabId: tabId,
            entries: pane.tabEntries[tabId] ?? [],
            selectedWriteTarget: pane.tabWriteTargets[tabId] ?? null,
          },
        },
      };
    });
  },

  splitPane: (paneId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};

      const newPaneId = crypto.randomUUID();
      const masterTab = makeTerminalTab(false);

      // Copy current active tab (deep copy) into new pane
      const activeTab = pane.tabs.find(t => t.id === pane.activeTabId);
      const isActiveMasterTab = activeTab?.channelId === null;
      const copiedTab = activeTab && !isActiveMasterTab ? cloneChannelTab(activeTab) : null;
      const copiedEntries = activeTab ? cloneTerminalEntries(pane.tabEntries[activeTab.id]) : [];
      const newPaneTabs: ChannelTab[] = copiedTab ? [copiedTab] : [masterTab];
      const sourceWriteTarget = activeTab ? (pane.tabWriteTargets[activeTab.id] ?? null) : null;

      const newPane: PaneState = {
        ...makePaneState(false),
        tabs: newPaneTabs,
        activeTabId: copiedTab?.id ?? masterTab.id,
        entries: copiedTab ? copiedEntries : [],
        tabEntries: copiedTab ? { [copiedTab.id]: copiedEntries } : { [masterTab.id]: [] },
        tabWriteTargets: copiedTab ? { [copiedTab.id]: sourceWriteTarget } : { [masterTab.id]: null },
        selectedWriteTarget: copiedTab ? sourceWriteTarget : null,
      };

      const splitNode: PaneNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction: 'horizontal',
        ratio: 0.5,
        left: { type: 'leaf', paneId },
        right: { type: 'leaf', paneId: newPaneId },
      };

      const newRoot = replaceNodeInTree(state.root, paneId, splitNode);

      return {
        root: newRoot,
        panes: { ...state.panes, [newPaneId]: newPane },
        focusedPaneId: newPaneId,
      };
    });
  },

  toggleCommandsPanel: (paneId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};

      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            showCommandsPanel: !pane.showCommandsPanel,
          },
        },
      };
    });
  },

  closePane: (paneId) => {
    set(state => {
      if (state.root.type === 'leaf' && state.root.paneId === paneId) {
        return {};
      }

      const found = findLeafParent(state.root, paneId);
      if (!found || !found.parent || !found.side) return {};

      const sibling = found.side === 'left' ? found.parent.right : found.parent.left;
      const newRoot = replaceSplitInTree(state.root, found.parent.id, sibling);

      const newPanes = { ...state.panes };
      delete newPanes[paneId];

      let newFocused = state.focusedPaneId;
      if (newFocused === paneId) {
        const firstLeaf = findFirstLeaf(newRoot);
        newFocused = firstLeaf;
      }

      return { root: newRoot, panes: newPanes, focusedPaneId: newFocused };
    });
  },

  resizeSplit: (splitId, ratio) => {
    set(state => ({
      root: updateSplitRatioInTree(state.root, splitId, ratio),
    }));
  },

  moveTab: (sourcePaneId, tabId, targetPaneId) => {
    if (sourcePaneId === targetPaneId) return;
    set(state => {
      const srcPane = state.panes[sourcePaneId];
      const dstPane = state.panes[targetPaneId];
      if (!srcPane || !dstPane) return {};
      const tab = srcPane.tabs.find(t => t.id === tabId);
      if (!tab || tab.isPinned) return {};
      const copiedEntries = cloneTerminalEntries(srcPane.tabEntries[tabId]);
      const writeTargetFromSource = srcPane.tabWriteTargets[tabId] ?? null;

      // Remove from source
      const srcResult = removeTabFromPane(srcPane, tabId);
      const newPanes = { ...state.panes };
      let newRoot = state.root;
      let newFocused = state.focusedPaneId;

      // Close the source pane only if it truly has no tabs left
      const isLastPane = state.root.type === 'leaf' && state.root.paneId === sourcePaneId;
      if (srcResult.tabs.length === 0 && !isLastPane) {
        const found = findLeafParent(state.root, sourcePaneId);
        if (found?.parent && found.side) {
          const sibling = found.side === 'left' ? found.parent.right : found.parent.left;
          newRoot = replaceSplitInTree(newRoot, found.parent.id, sibling);
          delete newPanes[sourcePaneId];
          if (newFocused === sourcePaneId) newFocused = targetPaneId;
        }
      } else {
        newPanes[sourcePaneId] = srcResult;
      }

      // Add to target
      const newTab = cloneChannelTab(tab);
      const dst = newPanes[targetPaneId] ?? dstPane;
      newPanes[targetPaneId] = {
        ...dst,
        tabs: [...dst.tabs, newTab],
        activeTabId: newTab.id,
        entries: copiedEntries,
        tabEntries: { ...dst.tabEntries, [newTab.id]: copiedEntries },
        tabWriteTargets: { ...dst.tabWriteTargets, [newTab.id]: writeTargetFromSource },
        selectedWriteTarget: writeTargetFromSource,
      };

      return { root: newRoot, panes: newPanes, focusedPaneId: targetPaneId };
    });
  },

  reorderTab: (paneId, fromIndex, toIndex) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      if (fromIndex === toIndex) return {};
      const tabs = [...pane.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { panes: { ...state.panes, [paneId]: { ...pane, tabs } } };
    });
  },

  dropTabOnZone: (sourcePaneId, tabId, targetPaneId, zone) => {
    if (zone === 'center') {
      // Move tab to the target pane (or reorder if same pane)
      if (sourcePaneId === targetPaneId) return;
      get().moveTab(sourcePaneId, tabId, targetPaneId);
      return;
    }

    set(state => {
      const srcPane = state.panes[sourcePaneId];
      if (!srcPane) return {};
      const tab = srcPane.tabs.find(t => t.id === tabId);
      if (!tab || tab.isPinned) return {};
      const copiedEntries = cloneTerminalEntries(srcPane.tabEntries[tabId]);
      const writeTargetFromSource = srcPane.tabWriteTargets[tabId] ?? null;

        // Create the new pane with the dragged tab
        const newPaneId = crypto.randomUUID();
        const newTab = cloneChannelTab(tab);
        const newPane: PaneState = {
          ...makePaneState(false),
          tabs: [newTab],
          activeTabId: newTab.id,
          entries: copiedEntries,
          tabEntries: { [newTab.id]: copiedEntries },
          tabWriteTargets: { [newTab.id]: writeTargetFromSource },
          selectedWriteTarget: writeTargetFromSource,
        };

      // Remove the tab from source pane
      const srcResult = removeTabFromPane(srcPane, tabId);
      const newPanes = { ...state.panes, [newPaneId]: newPane };
      let newRoot = state.root;

      // Close the source pane only if it truly has no tabs left
      const isLastPane = state.root.type === 'leaf' && state.root.paneId === sourcePaneId;
      if (srcResult.tabs.length === 0 && !isLastPane) {
        const found = findLeafParent(state.root, sourcePaneId);
        if (found?.parent && found.side) {
          const sibling = found.side === 'left' ? found.parent.right : found.parent.left;
          newRoot = replaceSplitInTree(newRoot, found.parent.id, sibling);
          delete newPanes[sourcePaneId];
        }
      } else {
        newPanes[sourcePaneId] = srcResult;
      }

      // Create the split node around the target pane
      const direction: SplitDirection = (zone === 'left' || zone === 'right') ? 'horizontal' : 'vertical';
      const newLeaf: PaneNode = { type: 'leaf', paneId: newPaneId };
      const targetLeaf: PaneNode = { type: 'leaf', paneId: targetPaneId };

      const splitNode: PaneNode = {
        type: 'split',
        id: crypto.randomUUID(),
        direction,
        ratio: 0.5,
        left: (zone === 'left' || zone === 'top') ? newLeaf : targetLeaf,
        right: (zone === 'left' || zone === 'top') ? targetLeaf : newLeaf,
      };

      newRoot = replaceNodeInTree(newRoot, targetPaneId, splitNode);

      return { root: newRoot, panes: newPanes, focusedPaneId: newPaneId };
    });
  },

  setCmdInput: (paneId, value) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return { panes: { ...state.panes, [paneId]: { ...pane, cmdInput: value } } };
    });
  },

  pushCmdHistory: (paneId, command) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            cmdHistory: [command, ...pane.cmdHistory].slice(0, 200),
            historyIndex: -1,
          },
        },
      };
    });
  },

  setAutoScroll: (paneId, value) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return { panes: { ...state.panes, [paneId]: { ...pane, autoScroll: value } } };
    });
  },

  setSelectedWriteTarget: (paneId, target) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      const activeTabId = pane.activeTabId;
      const tabWriteTargets = activeTabId
        ? { ...pane.tabWriteTargets, [activeTabId]: target }
        : pane.tabWriteTargets;
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            selectedWriteTarget: target,
            tabWriteTargets,
          },
        },
      };
    });
  },

  setSelectMode: (paneId, value, options) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            selectMode: value,
            selectOptions: options ?? (value ? pane.selectOptions : []),
          },
        },
      };
    });
  },

  setUdpTargetAddr: (paneId, addr) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return { panes: { ...state.panes, [paneId]: { ...pane, udpTargetAddr: addr } } };
    });
  },

  setSelectedTcpClient: (paneId, clientId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      return { panes: { ...state.panes, [paneId]: { ...pane, selectedTcpClientId: clientId } } };
    });
  },

  clearEntries: (paneId) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      const activeTabId = pane.activeTabId;
      const tabEntries = activeTabId ? { ...pane.tabEntries, [activeTabId]: [] } : pane.tabEntries;
      return {
        panes: {
          ...state.panes,
          [paneId]: { ...pane, entries: [], tabEntries },
        },
      };
    });
  },

  appendEntry: (paneId, kind, text, timestamp, data, bleMetadata, sourceLabel) => {
    set(state => {
      const pane = state.panes[paneId];
      if (!pane) return {};
      const entry = makeEntry(kind, text, timestamp, data, bleMetadata, sourceLabel);
      const activeTabId = pane.activeTabId;
      const next = appendBounded(pane.entries, entry);
      const tabEntries = activeTabId
        ? {
            ...pane.tabEntries,
            [activeTabId]: appendBounded(pane.tabEntries[activeTabId] ?? [], entry),
          }
        : pane.tabEntries;
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            entries: next,
            tabEntries,
          },
        },
      };
    });
  },

  appendEntryToChannel: (channelId, kind, text, timestamp, data, bleMetadata, sourceLabel) => {
    const state = get();
    const resolvedSourceLabel = sourceLabel ?? Object.values(state.panes)
      .flatMap(pane => pane.tabs)
      .find(tab => tab.channelId === channelId)?.label ?? channelId;
    const entry = makeEntry(kind, text, timestamp, data, bleMetadata, resolvedSourceLabel);
    const newPanes = { ...state.panes };
    let changed = false;

    for (const paneId of Object.keys(newPanes)) {
      const pane = newPanes[paneId];
      const matchingTabs = pane.tabs.filter(tab => tab.channelId === channelId || tab.channelId === null);
      if (matchingTabs.length === 0) continue;

      const nextTabEntries = { ...pane.tabEntries };
      for (const tab of matchingTabs) {
        nextTabEntries[tab.id] = appendBounded(pane.tabEntries[tab.id] ?? [], entry);
      }

      const activeTabMatches = matchingTabs.some(tab => tab.id === pane.activeTabId);
      const nextEntries = activeTabMatches
        ? appendBounded(pane.entries, entry)
        : pane.entries;

      newPanes[paneId] = {
        ...pane,
        entries: nextEntries,
        tabEntries: nextTabEntries,
      };
      changed = true;
    }

    if (changed) set({ panes: newPanes });
  },

  appendEntryToTerminal: (kind, text, timestamp, data, bleMetadata, sourceLabel) => {
    const state = get();
    const entry = makeEntry(kind, text, timestamp, data, bleMetadata, sourceLabel);
    const newPanes = { ...state.panes };
    let changed = false;

    for (const paneId of Object.keys(newPanes)) {
      const pane = newPanes[paneId];
      const terminalTabs = pane.tabs.filter(tab => tab.channelId === null);
      if (terminalTabs.length === 0) continue;

      const nextTabEntries = { ...pane.tabEntries };
      for (const tab of terminalTabs) {
        nextTabEntries[tab.id] = appendBounded(pane.tabEntries[tab.id] ?? [], entry);
      }

      const activeTabMatches = terminalTabs.some(tab => tab.id === pane.activeTabId);
      newPanes[paneId] = {
        ...pane,
        entries: activeTabMatches ? appendBounded(pane.entries, entry) : pane.entries,
        tabEntries: nextTabEntries,
      };
      changed = true;
    }

    if (changed) set({ panes: newPanes });
  },
}));

// ─── Tree utility (used in closePane) ─────────────────────────────────────────

function findFirstLeaf(node: PaneNode): string | null {
  if (node.type === 'leaf') return node.paneId;
  return findFirstLeaf(node.left) ?? findFirstLeaf(node.right);
}
