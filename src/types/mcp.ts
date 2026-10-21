export function hasMcpToolLuaPath(filePath: string): boolean {
  return filePath.trim().length > 0;
}

export interface PersistedMcpToolScript {
  luaPath: string;
  exposeToMcp: boolean;
  protocolFile?: string | null;
  protocolResourceRoot?: string | null;
}

export interface McpToolScript {
  id: string;
  exposeToMcp: boolean;
  luaPath: string;
  protocolFile?: string | null;
  protocolResourceRoot?: string | null;
}

export interface McpToolsConfig {
  enabled: boolean;
  scripts: PersistedMcpToolScript[];
}

export interface McpToolMetaPreview {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  protocolFile?: string | null;
}

export interface McpToolScriptPreview {
  tools: McpToolMetaPreview[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeMcpToolScript(value: unknown): McpToolScript | null {
  if (!isRecord(value)) return null;

  const luaPath = typeof value.luaPath === 'string' ? value.luaPath.trim() : '';
  const exposeToMcp = typeof value.exposeToMcp === 'boolean' && hasMcpToolLuaPath(luaPath)
    ? value.exposeToMcp
    : false;

  return {
    id: typeof value.id === 'string' && value.id.length > 0 ? value.id : crypto.randomUUID(),
    luaPath,
    exposeToMcp,
    protocolFile: typeof value.protocolFile === 'string' ? value.protocolFile : null,
    protocolResourceRoot: typeof value.protocolResourceRoot === 'string'
      ? value.protocolResourceRoot
      : null,
  };
}

export function normalizeMcpToolsConfig(value: unknown): McpToolsConfig | null {
  if (!isRecord(value) || !Array.isArray(value.scripts)) return null;

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    scripts: value.scripts
      .map(normalizeMcpToolScript)
      .filter((script): script is McpToolScript => script !== null),
  };
}

export function getPersistedMcpToolsConfig(enabled: boolean, scripts: McpToolScript[]): McpToolsConfig {
  return {
    enabled,
    scripts: scripts.map((script) => {
      const luaPath = script.luaPath.trim();
      return {
        luaPath,
        exposeToMcp: hasMcpToolLuaPath(luaPath) ? script.exposeToMcp : false,
        protocolFile: script.protocolFile ?? null,
        protocolResourceRoot: script.protocolResourceRoot ?? null,
      };
    }),
  };
}
