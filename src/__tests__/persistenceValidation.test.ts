import { describe, expect, it } from 'vitest';
import {
  isLastConnectedBleDevice, isPaneNode, isTerminalLayoutSnapshot,
  normalizeTerminalChannelSettings,
} from '../lib/persistenceValidation';
import type { PaneNode, TerminalLayoutSnapshot } from '../stores/terminalStore';

function snapshot(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', paneId: 'pane' }, focusedPaneId: 'pane',
    panes: { pane: { tabs: [{ id: 'tab', channelId: null, label: 'TERMINAL' }], activeTabId: 'tab' } },
  };
}

describe('persisted terminal layout validation', () => {
  it('accepts legacy optional fields and valid split layouts', () => {
    const saved = snapshot();
    expect(isTerminalLayoutSnapshot(saved)).toBe(true);
    saved.root = { type: 'split', id: 'split', direction: 'horizontal', ratio: 0.5,
      left: saved.root, right: { type: 'leaf', paneId: 'second' } };
    saved.panes.second = { tabs: [], activeTabId: null, cmdHistory: ['01'], showCommandsPanel: true };
    expect(isTerminalLayoutSnapshot(saved)).toBe(true);
  });

  it.each([NaN, Infinity, 0, 1, -1])('rejects invalid split ratio %s', ratio => {
    expect(isPaneNode({ type: 'split', id: 'split', direction: 'horizontal', ratio,
      left: { type: 'leaf', paneId: 'one' }, right: { type: 'leaf', paneId: 'two' } })).toBe(false);
  });

  it('rejects dangling panes, focus and active tabs before hydration', () => {
    const missing = snapshot();
    missing.root = { type: 'leaf', paneId: 'missing' };
    expect(isTerminalLayoutSnapshot(missing)).toBe(false);
    const focus = snapshot();
    focus.focusedPaneId = 'missing';
    expect(isTerminalLayoutSnapshot(focus)).toBe(false);
    const tab = snapshot();
    tab.panes.pane.activeTabId = 'missing';
    expect(isTerminalLayoutSnapshot(tab)).toBe(false);
    const orphan = snapshot();
    orphan.panes.orphan = { tabs: [], activeTabId: null };
    expect(isTerminalLayoutSnapshot(orphan)).toBe(false);
  });

  it('rejects duplicate pane and tab identities', () => {
    const saved = snapshot();
    saved.root = { type: 'split', id: 'split', direction: 'horizontal', ratio: 0.5,
      left: saved.root, right: saved.root };
    expect(isTerminalLayoutSnapshot(saved)).toBe(false);
    const tabs = snapshot();
    tabs.panes.pane.tabs.push({ ...tabs.panes.pane.tabs[0] });
    expect(isTerminalLayoutSnapshot(tabs)).toBe(false);
  });

  it('rejects malformed optional fields and arrays in place of records', () => {
    expect(isTerminalLayoutSnapshot({ ...snapshot(), panes: [] })).toBe(false);
    const saved = snapshot();
    expect(isTerminalLayoutSnapshot({ ...saved,
      panes: { pane: { ...saved.panes.pane, cmdHistory: [3] } } })).toBe(false);
  });

  it('rejects excessively deep or cyclic trees without throwing', () => {
    let node: PaneNode = { type: 'leaf', paneId: 'leaf' };
    for (let index = 0; index < 100; index++) {
      node = { type: 'split', id: `split-${index}`, direction: 'horizontal', ratio: 0.5,
        left: node, right: { type: 'leaf', paneId: `leaf-${index}` } };
    }
    expect(isPaneNode(node)).toBe(false);
    const cycle: PaneNode = { type: 'split', id: 'cycle', direction: 'horizontal', ratio: 0.5,
      left: node, right: node };
    cycle.left = cycle;
    expect(isPaneNode(cycle)).toBe(false);
  });

  it('rejects reused split IDs even when every pane is unique', () => {
    const saved = snapshot();
    saved.root = {
      type: 'split', id: 'duplicate', direction: 'vertical', ratio: 0.4,
      left: saved.root,
      right: {
        type: 'split', id: 'duplicate', direction: 'horizontal', ratio: 0.6,
        left: { type: 'leaf', paneId: 'second' }, right: { type: 'leaf', paneId: 'third' },
      },
    };
    saved.panes.second = { tabs: [], activeTabId: null };
    saved.panes.third = { tabs: [], activeTabId: null };
    expect(isTerminalLayoutSnapshot(saved)).toBe(false);
    if (saved.root.right.type !== 'split') throw new Error('invalid split fixture');
    saved.root.right.id = 'unique';
    expect(isTerminalLayoutSnapshot(saved)).toBe(true);
  });

  it.each([
    ['empty tab ID', { id: '' }],
    ['non-string label', { label: 123 }],
    ['missing channel', { channelId: undefined }],
    ['non-boolean pinned flag', { isPinned: 'true' }],
  ])('rejects %s without throwing', (_label, invalid) => {
    const saved = snapshot();
    expect(isTerminalLayoutSnapshot({ ...saved, panes: {
      pane: { tabs: [{ ...saved.panes.pane.tabs[0], ...invalid }], activeTabId: null },
    } })).toBe(false);
  });

  it('accepts an empty pane with no focused or active tab after JSON round-trip', () => {
    expect(isTerminalLayoutSnapshot(JSON.parse(JSON.stringify({
      root: { type: 'leaf', paneId: 'empty' }, focusedPaneId: null,
      panes: { empty: { tabs: [], activeTabId: null } },
    })))).toBe(true);
  });
});

describe('persisted terminal channel settings', () => {
  const settings = { sendFormat: 'ascii', receiveFormat: 'hex', showInputPrefix: false, showTimestamp: true };

  it('preserves values, drops unknown fields and does not alias the input', () => {
    const input = { serial: { ...settings, obsolete: true } };
    const result = normalizeTerminalChannelSettings(input);
    expect(result).toEqual({ serial: settings });
    expect(result?.serial).not.toBe(input.serial);
    expect(input.serial.obsolete).toBe(true);
    expect(normalizeTerminalChannelSettings({})).toEqual({});
  });

  it.each([null, [], 'hex', 1, { serial: null }, { serial: [] }])(
    'rejects malformed records: %j', input => {
      expect(normalizeTerminalChannelSettings(input)).toBeNull();
    },
  );

  it.each([
    { sendFormat: 'HEX' }, { receiveFormat: 'utf8' },
    { showInputPrefix: 0 }, { showTimestamp: undefined },
  ])('rejects the entire map when one channel is invalid: %j', invalid => {
    expect(normalizeTerminalChannelSettings({
      valid: settings, invalid: { ...settings, ...invalid },
    })).toBeNull();
  });
});

describe('persisted BLE reconnect metadata', () => {
  const device = { id: 'device-1', name: null, serviceUuids: ['180d'] };

  it('accepts legacy records and optional advertisement names', () => {
    expect(isLastConnectedBleDevice(device)).toBe(true);
    expect(isLastConnectedBleDevice({ ...device, advertisementName: null })).toBe(true);
    expect(isLastConnectedBleDevice({ ...device, advertisementName: 'Sensor' })).toBe(true);
  });

  it.each([
    null, [], {}, { ...device, id: 123 }, { ...device, name: false },
    { ...device, advertisementName: 123 }, { ...device, serviceUuids: '180d' },
    { ...device, serviceUuids: ['180d', null] },
  ])('rejects malformed reconnect data: %j', value => {
    expect(isLastConnectedBleDevice(value)).toBe(false);
  });
});
