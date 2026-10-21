import type { ScriptConfig } from '../../types';
import type { ScriptUiDocument } from './scriptTypes';

export interface ScriptUiPersistenceContext {
  variables?: Record<string, unknown>;
  runtime?: unknown;
  sources?: Record<string, unknown>;
  previousValues?: Record<string, unknown>;
  previousSourceRevisions?: Record<string, string>;
}

export interface PersistedScriptUiState {
  values: Record<string, unknown>;
  sourceRevisions: Record<string, string>;
}

export function readUiPath(source: unknown, path?: string): unknown {
  if (!path) return source;
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

export function setUiPath(
  source: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split('.').filter(Boolean);
  if (keys.length === 0) return source;
  const next = structuredClone(source);
  let current: Record<string, unknown> = next;
  keys.forEach((key, index) => {
    if (index === keys.length - 1) {
      current[key] = value;
      return;
    }
    const child = current[key];
    current[key] = child && typeof child === 'object' && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    current = current[key] as Record<string, unknown>;
  });
  return next;
}

export function mergeUiValues(
  defaults: Record<string, unknown>,
  persisted?: Record<string, unknown>,
): Record<string, unknown> {
  if (!persisted) return structuredClone(defaults);
  return deepMerge(defaults, persisted);
}

export function collectPersistedUiValues(
  ui: ScriptUiDocument,
  values: Record<string, unknown>,
  context: ScriptUiPersistenceContext = {},
): Record<string, unknown> {
  return collectPersistedUiState(ui, values, context).values;
}

export function collectPersistedUiState(
  ui: ScriptUiDocument,
  values: Record<string, unknown>,
  context: ScriptUiPersistenceContext = {},
): PersistedScriptUiState {
  let persisted: Record<string, unknown> = {};
  const sourceRevisions: Record<string, string> = {};
  const controlGroups = [ui.toolbar ?? [], ...Object.values(ui.regions).map((region) => region.controls)];
  for (const controls of controlGroups) {
    for (const control of controls) {
      if (!control.persist || !control.bind) continue;
      if (control.type === 'password') continue;

      if (control.type === 'testInputs') {
        const catalog = resolveUiSource(
          control.catalogSource,
          values,
          context.variables ?? {},
          context.runtime,
          context.sources,
        );
        rememberSourceRevision(
          sourceRevisions,
          control.catalogSource,
          catalog,
          context.previousSourceRevisions,
        );
        const safeInputs = collectSafeTestInputs(readUiPath(values, control.bind), catalog);
        if (safeInputs !== undefined) {
          persisted = setUiPath(persisted, control.bind, safeInputs);
        } else {
          const previous = readUiPath(context.previousValues, control.bind);
          if (previous !== undefined) persisted = setUiPath(persisted, control.bind, previous);
        }
        continue;
      }

      if (control.type === 'testCases') {
        const catalog = resolveUiSource(
          control.catalogSource,
          values,
          context.variables ?? {},
          context.runtime,
          context.sources,
        );
        rememberSourceRevision(
          sourceRevisions,
          control.catalogSource,
          catalog,
          context.previousSourceRevisions,
        );
        persisted = setUiPath(
          persisted,
          control.bind,
          collectValidTestCaseIds(readUiPath(values, control.bind), catalog),
        );
        continue;
      }
      persisted = setUiPath(persisted, control.bind, readUiPath(values, control.bind));
    }
  }
  return { values: persisted, sourceRevisions };
}

export function retainScriptUiStateForPath(
  current: Pick<ScriptConfig, 'luaPath' | 'yamlPath' | 'uiState'> | undefined,
  nextLuaPath: string,
): ScriptConfig['uiState'] {
  const currentPath = current?.luaPath ?? current?.yamlPath ?? '';
  return currentPath === nextLuaPath ? current?.uiState : undefined;
}

export function resolveUiSource(
  path: string | undefined,
  values: Record<string, unknown>,
  variables: Record<string, unknown>,
  runtime: unknown,
  sources: Record<string, unknown> = {},
): unknown {
  if (!path || path === 'runtime') return runtime;
  if (path.startsWith('values.')) return readUiPath(values, path.slice(7));
  if (path.startsWith('variables.')) return readUiPath(variables, path.slice(10));
  return readUiPath({ ...values, ...variables, ...sources, runtime }, path);
}

function deepMerge(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result = structuredClone(defaults);
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] = existing && value
      && typeof existing === 'object' && typeof value === 'object'
      && !Array.isArray(existing) && !Array.isArray(value)
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value);
  }
  return result;
}

function collectSafeTestInputs(value: unknown, catalog: unknown): Record<string, unknown> | undefined {
  if (!isRecord(catalog)) return undefined;
  if (!isRecord(value)) return {};

  const definitions = isRecord(catalog.inputDefinitions) ? catalog.inputDefinitions : {};
  return Object.fromEntries(Object.entries(value).filter(([name]) => {
    const definition = definitions[name];
    if (!isRecord(definition)) return true;
    return definition.type !== 'password' && definition.persist !== false;
  }));
}

function collectValidTestCaseIds(value: unknown, catalog: unknown): unknown {
  if (!Array.isArray(value) || !isRecord(catalog) || !Array.isArray(catalog.tests)) return value;
  const validNodeIds = new Set(catalog.tests.flatMap((test) => (
    isRecord(test) && typeof test.nodeId === 'string' ? [test.nodeId] : []
  )));
  return value.filter((nodeId): nodeId is string => typeof nodeId === 'string' && validNodeIds.has(nodeId));
}

function rememberSourceRevision(
  target: Record<string, string>,
  sourcePath: string,
  source: unknown,
  previous: Record<string, string> | undefined,
): void {
  if (isRecord(source) && typeof source.catalogRevision === 'string') {
    target[sourcePath] = source.catalogRevision;
  } else if (previous?.[sourcePath]) {
    target[sourcePath] = previous[sourcePath];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
