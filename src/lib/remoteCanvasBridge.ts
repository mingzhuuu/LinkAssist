import type { ScriptRuntimeSnapshot, ScriptUiDocument } from '../components/display/scriptTypes';

export type RemoteCanvasView = {
  kind: 'script';
  ui: ScriptUiDocument | null;
  values: Record<string, unknown>;
  sources: Record<string, unknown>;
  snapshot: ScriptRuntimeSnapshot;
  error: string;
} | {
  kind: 'form';
  values: Record<string, string>;
  status: string;
};

interface CanvasBridge {
  view: () => RemoteCanvasView;
  action: (action: string, args: Record<string, unknown>) => Promise<void>;
}

// UI-owned actions remain in the mounted host component. The remote window only
// renders snapshots; it never creates a second automation runtime.
const bridges = new Map<string, CanvasBridge>();

export function registerRemoteCanvas(id: string, bridge: CanvasBridge): () => void {
  bridges.set(id, bridge);
  return () => { if (bridges.get(id) === bridge) bridges.delete(id); };
}

export function remoteCanvasView(id: string): RemoteCanvasView | null { return bridges.get(id)?.view() ?? null; }

export async function remoteCanvasAction(id: string, action: string, args: Record<string, unknown>): Promise<void> {
  const bridge = bridges.get(id);
  if (!bridge) throw new Error('Open this canvas on the host before controlling it remotely');
  await bridge.action(action, args);
}
