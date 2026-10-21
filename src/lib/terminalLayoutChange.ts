import type { PaneState, PaneNode } from '../stores/terminalStore';

interface State {
  root: PaneNode;
  focusedPaneId: string | null;
  panes: Record<string, PaneState>;
}

/** Compare only persisted references; receiving bytes must not serialize the layout. */
export function terminalLayoutChanged(next: State, previous: State): boolean {
  if (next.root !== previous.root || next.focusedPaneId !== previous.focusedPaneId) return true;
  if (next.panes === previous.panes) return false;
  const ids = Object.keys(next.panes);
  if (ids.length !== Object.keys(previous.panes).length) return true;
  return ids.some(id => {
    const a = next.panes[id];
    const b = previous.panes[id];
    return !b || a.tabs !== b.tabs || a.activeTabId !== b.activeTabId
      || a.showCommandsPanel !== b.showCommandsPanel || a.cmdHistory !== b.cmdHistory;
  });
}
