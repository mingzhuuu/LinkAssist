import { create } from 'zustand';
import type { McpToolScript } from '../types';

interface McpStore {
  enabled: boolean;
  scripts: McpToolScript[];
  setEnabled: (enabled: boolean) => void;
  addScript: () => string;
  updateScript: (id: string, patch: Partial<McpToolScript>) => void;
  removeScript: (id: string) => void;
  setScripts: (scripts: McpToolScript[]) => void;
  reset: () => void;
}

function createDefaultScript(): McpToolScript {
  const id = crypto.randomUUID();
  return {
    id,
    exposeToMcp: false,
    luaPath: '',
  };
}

export const useMcpStore = create<McpStore>((set) => ({
  enabled: true,
  scripts: [],
  setEnabled: (enabled) => set((state) => (
    state.enabled === enabled ? state : { enabled }
  )),
  addScript: () => {
    const script = createDefaultScript();
    set((state) => ({ scripts: [...state.scripts, script] }));
    return script.id;
  },
  updateScript: (id, patch) => set((state) => ({
    scripts: state.scripts.map((script) => (
      script.id === id ? { ...script, ...patch } : script
    )),
  })),
  removeScript: (id) => set((state) => ({
    scripts: state.scripts.filter((script) => script.id !== id),
  })),
  setScripts: (scripts) => set({ scripts }),
  reset: () => set({ enabled: true, scripts: [] }),
}));
