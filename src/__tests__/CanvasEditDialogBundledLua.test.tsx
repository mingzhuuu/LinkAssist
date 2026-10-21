import { invoke } from '@tauri-apps/api/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasEditDialog } from '../components/display/CanvasEditDialog';
import { useBleStore, useCanvasStore, useChannelStore, useUIStore } from '../stores';
import type { Canvas } from '../types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const canvasId = 'bundled-canvas';

function installCanvas(canvas: Canvas): void {
  useCanvasStore.setState({
    canvases: [canvas],
    nextZIndex: 2,
    dataBuffers: { [canvas.id]: [] },
    chartViewState: { [canvas.id]: { paused: false } },
  });
}

function baseCanvas(config: Canvas['config']): Canvas {
  return {
    id: canvasId,
    name: 'Bundled',
    groupId: null,
    rect: { x: 0, y: 0, width: 600, height: 400 },
    savedRect: null,
    savedSnapped: null,
    zIndex: 1,
    active: false,
    activationMode: 'manual-off',
    maximized: false,
    snapped: false,
    config,
  };
}

describe('CanvasEditDialog bundled Lua sources', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command) => {
      if (command === 'parse_lua_automation_file') {
        return { version: 1, name: 'Bundled automation', steps: [] };
      }
      if (command === 'parse_lua_canvas_lifecycle_file') {
        return { version: 1, name: 'Bundled lifecycle', onActivate: [{ action: 'log', message: 'ready' }] };
      }
      if (command === 'get_lua_protocol_file_summary') {
        return { name: 'Bundled protocol', fields: [] };
      }
      return undefined;
    });
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useChannelStore.setState(useChannelStore.getInitialState(), true);
    useBleStore.setState(useBleStore.getInitialState(), true);
    useUIStore.setState(useUIStore.getInitialState(), true);
  });

  afterEach(() => cleanup());

  it('hides the automation Lua path and browse control', async () => {
    installCanvas(baseCanvas({
      type: 'script',
      dataSource: 'raw',
      channels: [],
      script: {
        sourceType: 'file',
        luaPath: 'C:/snapshot/internal/bench.lua',
        bundled: true,
      },
    }));

    render(<CanvasEditDialog open canvasId={canvasId} onClose={() => {}} />);

    await screen.findByText(/Bundled Lua automation script/);
    expect(screen.queryByText('Lua File Path')).toBeNull();
    expect(screen.queryByText('C:/snapshot/internal/bench.lua')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull();
    expect(useCanvasStore.getState().canvases[0]?.config.script).toMatchObject({
      luaPath: 'C:/snapshot/internal/bench.lua',
      bundled: true,
    });
  });

  it('locks lifecycle and protocol Lua sources without showing their paths', async () => {
    useChannelStore.getState().addChannel('serial', 'Torque', 'serial-1');
    installCanvas(baseCanvas({
      type: 'table',
      dataSource: 'parsed',
      channels: [{
        channelId: 'serial-1',
        protocolTemplateId: null,
        protocolFile: 'C:/snapshot/internal/protocol.lua',
        protocolResourceRoot: 'C:/snapshot/internal/protocol-resources',
        protocolBundled: true,
      }],
      table: { columns: [] },
      lifecycleScript: {
        sourceType: 'file',
        luaPath: 'C:/snapshot/internal/canvas-lifecycle-bench.lua',
        bundled: true,
        enabled: true,
      },
    }));

    render(<CanvasEditDialog open canvasId={canvasId} onClose={() => {}} />);

    await screen.findByText(/Bundled Lua lifecycle script/);
    const bundledProtocol = screen.getByRole('button', { name: 'Bundled' }) as HTMLButtonElement;
    expect(bundledProtocol.disabled).toBe(true);
    expect(screen.queryByText('Lua File Path')).toBeNull();
    expect(screen.queryByText('C:/snapshot/internal/protocol.lua')).toBeNull();
    expect(screen.queryByText('C:/snapshot/internal/protocol-resources')).toBeNull();
    expect(screen.queryByText('C:/snapshot/internal/canvas-lifecycle-bench.lua')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select root' })).toBeNull();
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(useCanvasStore.getState().canvases[0]?.config).toMatchObject({
      channels: [{
        protocolFile: 'C:/snapshot/internal/protocol.lua',
        protocolBundled: true,
      }],
      lifecycleScript: {
        luaPath: 'C:/snapshot/internal/canvas-lifecycle-bench.lua',
        bundled: true,
      },
    });
  });
});
