import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  useBleStore,
  useChannelStore,
  useCommandStore,
  useSerialStore,
  useTcpStore,
  useTerminalStore,
  toast,
} from '../../stores';
import { ChevronDownIcon, EditIcon, SendIcon, TrashIcon } from '../common/Icons';
import { sendWithImmediateTxEcho } from '../../lib/terminalSend';
import { parseTerminalPayload, toHex } from './terminalUtils';

interface Props {
  paneId: string;
}

type ContextMenuState =
  | { type: 'empty'; x: number; y: number; targetGroupId: string | null }
  | { type: 'command'; x: number; y: number; commandId: string }
  | { type: 'group'; x: number; y: number; groupId: string };

interface DragItem {
  id: string;
  type: 'command' | 'group';
}

interface DropTarget {
  /** Parent group id (null = root) */
  parentId: string | null;
  /** Index within the parent's children */
  index: number;
  /** 'into' means dropping directly into a group (append to end) */
  mode: 'before' | 'into';
}

const EMPTY_COMMAND_SET = { groups: [] as import('../../stores/commandStore').CommandGroup[], commands: [] as import('../../stores/commandStore').SavedCommand[] };
const ROW_PADDING_BASE = 12;
const ROW_PADDING_STEP = 12;

function Divider() {
  return <div className="mx-3 border-b border-border" />;
}

function MenuDivider() {
  return <div className="mx-2 border-t border-border/80" />;
}

function resolveTagIdFromPane(paneId: string): string {
  const terminalStore = useTerminalStore.getState();
  const pane = terminalStore.panes[paneId];
  const activeTab = pane?.tabs.find(tab => tab.id === pane.activeTabId);
  return activeTab?.channelId ?? useChannelStore.getState().activeChannelId ?? '__global_saved_commands__';
}

export const SavedCommandsPanel: React.FC<Props> = ({ paneId }) => {
  const selectedCommandId = useCommandStore(state => state.selectedCommandId);
  const selectedGroupId = useCommandStore(state => state.selectedGroupId);
  const terminalPane = useTerminalStore(state => state.panes[paneId]);

  const tagId = useMemo(() => resolveTagIdFromPane(paneId), [paneId, terminalPane?.activeTabId]);
  const commandSet = useCommandStore(state => state.commandSets[tagId]) ?? EMPTY_COMMAND_SET;
  const expandedGroups = useCommandStore(state => state.expandedGroups);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingCommandValueId, setEditingCommandValueId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const sortedGroups = useMemo(
    () => [...commandSet.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [commandSet.groups]
  );
  const groupsByParentId = useMemo(() => {
    const map = new Map<string | null, import('../../stores/commandStore').CommandGroup[]>();
    sortedGroups.forEach(group => {
      const siblings = map.get(group.parentGroupId) ?? [];
      siblings.push(group);
      map.set(group.parentGroupId, siblings);
    });
    return map;
  }, [sortedGroups]);
  const commandsByGroupId = useMemo(() => {
    const map = new Map<string | null, import('../../stores/commandStore').SavedCommand[]>();
    [...commandSet.commands].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).forEach(command => {
      const siblings = map.get(command.groupId) ?? [];
      siblings.push(command);
      map.set(command.groupId, siblings);
    });
    return map;
  }, [commandSet.commands]);

  /** Build an interleaved list of commands + groups at a given parent level, sorted by order */
  const getChildNodes = useCallback((parentId: string | null): Array<{ type: 'command'; id: string; order: number } | { type: 'group'; id: string; order: number }> => {
    const commands = (commandsByGroupId.get(parentId) ?? []).map(c => ({ type: 'command' as const, id: c.id, order: c.order }));
    const groups = (groupsByParentId.get(parentId) ?? []).map(g => ({ type: 'group' as const, id: g.id, order: g.order }));
    return [...commands, ...groups].sort((a, b) => a.order - b.order);
  }, [commandsByGroupId, groupsByParentId]);

  const rootNodes = useMemo(() => getChildNodes(null), [getChildNodes]);
  const moveTargetGroups = useMemo(() => {
    const items: Array<{ id: string; name: string; depth: number }> = [];
    const visit = (parentGroupId: string | null, depth: number) => {
      (groupsByParentId.get(parentGroupId) ?? []).forEach(group => {
        items.push({ id: group.id, name: group.name, depth });
        visit(group.id, depth + 1);
      });
    };
    visit(null, 0);
    return items;
  }, [groupsByParentId]);

  /** Recursively find the deepest expanded group starting from a parent level.
   *  If the last child at a level is an expanded group, recurse into it.
   *  Returns the group id to add into, or null for root level. */
  const findDeepestExpandedGroup = useCallback((parentId: string | null): string | null => {
    const children = getChildNodes(parentId);
    if (children.length === 0) return parentId;
    const lastChild = children[children.length - 1];
    if (lastChild.type === 'group' && (expandedGroups[lastChild.id] ?? false)) {
      return findDeepestExpandedGroup(lastChild.id);
    }
    return parentId;
  }, [getChildNodes, expandedGroups]);

  useEffect(() => {
    if (!editingCommandId && !editingGroupId && !editingCommandValueId) return;
    window.setTimeout(() => editInputRef.current?.focus(), 0);
  }, [editingCommandId, editingGroupId, editingCommandValueId]);

  useEffect(() => {
    const handlePointerDown = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      const activeElement = event.target;
      const isTypingTarget = activeElement instanceof HTMLElement
        && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable);

      if (event.key === 'Escape') {
        setContextMenu(null);
        setEditingCommandId(null);
        setEditingGroupId(null);
        setEditingCommandValueId(null);
        setEditingValue('');
      }
      if (event.key === 'Delete' && !isTypingTarget && !editingCommandId && !editingGroupId && !editingCommandValueId) {
        if (selectedCommandId) {
          event.preventDefault();
          useCommandStore.getState().removeCommand(tagId, selectedCommandId);
          return;
        }
        if (selectedGroupId) {
          event.preventDefault();
          useCommandStore.getState().removeGroup(tagId, selectedGroupId);
          return;
        }
      }
      if (event.key === 'Enter' && selectedCommandId && !editingCommandId && !editingGroupId && !editingCommandValueId) {
        const selected = commandSet.commands.find(command => command.id === selectedCommandId);
        if (selected) {
          event.preventDefault();
          void handleSendCommand(selected.command, selected.name);
        }
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedCommandId, selectedGroupId, editingCommandId, editingGroupId, editingCommandValueId, commandSet.commands, tagId]);

  const appendEntryToChannel = useTerminalStore.getState().appendEntryToChannel;

  const handleSendCommand = useCallback(async (rawCommand: string, name?: string) => {
    const targetChannelId = resolveTagIdFromPane(paneId);
    const channel = useChannelStore.getState().channels.find(item => item.id === targetChannelId);
    if (!channel) {
      toast.error('No linked channel available for saved command');
      return;
    }

    const parsed = parseTerminalPayload(rawCommand.trim());
    if (!parsed) {
      toast.error('Saved command has invalid format');
      return;
    }

    const txLine = `TX(${parsed.modeLabel}): ${toHex(parsed.bytes)}`;

    try {
      let send: (() => Promise<unknown>) | undefined;

      if (channel.type === 'serial') {
        const { openConnections } = useSerialStore.getState();
        if (openConnections.length === 0) {
          toast.error('No serial port open');
          return;
        }
        send = () => invoke('send_serial_data', { connectionId: openConnections[0], data: parsed.bytes });
      } else if (channel.type === 'tcp') {
        const tcpState = useTcpStore.getState();
        if (tcpState.mode === 'client' && tcpState.clientConnections.length > 0) {
          send = () => invoke('tcp_send', { connectionId: tcpState.clientConnections[0].id, data: parsed.bytes });
        } else if (tcpState.mode === 'server' && tcpState.serverClients.length > 0) {
          send = () => invoke('tcp_server_send', { clientId: tcpState.serverClients[0].id, data: parsed.bytes });
        } else if (tcpState.mode === 'udp' && tcpState.udpBound) {
          const udpAddr = useTerminalStore.getState().panes[paneId]?.udpTargetAddr;
          if (!udpAddr) {
            toast.error('No UDP target set on linked terminal');
            return;
          }
          send = () => invoke('udp_send', { addr: udpAddr, data: parsed.bytes });
        } else {
          toast.error('No active TCP connection');
          return;
        }
      } else if (channel.type === 'ble') {
        const connectedDeviceId = useBleStore.getState().getConnectedDeviceIdForChannel(channel.id);
        if (!connectedDeviceId) {
          toast.error('BLE not connected');
          return;
        }

        const writeTarget = useTerminalStore.getState().panes[paneId]?.selectedWriteTarget ?? null;
        if (!writeTarget) {
          toast.error('No BLE write target selected in linked terminal');
          return;
        }

        send = () => invoke('write_ble_characteristic', {
          deviceId: connectedDeviceId,
          serviceUuid: writeTarget.serviceUuid,
          charUuid: writeTarget.charUuid,
          data: parsed.bytes,
        });
      }

      if (!send) return;

      await sendWithImmediateTxEcho(
        () => {
          appendEntryToChannel(channel.id, 'tx', txLine);
        },
        send
      );
      toast.success(name ? `Sent ${name}` : 'Command sent');
    } catch (error) {
      appendEntryToChannel(channel.id, 'system', `Send error: ${String(error)}`);
      toast.error(`Send failed: ${String(error)}`);
    }
  }, [appendEntryToChannel, paneId]);

  const handleAddCommand = useCallback((groupId: string | null) => {
    const id = useCommandStore.getState().addCommand(tagId, groupId, 'New Command', '01 02 FF');
    const command = commandSet.commands.find(item => item.id === id);
    setEditingCommandId(id);
    setEditingCommandValueId(null);
    setEditingGroupId(null);
    setEditingValue(command?.name ?? 'New Command');
    setContextMenu(null);
  }, [tagId, commandSet.commands]);

  const handleAddGroup = useCallback((parentGroupId: string | null = null) => {
    const id = useCommandStore.getState().addGroup(tagId, 'New Group', parentGroupId);
    setEditingGroupId(id);
    setEditingCommandId(null);
    setEditingCommandValueId(null);
    setEditingValue('New Group');
    setContextMenu(null);
  }, [tagId]);

  const beginCommandRename = useCallback((commandId: string) => {
    const command = commandSet.commands.find(item => item.id === commandId);
    if (!command) return;
    setEditingCommandId(commandId);
    setEditingCommandValueId(null);
    setEditingGroupId(null);
    setEditingValue(command.name);
    setContextMenu(null);
  }, [commandSet.commands]);

  const beginCommandValueEdit = useCallback((commandId: string) => {
    const command = commandSet.commands.find(item => item.id === commandId);
    if (!command) return;
    setEditingCommandValueId(commandId);
    setEditingCommandId(null);
    setEditingGroupId(null);
    setEditingValue(command.command);
    setContextMenu(null);
  }, [commandSet.commands]);

  const beginGroupRename = useCallback((groupId: string) => {
    const group = commandSet.groups.find(item => item.id === groupId);
    if (!group) return;
    setEditingGroupId(groupId);
    setEditingCommandId(null);
    setEditingCommandValueId(null);
    setEditingValue(group.name);
    setContextMenu(null);
  }, [commandSet.groups]);

  const commitInlineEdit = useCallback(() => {
    const trimmed = editingValue.trim();
    if (!trimmed) {
      setEditingCommandId(null);
      setEditingGroupId(null);
      setEditingCommandValueId(null);
      setEditingValue('');
      return;
    }

    if (editingCommandId) {
      useCommandStore.getState().updateCommand(tagId, editingCommandId, { name: trimmed });
    }
    if (editingCommandValueId) {
      useCommandStore.getState().updateCommand(tagId, editingCommandValueId, { command: trimmed });
    }
    if (editingGroupId) {
      useCommandStore.getState().updateGroup(tagId, editingGroupId, trimmed);
    }

    setEditingCommandId(null);
    setEditingGroupId(null);
    setEditingCommandValueId(null);
    setEditingValue('');
  }, [editingCommandId, editingCommandValueId, editingGroupId, editingValue, tagId]);

  const cancelInlineEdit = useCallback(() => {
    setEditingCommandId(null);
    setEditingGroupId(null);
    setEditingCommandValueId(null);
    setEditingValue('');
  }, []);

  const handleMoveCommandToGroup = useCallback((commandId: string, groupId: string | null) => {
    useCommandStore.getState().updateCommand(tagId, commandId, { groupId });
    setContextMenu(null);
  }, [tagId]);

  const handleDragStart = useCallback((event: React.DragEvent, item: DragItem) => {
    setDragItem(item);
    setContextMenu(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${item.type}:${item.id}`);
    // Slight delay so the dragged element renders before the ghost captures
    requestAnimationFrame(() => {
      if (item.type === 'command') {
        useCommandStore.getState().setSelectedCommand(item.id);
      } else {
        useCommandStore.getState().setSelectedGroup(item.id);
      }
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragItem(null);
    setDropTarget(null);
  }, []);

  const computeDropTarget = useCallback((event: React.DragEvent, nodeId: string, nodeType: 'command' | 'group', parentId: string | null, _depth: number): DropTarget | null => {
    if (!dragItem) return null;
    // Don't allow dropping on self
    if (dragItem.id === nodeId && dragItem.type === nodeType) return null;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = event.clientY - rect.top;
    const height = rect.height;

    // For groups: top third = before, middle third = into, bottom third = after
    // For commands: top half = before, bottom half = after
    const siblings = getChildNodes(parentId);
    const nodeIndex = siblings.findIndex(n => n.id === nodeId && n.type === nodeType);

    if (nodeType === 'group') {
      if (y < height * 0.25) {
        return { parentId, index: nodeIndex, mode: 'before' };
      } else if (y > height * 0.75) {
        // "after" = before the next sibling
        return { parentId, index: nodeIndex + 1, mode: 'before' };
      } else {
        // Drop INTO the group
        // Prevent dropping a group into itself or its descendants
        if (dragItem.type === 'group' && dragItem.id === nodeId) return null;
        return { parentId: nodeId, index: getChildNodes(nodeId).length, mode: 'into' };
      }
    } else {
      if (y < height * 0.5) {
        return { parentId, index: nodeIndex, mode: 'before' };
      } else {
        return { parentId, index: nodeIndex + 1, mode: 'before' };
      }
    }
  }, [dragItem, getChildNodes]);

  const handleDragOver = useCallback((event: React.DragEvent, nodeId: string, nodeType: 'command' | 'group', parentId: string | null, depth: number) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const target = computeDropTarget(event, nodeId, nodeType, parentId, depth);
    setDropTarget(target);
  }, [computeDropTarget]);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragItem || !dropTarget) {
      setDragItem(null);
      setDropTarget(null);
      return;
    }

    useCommandStore.getState().moveItem(tagId, dragItem.id, dragItem.type, dropTarget.parentId, dropTarget.index);
    setDragItem(null);
    setDropTarget(null);
  }, [dragItem, dropTarget, tagId]);

  const renderCommandRow = (commandId: string, depth: number, parentId: string | null) => {
    const command = commandSet.commands.find(item => item.id === commandId);
    if (!command) return null;
    const isSelected = selectedCommandId === command.id;
    const isEditingName = editingCommandId === command.id;
    const isEditingCommand = editingCommandValueId === command.id;
    const paddingLeft = ROW_PADDING_BASE + depth * ROW_PADDING_STEP;
    const isDragging = dragItem?.id === command.id && dragItem?.type === 'command';

    // Compute whether to show a drop indicator above this row
    const siblings = getChildNodes(parentId);
    const nodeIndex = siblings.findIndex(n => n.id === commandId && n.type === 'command');
    const showDropBefore = dropTarget && dropTarget.mode === 'before' && dropTarget.parentId === parentId && dropTarget.index === nodeIndex;

    return (
      <div
        key={command.id}
        data-command-row
        draggable={!isEditingName && !isEditingCommand}
        onDragStart={(event) => handleDragStart(event, { id: command.id, type: 'command' })}
        onDragEnd={handleDragEnd}
        onDragOver={(event) => handleDragOver(event, commandId, 'command', parentId, depth)}
        onDrop={handleDrop}
        className={[
          'flex items-center gap-2 px-3 py-2 hover:bg-[var(--layer-hover)] transition-all duration-150 cursor-default group relative',
          isSelected ? 'bg-accent-blue/10' : '',
          isDragging ? 'opacity-40' : '',
        ].join(' ')}
        style={{ paddingLeft }}
        onClick={() => useCommandStore.getState().setSelectedCommand(command.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          useCommandStore.getState().setSelectedCommand(command.id);
          setContextMenu({ type: 'command', x: event.clientX, y: event.clientY, commandId: command.id });
        }}
        >
        {showDropBefore && <div className="absolute top-0 left-2 right-2 h-0.5 bg-accent-blue rounded-full" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {isEditingName ? (
              <input
                ref={editInputRef}
                type="text"
                value={editingValue}
                onChange={event => setEditingValue(event.target.value)}
                onBlur={commitInlineEdit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitInlineEdit();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelInlineEdit();
                  }
                }}
                className="w-full bg-surface-tertiary border border-accent-blue/40 rounded px-1.5 py-0.5 text-xs text-text-primary outline-none"
              />
            ) : (
              <span
                className="font-mono text-xs text-text-primary truncate"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  beginCommandRename(command.id);
                }}
              >
                {command.name}
              </span>
            )}
            {!isEditingName && (
              <div
                className="min-w-4 flex-1 self-stretch"
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  beginCommandValueEdit(command.id);
                }}
              />
            )}
          </div>
          {isEditingCommand && (
            <input
              ref={editInputRef}
              type="text"
              value={editingValue}
              onChange={event => setEditingValue(event.target.value)}
              onBlur={commitInlineEdit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitInlineEdit();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelInlineEdit();
                }
              }}
              className="mt-1 w-full bg-surface-tertiary border border-accent-blue/40 rounded px-1.5 py-0.5 text-[10px] font-mono text-text-primary outline-none"
            />
          )}
        </div>

        <button
          onClick={(event) => {
            event.stopPropagation();
            void handleSendCommand(command.command, command.name);
          }}
          className="text-text-muted hover:text-text-secondary p-1 transition-colors shrink-0"
        >
          <SendIcon size={14} />
        </button>
      </div>
    );
  };

  const renderGroupNode = (groupId: string, depth: number, parentId: string | null): React.ReactNode => {
    const group = commandSet.groups.find(item => item.id === groupId);
    if (!group) return null;

    const expanded = expandedGroups[group.id] ?? false;
    const isEditing = editingGroupId === group.id;
    const isGroupSelected = selectedGroupId === group.id;
    const paddingLeft = ROW_PADDING_BASE + depth * ROW_PADDING_STEP;
    const contentNodes = getChildNodes(group.id);
    const isDragging = dragItem?.id === group.id && dragItem?.type === 'group';
    const isDropInto = dropTarget && dropTarget.mode === 'into' && dropTarget.parentId === group.id;

    // Show drop-before indicator
    const siblings = getChildNodes(parentId);
    const nodeIndex = siblings.findIndex(n => n.id === groupId && n.type === 'group');
    const showDropBefore = dropTarget && dropTarget.mode === 'before' && dropTarget.parentId === parentId && dropTarget.index === nodeIndex;

    return (
      <div key={group.id} className={['flex flex-col', isDragging ? 'opacity-40' : ''].join(' ')}>
        <div data-group-row>
          {showDropBefore && <div className="mx-2 h-0.5 bg-accent-blue rounded-full" />}
          <div
            draggable={!isEditing}
            onDragStart={(event) => handleDragStart(event, { id: group.id, type: 'group' })}
            onDragEnd={handleDragEnd}
            onDragOver={(event) => handleDragOver(event, groupId, 'group', parentId, depth)}
            onDrop={handleDrop}
            className={[
              'flex items-center justify-between px-3 py-1.5 hover:bg-[var(--layer-hover)] transition-all duration-150 cursor-default',
              isGroupSelected ? 'bg-accent-blue/10' : '',
              isDropInto ? 'ring-1 ring-accent-blue/60 rounded' : '',
            ].join(' ')}
            style={{ paddingLeft }}
            onClick={() => useCommandStore.getState().setSelectedGroup(group.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              useCommandStore.getState().setSelectedGroup(group.id);
              setContextMenu({ type: 'group', x: event.clientX, y: event.clientY, groupId: group.id });
            }}
          >
            <div className="flex items-center gap-3 flex-1 overflow-hidden pr-2">
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingValue}
                  onChange={event => setEditingValue(event.target.value)}
                  onBlur={commitInlineEdit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitInlineEdit();
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelInlineEdit();
                    }
                  }}
                  className="w-full bg-surface-tertiary border border-accent-blue/40 rounded px-1.5 py-0.5 text-xs text-text-primary outline-none"
                />
              ) : (
                <span
                  className="font-mono text-xs text-text-primary truncate"
                  title={group.name}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    beginGroupRename(group.id);
                  }}
                >
                  {group.name}
                </span>
              )}
            </div>

            <button
              onClick={(event) => {
                event.stopPropagation();
                useCommandStore.getState().toggleGroupExpanded(group.id);
              }}
              className="p-1 hover:bg-[var(--layer-hover)] rounded shrink-0"
            >
              <ChevronDownIcon
                className={`w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        </div>

        {expanded && (
          <div
            data-group-content
            className="text-xs font-mono animate-slide-down"
            onContextMenu={(event) => {
              const targetEl = event.target as HTMLElement;
              if (targetEl.closest('[data-command-row]') || targetEl.closest('[data-group-row]')) return;
              event.preventDefault();
              event.stopPropagation();
              useCommandStore.getState().setSelectedGroup(group.id);
              setContextMenu({ type: 'empty', x: event.clientX, y: event.clientY, targetGroupId: group.id });
            }}
            onDragOver={(event) => {
              // Only handle if not over a child row (those handle their own drag)
              const targetEl = event.target as HTMLElement;
              if (targetEl.closest('[data-command-row]') || targetEl.closest('[data-group-row]')) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              if (dragItem) {
                setDropTarget({ parentId: group.id, index: contentNodes.length, mode: 'into' });
              }
            }}
            onDrop={handleDrop}
          >
            <Divider />
            {contentNodes.length > 0 ? contentNodes.map((node) => (
              <React.Fragment key={`${node.type}-${node.id}`}>
                {node.type === 'command' ? renderCommandRow(node.id, depth + 1, group.id) : renderGroupNode(node.id, depth + 1, group.id)}
                <Divider />
              </React.Fragment>
            )) : (
              <div
                className={['px-4 py-2 text-[10px] text-text-faint italic', isDropInto ? 'bg-accent-blue/5' : ''].join(' ')}
                style={{ paddingLeft: paddingLeft + ROW_PADDING_STEP }}
              >
                {dragItem ? 'Drop here' : 'No commands'}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col flex-1 h-full min-h-0 overflow-y-auto bg-surface"
      tabIndex={0}
      onClick={(event) => {
        const targetEl = event.target as HTMLElement;
        if (!targetEl.closest('[data-command-row]') && !targetEl.closest('[data-group-row]')) {
          useCommandStore.getState().clearSelection();
        }
      }}
        onContextMenu={(event) => {
          // Allow right-click anywhere in the panel (including empty areas) to open context menu
          const targetEl = event.target as HTMLElement;
          const isCommand = targetEl.closest('[data-command-row]');
          const isGroup = targetEl.closest('[data-group-row]');
          if (!isCommand && !isGroup) {
            event.preventDefault();
            const deepestGroupId = findDeepestExpandedGroup(null);
            setContextMenu({ type: 'empty', x: event.clientX, y: event.clientY, targetGroupId: deepestGroupId });
          }
        }}
      onDragOver={(event) => {
        const targetEl = event.target as HTMLElement;
        if (targetEl.closest('[data-command-row]') || targetEl.closest('[data-group-row]') || targetEl.closest('[data-group-content]')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (dragItem) {
          setDropTarget({ parentId: null, index: rootNodes.length, mode: 'before' });
        }
      }}
      onDrop={handleDrop}
      onDragLeave={(event) => {
        // Clear drop target when leaving the container entirely
        if (containerRef.current && !containerRef.current.contains(event.relatedTarget as Node)) {
          setDropTarget(null);
        }
      }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        {rootNodes.length > 0 && rootNodes.map((node) => (
          <React.Fragment key={`${node.type}-${node.id}`}>
            {node.type === 'command' ? renderCommandRow(node.id, 0, null) : renderGroupNode(node.id, 0, null)}
            <Divider />
          </React.Fragment>
        ))}

        {dropTarget && dropTarget.mode === 'before' && dropTarget.parentId === null && dropTarget.index === rootNodes.length && (
          <div className="mx-2 h-0.5 bg-accent-blue rounded-full" />
        )}

        {commandSet.commands.length === 0 && commandSet.groups.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-text-faint gap-2 px-4">
            <div className="text-xs">No saved commands yet</div>
            <div className="text-[10px] text-text-muted text-center">Right-click to add commands or groups.</div>
          </div>
        )}

        {rootNodes.length > 0 && (
          <div className="min-h-16 flex-1" />
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed z-40 min-w-[120px] overflow-hidden rounded-xl border border-border bg-surface-overlay p-1 shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={event => event.stopPropagation()}
        >
          {contextMenu.type === 'empty' && (
            <>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]" onClick={() => handleAddCommand(contextMenu.targetGroupId)}>
                Add Command
              </button>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]" onClick={() => handleAddGroup(contextMenu.targetGroupId)}>
                Add Group
              </button>
              {(commandSet.commands.length > 0 || commandSet.groups.length > 0) && (
                <>
                  <MenuDivider />
                  <button
                    className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-accent-red hover:bg-[var(--layer-active)]"
                    onClick={() => {
                      useCommandStore.getState().clearAllCommands(tagId);
                      setContextMenu(null);
                    }}
                  >
                    Delete All
                  </button>
                </>
              )}
            </>
          )}

          {contextMenu.type === 'command' && (
            <>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)] flex items-center gap-2" onClick={() => beginCommandRename(contextMenu.commandId)}>
                <EditIcon size={12} />
                Rename
              </button>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)] flex items-center gap-2" onClick={() => beginCommandValueEdit(contextMenu.commandId)}>
                <EditIcon size={12} />
                Edit Command
              </button>
              <MenuDivider />
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-text-faint">Move to Group</div>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]" onClick={() => handleMoveCommandToGroup(contextMenu.commandId, null)}>
                Ungrouped
              </button>
              {moveTargetGroups.map(group => (
                <button
                  key={group.id}
                  className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]"
                  style={{ paddingLeft: 10 + group.depth * 16 }}
                  onClick={() => handleMoveCommandToGroup(contextMenu.commandId, group.id)}
                >
                  {group.name}
                </button>
              ))}
              <MenuDivider />
              <button
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-accent-red hover:bg-[var(--layer-active)] flex items-center gap-2"
                onClick={() => {
                  useCommandStore.getState().removeCommand(tagId, contextMenu.commandId);
                  setContextMenu(null);
                }}
              >
                <TrashIcon size={12} />
                Delete
              </button>
            </>
          )}

          {contextMenu.type === 'group' && (
            <>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]" onClick={() => handleAddCommand(contextMenu.groupId)}>
                Add Command to Group
              </button>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)]" onClick={() => handleAddGroup(contextMenu.groupId)}>
                Add Subgroup
              </button>
              <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-[var(--layer-active)] flex items-center gap-2" onClick={() => beginGroupRename(contextMenu.groupId)}>
                <EditIcon size={12} />
                Rename
              </button>
              <button
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs text-accent-red hover:bg-[var(--layer-active)] flex items-center gap-2"
                onClick={() => {
                  useCommandStore.getState().removeGroup(tagId, contextMenu.groupId);
                  setContextMenu(null);
                }}
              >
                <TrashIcon size={12} />
                Delete Group
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
