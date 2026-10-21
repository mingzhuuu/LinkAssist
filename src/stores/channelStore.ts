import { create } from 'zustand';
import { Channel, ChannelType, ChannelState } from '../types';

interface ChannelStore {
  channels: Channel[];
  activeChannelId: string | null;
  addChannel: (type: ChannelType, name: string, id?: string) => string;
  restoreChannels: (channels: Array<Pick<Channel, 'id' | 'type' | 'name'>>) => void;
  removeChannel: (id: string) => void;
  renameChannel: (id: string, name: string) => void;
  reorderChannel: (sourceId: string, targetId: string) => void;
  setActiveChannel: (id: string | null) => void;
  updateChannelState: (id: string, state: ChannelState) => void;
}

export const useChannelStore = create<ChannelStore>((set) => ({
  channels: [],
  activeChannelId: null,
  addChannel: (type, name, id = crypto.randomUUID()) => {
    set((state) => {
      if (state.channels.some((channel) => channel.id === id)) {
        return state;
      }

      return {
        channels: [
          ...state.channels,
          {
            id,
            type,
            name,
            state: 'disconnected',
            createdAt: Date.now(),
          },
        ],
      };
    });
    return id;
  },
  restoreChannels: (restoredChannels) =>
    set((state) => {
      const existingChannels = new Map(state.channels.map((channel) => [channel.id, channel]));
      const restoredIds = new Set<string>();
      const channels: Channel[] = [];

      for (const restored of restoredChannels) {
        if (restoredIds.has(restored.id)) continue;
        restoredIds.add(restored.id);

        const existing = existingChannels.get(restored.id);
        channels.push({
          ...restored,
          state: existing?.type === restored.type ? existing.state : 'disconnected',
          createdAt: existing?.createdAt ?? Date.now(),
        });
      }

      return {
        channels,
        activeChannelId: state.activeChannelId && restoredIds.has(state.activeChannelId)
          ? state.activeChannelId
          : null,
      };
    }),
  removeChannel: (id) =>
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== id),
      activeChannelId: state.activeChannelId === id ? null : state.activeChannelId,
    })),
  renameChannel: (id, name) =>
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === id ? { ...c, name: name.trim() || c.name } : c
      ),
    })),
  reorderChannel: (sourceId, targetId) =>
    set((state) => {
      if (sourceId === targetId) return state;

      const sourceIndex = state.channels.findIndex((channel) => channel.id === sourceId);
      const targetIndex = state.channels.findIndex((channel) => channel.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return state;

      const nextChannels = [...state.channels];
      const [sourceChannel] = nextChannels.splice(sourceIndex, 1);
      nextChannels.splice(targetIndex, 0, sourceChannel);

      return { channels: nextChannels };
    }),
  setActiveChannel: (id) => set({ activeChannelId: id }),
  updateChannelState: (id, channelState) =>
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === id ? { ...c, state: channelState } : c
      ),
    })),
}));
