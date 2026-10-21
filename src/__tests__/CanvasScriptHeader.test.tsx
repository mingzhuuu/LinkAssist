import { invoke } from '@tauri-apps/api/core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasScript } from '../components/display/CanvasScript';
import { disposeScriptRuntime, getScriptRuntime } from '../components/display/scriptRuntime';
import type { ScriptDocument } from '../components/display/scriptTypes';
import { useCanvasStore, useChannelStore } from '../stores';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const canvasId = 'measure-script-canvas';

describe('CanvasScript header layout', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    disposeScriptRuntime(canvasId);
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useChannelStore.setState(useChannelStore.getInitialState(), true);

    const initial = useCanvasStore.getState();
    useCanvasStore.setState({
      canvases: [{
        id: canvasId,
        name: '',
        groupId: null,
        rect: { x: 0, y: 0, width: 900, height: 500 },
        savedRect: null,
        savedSnapped: null,
        zIndex: 1,
        active: false,
        activationMode: 'manual-off',
        maximized: false,
        snapped: false,
        config: {
          type: 'script',
          dataSource: 'raw',
          channels: [],
          table: { columns: [] },
          script: {
            sourceType: 'file',
            luaPath: 'D:/measure.lua',
            stopOnFailure: true,
            defaultTimeoutMs: 2000,
            defaultDataFormat: 'hex',
            logLimit: 500,
          },
        },
      }],
      nextZIndex: initial.nextZIndex + 1,
      dataBuffers: { [canvasId]: [] },
      chartViewState: { [canvasId]: { paused: false } },
    });
  });

  afterEach(() => {
    cleanup();
    disposeScriptRuntime(canvasId);
  });

  it('starts with the loop control when script header information is hidden', async () => {
    const document: ScriptDocument = {
      version: 1,
      name: '测表',
      variables: { form: { loop: false } },
      ui: {
        schemaVersion: 1,
        showHeaderInfo: false,
        toolbar: [{
          id: 'loop',
          type: 'checkbox',
          label: '循环测试',
          bind: 'form.loop',
        }],
        layout: { preset: 'top-bottom', regions: ['source', 'result'] },
        regions: {
          source: { controls: [] },
          result: { controls: [] },
        },
      },
      handlers: { runCsv: [] },
    };
    invokeMock.mockResolvedValue(document);

    render(<CanvasScript canvasId={canvasId} />);

    await waitFor(() => expect(screen.getByText('循环测试')).toBeTruthy());
    expect(screen.queryByText('测表')).toBeNull();
  });

  it('pushes toolbar controls marked align end to the right edge', async () => {
    const document: ScriptDocument = {
      version: 1,
      name: '测表',
      variables: { form: { loop: false } },
      ui: {
        schemaVersion: 1,
        showHeaderInfo: false,
        toolbar: [
          { id: 'loop', type: 'checkbox', label: '循环测试', bind: 'form.loop' },
          { id: 'motor', type: 'select', label: '电机', bind: 'form.motorChannelId', allowEmpty: false, options: [{ value: 'c1', label: 'COM4' }] },
          { id: 'run', type: 'button', label: '运行', action: 'runCsv', variant: 'primary', align: 'end' },
        ],
        layout: { preset: 'top-bottom', regions: ['source', 'result'] },
        regions: {
          source: { controls: [] },
          result: { controls: [] },
        },
      },
      handlers: { runCsv: [] },
    };
    invokeMock.mockResolvedValue(document);

    render(<CanvasScript canvasId={canvasId} />);

    const runButton = await waitFor(() => {
      const button = screen.getByText('运行').closest('button');
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    expect(runButton.className).toContain('ml-auto');
    expect(screen.getByText('循环测试').closest('label')?.className).not.toContain('ml-auto');
    expect(screen.getByRole('option', { name: 'COM4' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Select…' })).toBeNull();
  });

  it('runs the declared restore handler once after persisted values are loaded', async () => {
    useCanvasStore.setState((state) => ({
      canvases: state.canvases.map((canvas) => ({
        ...canvas,
        config: {
          ...canvas.config,
          script: {
            ...canvas.config.script!,
            uiState: {
              stateVersion: 'pytest-v1',
              values: { form: { projectRoot: 'D:/project' } },
            },
          },
        },
      })),
    }));
    const document: ScriptDocument = {
      version: 1,
      name: 'Tests',
      variables: { form: { projectRoot: '' } },
      ui: {
        schemaVersion: 1,
        stateVersion: 'pytest-v1',
        restore: { action: 'loadCatalog', whenBind: 'form.projectRoot' },
        layout: { preset: 'left-right', regions: ['left', 'right'] },
        regions: { left: { controls: [] }, right: { controls: [] } },
      },
      handlers: { loadCatalog: [{ action: 'delay', durationMs: 1 }] },
    };
    invokeMock.mockResolvedValue(document);

    render(<CanvasScript canvasId={canvasId} />);

    await waitFor(() => expect(getScriptRuntime(canvasId).getSnapshot().status).toBe('passed'));
  });
});
