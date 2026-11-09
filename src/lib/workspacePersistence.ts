let save: (() => Promise<void>) | null = null;
export function registerWorkspaceSave(callback: () => Promise<void>) {
  save = callback;
  return () => { if (save === callback) save = null; };
}
export async function flushWorkspaceSave() { await save?.(); }
