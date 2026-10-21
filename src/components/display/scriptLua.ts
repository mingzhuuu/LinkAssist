import { invoke } from '@tauri-apps/api/core';
import type { ScriptDocument } from './scriptTypes';

export function normalizeScriptDocument(document: ScriptDocument): ScriptDocument {
  const version = Number(document.version ?? 1);
  if (!Number.isFinite(version) || version < 1) throw new Error('version must be a positive number');

  const name = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : 'Automation Script';
  return {
    ...document,
    version,
    name,
    setup: document.setup ?? [],
    steps: document.steps ?? [],
    onStop: document.onStop ?? [],
    teardown: document.teardown ?? [],
  };
}

export function normalizeCanvasLifecycleDocument(document: ScriptDocument): ScriptDocument {
  const version = Number(document.version ?? 1);
  if (!Number.isFinite(version) || version < 1) throw new Error('version must be a positive number');

  const name = typeof document.name === 'string' && document.name.trim() ? document.name.trim() : 'Canvas Lifecycle Script';
  return {
    ...document,
    version,
    name,
    setup: document.setup ?? [],
    onActivate: document.onActivate ?? [],
    whileActive: document.whileActive,
    onDeactivate: document.onDeactivate ?? [],
    teardown: document.teardown ?? [],
  };
}

export async function parseScriptLua(content: string): Promise<ScriptDocument> {
  const document = await invoke<ScriptDocument>('parse_lua_automation_script', { content });
  return normalizeScriptDocument(document);
}

export async function parseScriptLuaFile(path: string): Promise<ScriptDocument> {
  const document = await invoke<ScriptDocument>('parse_lua_automation_file', { path });
  return { ...normalizeScriptDocument(document), sourcePath: path };
}

export async function parseCanvasLifecycleLuaFile(path: string): Promise<ScriptDocument> {
  const document = await invoke<ScriptDocument>('parse_lua_canvas_lifecycle_file', { path });
  return { ...normalizeCanvasLifecycleDocument(document), sourcePath: path };
}
