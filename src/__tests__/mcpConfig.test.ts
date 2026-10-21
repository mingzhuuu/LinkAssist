import { describe, expect, it } from 'vitest';
import {
  getPersistedMcpToolsConfig,
  normalizeMcpToolScript,
  normalizeMcpToolsConfig,
} from '../types/mcp';

describe('MCP protocol binding persistence', () => {
  it('keeps the adapter path and external resource root across load and save', () => {
    const loaded = normalizeMcpToolScript({
      luaPath: 'D:/support/flows.lua',
      exposeToMcp: true,
      protocolFile: 'D:/support/protocol.lua',
      protocolResourceRoot: 'D:/project/protocol-data',
    });

    expect(loaded).toMatchObject({
      protocolFile: 'D:/support/protocol.lua',
      protocolResourceRoot: 'D:/project/protocol-data',
    });
    expect(getPersistedMcpToolsConfig(true, loaded ? [loaded] : []).scripts[0]).toMatchObject({
      protocolFile: 'D:/support/protocol.lua',
      protocolResourceRoot: 'D:/project/protocol-data',
    });
  });

  it('defaults old configurations to enabled and persists a disabled state', () => {
    expect(normalizeMcpToolsConfig({ scripts: [] })?.enabled).toBe(true);
    expect(getPersistedMcpToolsConfig(false, []).enabled).toBe(false);
  });
});
