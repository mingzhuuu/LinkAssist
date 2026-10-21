import type { TerminalChannelSettings, TerminalDataFormat } from '../stores/uiStore';
import type { LastConnectedBleDevice } from '../stores/bleStore';
import type { PaneNode, TerminalLayoutSnapshot } from '../stores/terminalStore';

export function isTerminalDataFormat(format: unknown): format is TerminalDataFormat {
  return format === 'ascii' || format === 'hex';
}

export function normalizeTerminalChannelSettings(value: unknown): Record<string, TerminalChannelSettings> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const normalized: Record<string, TerminalChannelSettings> = {};
  for (const [channelId, candidate] of Object.entries(value)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const settings = candidate as Record<string, unknown>;
    if (
      !isTerminalDataFormat(settings.sendFormat)
      || !isTerminalDataFormat(settings.receiveFormat)
      || typeof settings.showInputPrefix !== 'boolean'
      || typeof settings.showTimestamp !== 'boolean'
    ) {
      return null;
    }
    normalized[channelId] = {
      sendFormat: settings.sendFormat,
      receiveFormat: settings.receiveFormat,
      showInputPrefix: settings.showInputPrefix,
      showTimestamp: settings.showTimestamp,
    };
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isPaneNode(value: unknown, depth = 0): value is PaneNode {
  // Imported JSON may be deeply nested; do not recurse until the UI stack overflows.
  if (!isRecord(value) || depth > 64) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'leaf') {
    return typeof candidate.paneId === 'string' && candidate.paneId.length > 0;
  }
  if (candidate.type === 'split') {
    return typeof candidate.id === 'string'
      && (candidate.direction === 'horizontal' || candidate.direction === 'vertical')
      && typeof candidate.ratio === 'number'
      && Number.isFinite(candidate.ratio) && candidate.ratio > 0 && candidate.ratio < 1
      && isPaneNode(candidate.left, depth + 1)
      && isPaneNode(candidate.right, depth + 1);
  }
  return false;
}

export function isTerminalLayoutSnapshot(value: unknown): value is TerminalLayoutSnapshot {
  if (!isRecord(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!isPaneNode(candidate.root)) return false;
  if (!isRecord(candidate.panes)) return false;
  if (candidate.focusedPaneId !== null && typeof candidate.focusedPaneId !== 'string') return false;

  const paneIds = new Set<string>();
  const splitIds = new Set<string>();
  const visit = (node: PaneNode): boolean => {
    if (node.type === 'leaf') {
      if (paneIds.has(node.paneId)) return false;
      paneIds.add(node.paneId);
      return true;
    }
    if (splitIds.has(node.id)) return false;
    splitIds.add(node.id);
    return visit(node.left) && visit(node.right);
  };
  if (!visit(candidate.root)) return false;
  const savedIds = Object.keys(candidate.panes);
  if (savedIds.length !== paneIds.size || savedIds.some(id => !paneIds.has(id))) return false;
  if (candidate.focusedPaneId !== null && !paneIds.has(candidate.focusedPaneId)) return false;

  return Object.values(candidate.panes).every((pane) => {
    if (!isRecord(pane)) return false;
    const paneCandidate = pane as Record<string, unknown>;
    if (!Array.isArray(paneCandidate.tabs)) return false;
    if (paneCandidate.activeTabId !== null && typeof paneCandidate.activeTabId !== 'string') return false;
    if (paneCandidate.showCommandsPanel !== undefined && typeof paneCandidate.showCommandsPanel !== 'boolean') return false;
    if (paneCandidate.cmdHistory !== undefined && (!Array.isArray(paneCandidate.cmdHistory)
      || !paneCandidate.cmdHistory.every(item => typeof item === 'string'))) return false;
    const tabIds = new Set<string>();
    const validTabs = paneCandidate.tabs.every((tab) => {
      if (!isRecord(tab)) return false;
      const tabCandidate = tab as Record<string, unknown>;
      if (typeof tabCandidate.id !== 'string' || tabIds.has(tabCandidate.id)) return false;
      tabIds.add(tabCandidate.id);
      return tabCandidate.id.length > 0
        && typeof tabCandidate.label === 'string'
        && (typeof tabCandidate.channelId === 'string' || tabCandidate.channelId === null)
        && (typeof tabCandidate.isPinned === 'boolean' || typeof tabCandidate.isPinned === 'undefined');
    });
    return validTabs && (paneCandidate.activeTabId === null || tabIds.has(paneCandidate.activeTabId as string));
  });
}

export function isLastConnectedBleDevice(value: unknown): value is LastConnectedBleDevice {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;

  return typeof candidate.id === 'string'
    && (candidate.name === null || typeof candidate.name === 'string')
    && (candidate.advertisementName === undefined || candidate.advertisementName === null || typeof candidate.advertisementName === 'string')
    && Array.isArray(candidate.serviceUuids)
    && candidate.serviceUuids.every((uuid) => typeof uuid === 'string');
}

