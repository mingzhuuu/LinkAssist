const FILE_KEYS = new Set(['luaPath', 'yamlPath', 'protocolFile', 'protocolResourceRoot', 'csvPath', 'projectRoot']);

/** Resolve portable layout resource references against the selected JSON file, never the process cwd. */
export function resolveLayoutPaths<T>(value: T, layoutFile: string): T {
  const normalized = layoutFile.replace(/\\/g, '/');
  const parent = normalized.slice(0, normalized.lastIndexOf('/'));
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => {
      if (FILE_KEYS.has(key) && typeof child === 'string' && child.trim()
        && !/^(?:[A-Za-z]:|\/|\\|[a-z][a-z\d+.-]*:)/i.test(child)) {
        const parts: string[] = [];
        for (const part of `${parent}/${child.replace(/\\/g, '/')}`.split('/')) {
          if (part === '.') continue;
          if (part === '..' && parts.length > 1) parts.pop();
          else if (part !== '..') parts.push(part);
        }
        return [key, parts.join('/')];
      }
      return [key, visit(child)];
    }));
  };
  return visit(value) as T;
}
