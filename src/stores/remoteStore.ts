import { create } from 'zustand';
import type { RemoteWorkspaceSnapshot } from '../types/remote';

/** Session state only; controller snapshots never enter local persistence. */
export const useRemoteStore = create<{
  active: boolean;
  connected: boolean;
  name: string;
  controller: { id: string; name: string } | null;
  snapshot: RemoteWorkspaceSnapshot | null;
  error: string;
}>(() => ({ active: false, connected: false, name: '', controller: null, snapshot: null, error: '' }));

export const isRemoteWorkspace = () => useRemoteStore.getState().active;
