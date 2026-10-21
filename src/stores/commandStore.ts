import { create } from 'zustand';

export interface SavedCommand {
  id: string;
  name: string;
  command: string;
  groupId: string | null;
  order: number;
}

export interface CommandGroup {
  id: string;
  name: string;
  order: number;
  parentGroupId: string | null;
}

export interface CommandSet {
  groups: CommandGroup[];
  commands: SavedCommand[];
}

export interface CommandSnapshot {
  commandSets: Record<string, CommandSet>;
  expandedGroups: Record<string, boolean>;
  savedConfigs?: Record<string, SavedConfig[]>;
}

export interface SavedConfig {
  id: string;
  name: string;
  timestamp: number;
  data: CommandSet;
}

interface CommandStore {
  commandSets: Record<string, CommandSet>;
  expandedGroups: Record<string, boolean>;
  selectedCommandId: string | null;
  selectedGroupId: string | null;
  savedConfigs: Record<string, SavedConfig[]>;
  addCommand: (tagId: string, groupId: string | null, name: string, command: string) => string;
  updateCommand: (tagId: string, commandId: string, updates: Partial<Pick<SavedCommand, 'name' | 'command' | 'groupId'>>) => void;
  removeCommand: (tagId: string, commandId: string) => void;
  addGroup: (tagId: string, name: string, parentGroupId?: string | null) => string;
  updateGroup: (tagId: string, groupId: string, name: string) => void;
  removeGroup: (tagId: string, groupId: string) => void;
  toggleGroupExpanded: (groupId: string) => void;
  setSelectedCommand: (commandId: string | null) => void;
  setSelectedGroup: (groupId: string | null) => void;
  clearSelection: () => void;
  exportCommands: (tagId: string) => string;
  importCommands: (tagId: string, json: string) => boolean;
  getSnapshot: () => CommandSnapshot;
  restoreSnapshot: (snapshot: CommandSnapshot) => void;
  saveConfig: (tagId: string, name: string) => void;
  loadConfig: (tagId: string, configId: string) => void;
  deleteConfig: (tagId: string, configId: string) => void;
  clearAllCommands: (tagId: string) => void;
  moveItem: (tagId: string, itemId: string, itemType: 'command' | 'group', targetParentId: string | null, targetIndex: number) => void;
}

function emptyCommandSet(): CommandSet {
  return { groups: [], commands: [] };
}

function cloneCommandSet(commandSet: CommandSet): CommandSet {
  return {
    groups: commandSet.groups.map(group => ({ ...group })),
    commands: commandSet.commands.map(command => ({ ...command })),
  };
}

function getCommandSet(commandSets: Record<string, CommandSet>, tagId: string): CommandSet {
  return commandSets[tagId] ? cloneCommandSet(commandSets[tagId]) : emptyCommandSet();
}

function sanitizeCommandSet(value: unknown): CommandSet {
  if (!value || typeof value !== 'object') return emptyCommandSet();

  const candidate = value as Record<string, unknown>;
  const groupsRaw = Array.isArray(candidate.groups) ? candidate.groups : [];
  const commandsRaw = Array.isArray(candidate.commands) ? candidate.commands : [];

  const groups = groupsRaw
    .filter((group): group is Record<string, unknown> => !!group && typeof group === 'object')
    .map((group, index) => ({
      id: typeof group.id === 'string' && group.id.trim() ? group.id : crypto.randomUUID(),
      name: typeof group.name === 'string' && group.name.trim() ? group.name.trim() : `Group ${index + 1}`,
      order: typeof group.order === 'number' && Number.isFinite(group.order) ? group.order : index,
      parentGroupId: typeof group.parentGroupId === 'string' && group.parentGroupId.trim()
        ? group.parentGroupId
        : null,
    }));

  const groupIds = new Set(groups.map(group => group.id));
  const groupsById = new Map(groups.map(group => [group.id, group]));

  const hasParentCycle = (groupId: string): boolean => {
    const seen = new Set<string>();
    let currentGroupId = groupId;

    while (true) {
      const currentGroup = groupsById.get(currentGroupId);
      const parentGroupId = currentGroup?.parentGroupId;
      if (!parentGroupId || !groupIds.has(parentGroupId)) return false;
      if (parentGroupId === groupId || seen.has(parentGroupId)) return true;
      seen.add(parentGroupId);
      currentGroupId = parentGroupId;
    }
  };

  const sanitizedGroups = groups.map(group => ({
    ...group,
    parentGroupId: group.parentGroupId && !hasParentCycle(group.id)
      ? group.parentGroupId
      : null,
  }));

  const sanitizedGroupIds = new Set(sanitizedGroups.map(group => group.id));

  const commands = commandsRaw
    .filter((command): command is Record<string, unknown> => !!command && typeof command === 'object')
    .map((command, index) => {
      const groupId = typeof command.groupId === 'string' && sanitizedGroupIds.has(command.groupId)
        ? command.groupId
        : null;
      return {
        id: typeof command.id === 'string' && command.id.trim() ? command.id : crypto.randomUUID(),
        name: typeof command.name === 'string' && command.name.trim() ? command.name.trim() : `Command ${index + 1}`,
        command: typeof command.command === 'string' ? command.command : '',
        groupId,
        order: typeof command.order === 'number' && Number.isFinite(command.order) ? command.order : index,
      };
    });

  return { groups: sanitizedGroups, commands };
}

function sanitizeSnapshot(snapshot: CommandSnapshot): CommandSnapshot {
  const commandSetsEntries = Object.entries(snapshot.commandSets ?? {}).map(([tagId, value]) => [tagId, sanitizeCommandSet(value)] as const);
  const expandedGroupsEntries = Object.entries(snapshot.expandedGroups ?? {}).filter(([, expanded]) => typeof expanded === 'boolean');

  return {
    commandSets: Object.fromEntries(commandSetsEntries),
    expandedGroups: Object.fromEntries(expandedGroupsEntries),
  };
}

function parseImportPayload(json: string): CommandSet | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;

    const candidate = parsed as Record<string, unknown>;
    if (Array.isArray(candidate.groups) || Array.isArray(candidate.commands)) {
      return sanitizeCommandSet(candidate);
    }

    if (candidate.commands && typeof candidate.commands === 'object') {
      return sanitizeCommandSet(candidate.commands);
    }

    return null;
  } catch {
    return null;
  }
}

export const useCommandStore = create<CommandStore>((set, get) => ({
  commandSets: {},
  expandedGroups: {},
  selectedCommandId: null,
  selectedGroupId: null,
  savedConfigs: {},

  addCommand: (tagId, groupId, name, command) => {
    const commandId = crypto.randomUUID();
    set(state => {
      const commandSet = getCommandSet(state.commandSets, tagId);
      const validGroupId = groupId && commandSet.groups.some(group => group.id === groupId) ? groupId : null;
      const siblingCommandOrders = commandSet.commands.filter(c => c.groupId === validGroupId).map(c => c.order);
      const siblingGroupOrders = commandSet.groups.filter(g => g.parentGroupId === validGroupId).map(g => g.order);
      const nextOrder = Math.max(-1, ...siblingCommandOrders, ...siblingGroupOrders) + 1;
      commandSet.commands.push({
        id: commandId,
        name: name.trim() || 'New Command',
        command,
        groupId: validGroupId,
        order: nextOrder,
      });

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: commandSet,
        },
        selectedCommandId: commandId,
      };
    });
    return commandId;
  },

  updateCommand: (tagId, commandId, updates) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      const validGroupId = updates.groupId === undefined
        ? undefined
        : (updates.groupId && existing.groups.some(group => group.id === updates.groupId) ? updates.groupId : null);

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: {
            groups: existing.groups.map(group => ({ ...group })),
            commands: existing.commands.map(command => command.id === commandId
              ? {
                  ...command,
                  ...(updates.name !== undefined ? { name: updates.name.trim() || command.name } : {}),
                  ...(updates.command !== undefined ? { command: updates.command } : {}),
                  ...(validGroupId !== undefined ? { groupId: validGroupId } : {}),
                }
              : { ...command }),
          },
        },
      };
    });
  },

  removeCommand: (tagId, commandId) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: {
            groups: existing.groups.map(group => ({ ...group })),
            commands: existing.commands.filter(command => command.id !== commandId).map(command => ({ ...command })),
          },
        },
        selectedCommandId: state.selectedCommandId === commandId ? null : state.selectedCommandId,
      };
    });
  },

  addGroup: (tagId, name, parentGroupId = null) => {
    const groupId = crypto.randomUUID();
    set(state => {
      const commandSet = getCommandSet(state.commandSets, tagId);
      const validParentGroupId = parentGroupId && commandSet.groups.some(group => group.id === parentGroupId)
        ? parentGroupId
        : null;
      const siblingGroupOrders = commandSet.groups.filter(g => g.parentGroupId === validParentGroupId).map(g => g.order);
      const siblingCommandOrders = commandSet.commands.filter(c => c.groupId === validParentGroupId).map(c => c.order);
      const nextOrder = Math.max(-1, ...siblingGroupOrders, ...siblingCommandOrders) + 1;
      commandSet.groups.push({
        id: groupId,
        name: name.trim() || 'New Group',
        order: nextOrder,
        parentGroupId: validParentGroupId,
      });

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: commandSet,
        },
      };
    });
    return groupId;
  },

  updateGroup: (tagId, groupId, name) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: {
            groups: existing.groups.map(group => group.id === groupId
              ? { ...group, name: name.trim() || group.name }
              : { ...group }),
            commands: existing.commands.map(command => ({ ...command })),
          },
        },
      };
    });
  },

  removeGroup: (tagId, groupId) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      const groupIdsToRemove = new Set<string>();
      const collectDescendants = (targetGroupId: string) => {
        if (groupIdsToRemove.has(targetGroupId)) return;
        groupIdsToRemove.add(targetGroupId);
        existing.groups.forEach(group => {
          if (group.parentGroupId === targetGroupId) {
            collectDescendants(group.id);
          }
        });
      };

      collectDescendants(groupId);

      const expandedGroups = { ...state.expandedGroups };
      groupIdsToRemove.forEach(id => {
        delete expandedGroups[id];
      });

      const selectedCommandRemoved = existing.commands.some(command => state.selectedCommandId === command.id && command.groupId !== null && groupIdsToRemove.has(command.groupId));

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: {
            groups: existing.groups.filter(group => !groupIdsToRemove.has(group.id)).map(group => ({ ...group })),
            commands: existing.commands.filter(command => !command.groupId || !groupIdsToRemove.has(command.groupId)).map(command => ({ ...command })),
          },
        },
        expandedGroups,
        selectedCommandId: selectedCommandRemoved ? null : state.selectedCommandId,
        selectedGroupId: state.selectedGroupId && groupIdsToRemove.has(state.selectedGroupId) ? null : state.selectedGroupId,
      };
    });
  },

  toggleGroupExpanded: (groupId) => {
    set(state => ({
      expandedGroups: {
        ...state.expandedGroups,
        [groupId]: !state.expandedGroups[groupId],
      },
    }));
  },

  setSelectedCommand: (commandId) => {
    set({ selectedCommandId: commandId, selectedGroupId: null });
  },

  setSelectedGroup: (groupId) => {
    set({ selectedGroupId: groupId, selectedCommandId: null });
  },

  clearSelection: () => {
    set({ selectedCommandId: null, selectedGroupId: null });
  },

  exportCommands: (tagId) => {
    const commandSet = cloneCommandSet(get().commandSets[tagId] ?? emptyCommandSet());
    return JSON.stringify({
      version: 1,
      tagId,
      commands: commandSet,
    }, null, 2);
  },

  importCommands: (tagId, json) => {
    const parsed = parseImportPayload(json);
    if (!parsed) return false;

    set(state => ({
      commandSets: {
        ...state.commandSets,
        [tagId]: parsed,
      },
      selectedCommandId: null,
      selectedGroupId: null,
    }));
    return true;
  },

  getSnapshot: () => {
    const state = get();
    return {
      commandSets: Object.fromEntries(
        Object.entries(state.commandSets).map(([tagId, commandSet]) => [tagId, cloneCommandSet(commandSet)])
      ),
      expandedGroups: { ...state.expandedGroups },
      savedConfigs: JSON.parse(JSON.stringify(state.savedConfigs)),
    };
  },

  restoreSnapshot: (snapshot) => {
    const sanitized = sanitizeSnapshot(snapshot);
    set({
      commandSets: sanitized.commandSets,
      expandedGroups: sanitized.expandedGroups,
      savedConfigs: snapshot.savedConfigs ?? {},
      selectedCommandId: null,
      selectedGroupId: null,
    });
  },

  saveConfig: (tagId, name) => {
    const commandSet = cloneCommandSet(get().commandSets[tagId] ?? emptyCommandSet());
    const config: SavedConfig = {
      id: crypto.randomUUID(),
      name: name.trim() || `Config ${new Date().toLocaleString()}`,
      timestamp: Date.now(),
      data: commandSet,
    };
    set(state => {
      const existing = state.savedConfigs[tagId] ?? [];
      return {
        savedConfigs: {
          ...state.savedConfigs,
          [tagId]: [config, ...existing],
        },
      };
    });
  },

  loadConfig: (tagId, configId) => {
    const configs = get().savedConfigs[tagId] ?? [];
    const config = configs.find(c => c.id === configId);
    if (!config) return;
    set(state => ({
      commandSets: {
        ...state.commandSets,
        [tagId]: cloneCommandSet(config.data),
      },
      selectedCommandId: null,
      selectedGroupId: null,
    }));
  },

  deleteConfig: (tagId, configId) => {
    set(state => {
      const existing = state.savedConfigs[tagId] ?? [];
      return {
        savedConfigs: {
          ...state.savedConfigs,
          [tagId]: existing.filter(c => c.id !== configId),
        },
      };
    });
  },

  clearAllCommands: (tagId) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      const expandedGroups = { ...state.expandedGroups };
      existing.groups.forEach(group => {
        delete expandedGroups[group.id];
      });

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: emptyCommandSet(),
        },
        expandedGroups,
        selectedCommandId: null,
        selectedGroupId: null,
      };
    });
  },

  moveItem: (tagId, itemId, itemType, targetParentId, targetIndex) => {
    set(state => {
      const existing = state.commandSets[tagId];
      if (!existing) return {};

      const commandSet = cloneCommandSet(existing);

      if (itemType === 'command') {
        const command = commandSet.commands.find(c => c.id === itemId);
        if (!command) return {};

        // Validate target parent exists (or null for root)
        if (targetParentId !== null && !commandSet.groups.some(g => g.id === targetParentId)) return {};

        // Remove from old position: collect siblings at old parent, reorder them
        const oldParentId = command.groupId;
        command.groupId = targetParentId;

        // Recalculate orders for siblings at the target parent
        const targetSiblingCommands = commandSet.commands
          .filter(c => c.groupId === targetParentId && c.id !== itemId)
          .sort((a, b) => a.order - b.order);
        const targetSiblingGroups = commandSet.groups
          .filter(g => g.parentGroupId === targetParentId)
          .sort((a, b) => a.order - b.order);

        // Merge into a single ordered list, insert the moved item at targetIndex
        const merged: Array<{ id: string; type: 'command' | 'group' }> = [];
        const allSiblings = [
          ...targetSiblingCommands.map(c => ({ id: c.id, type: 'command' as const, order: c.order })),
          ...targetSiblingGroups.map(g => ({ id: g.id, type: 'group' as const, order: g.order })),
        ].sort((a, b) => a.order - b.order);

        allSiblings.forEach(s => merged.push({ id: s.id, type: s.type }));
        const clampedIndex = Math.max(0, Math.min(targetIndex, merged.length));
        merged.splice(clampedIndex, 0, { id: itemId, type: 'command' });

        // Assign new orders
        merged.forEach((item, index) => {
          if (item.type === 'command') {
            const cmd = commandSet.commands.find(c => c.id === item.id);
            if (cmd) cmd.order = index;
          } else {
            const grp = commandSet.groups.find(g => g.id === item.id);
            if (grp) grp.order = index;
          }
        });

        // Re-compact orders at old parent if different from target
        if (oldParentId !== targetParentId) {
          const oldSiblings = [
            ...commandSet.commands.filter(c => c.groupId === oldParentId).map(c => ({ id: c.id, type: 'command' as const, order: c.order })),
            ...commandSet.groups.filter(g => g.parentGroupId === oldParentId).map(g => ({ id: g.id, type: 'group' as const, order: g.order })),
          ].sort((a, b) => a.order - b.order);

          oldSiblings.forEach((item, index) => {
            if (item.type === 'command') {
              const cmd = commandSet.commands.find(c => c.id === item.id);
              if (cmd) cmd.order = index;
            } else {
              const grp = commandSet.groups.find(g => g.id === item.id);
              if (grp) grp.order = index;
            }
          });
        }
      } else {
        const group = commandSet.groups.find(g => g.id === itemId);
        if (!group) return {};

        // Prevent moving a group into itself or its descendants
        if (targetParentId !== null) {
          if (targetParentId === itemId) return {};
          const isDescendant = (parentId: string): boolean => {
            const parent = commandSet.groups.find(g => g.id === parentId);
            if (!parent || !parent.parentGroupId) return false;
            if (parent.parentGroupId === itemId) return true;
            return isDescendant(parent.parentGroupId);
          };
          if (isDescendant(targetParentId)) return {};
          if (!commandSet.groups.some(g => g.id === targetParentId)) return {};
        }

        const oldParentId = group.parentGroupId;
        group.parentGroupId = targetParentId;

        // Recalculate orders for siblings at the target parent
        const targetSiblingCommands = commandSet.commands
          .filter(c => c.groupId === targetParentId)
          .sort((a, b) => a.order - b.order);
        const targetSiblingGroups = commandSet.groups
          .filter(g => g.parentGroupId === targetParentId && g.id !== itemId)
          .sort((a, b) => a.order - b.order);

        const merged: Array<{ id: string; type: 'command' | 'group' }> = [];
        const allSiblings = [
          ...targetSiblingCommands.map(c => ({ id: c.id, type: 'command' as const, order: c.order })),
          ...targetSiblingGroups.map(g => ({ id: g.id, type: 'group' as const, order: g.order })),
        ].sort((a, b) => a.order - b.order);

        allSiblings.forEach(s => merged.push({ id: s.id, type: s.type }));
        const clampedIndex = Math.max(0, Math.min(targetIndex, merged.length));
        merged.splice(clampedIndex, 0, { id: itemId, type: 'group' });

        merged.forEach((item, index) => {
          if (item.type === 'command') {
            const cmd = commandSet.commands.find(c => c.id === item.id);
            if (cmd) cmd.order = index;
          } else {
            const grp = commandSet.groups.find(g => g.id === item.id);
            if (grp) grp.order = index;
          }
        });

        // Re-compact orders at old parent if different
        if (oldParentId !== targetParentId) {
          const oldSiblings = [
            ...commandSet.commands.filter(c => c.groupId === oldParentId).map(c => ({ id: c.id, type: 'command' as const, order: c.order })),
            ...commandSet.groups.filter(g => g.parentGroupId === oldParentId).map(g => ({ id: g.id, type: 'group' as const, order: g.order })),
          ].sort((a, b) => a.order - b.order);

          oldSiblings.forEach((item, index) => {
            if (item.type === 'command') {
              const cmd = commandSet.commands.find(c => c.id === item.id);
              if (cmd) cmd.order = index;
            } else {
              const grp = commandSet.groups.find(g => g.id === item.id);
              if (grp) grp.order = index;
            }
          });
        }
      }

      return {
        commandSets: {
          ...state.commandSets,
          [tagId]: commandSet,
        },
      };
    });
  },
}));
