import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickScriptDirectory, ScriptToolbarButton } from '../components/display/CanvasScript';
import type { ScriptRuntimeSnapshot, ScriptUiButtonControl } from '../components/display/scriptTypes';

afterEach(cleanup);

const idleSnapshot: ScriptRuntimeSnapshot = {
  status: 'idle',
  scriptName: 'dashboard',
  currentStepIndex: -1,
  steps: [],
  logs: [],
  variables: {},
};

describe('Script toolbar buttons', () => {
  it('switches Load to Reload after its source is available', () => {
    const control: ScriptUiButtonControl = {
      id: 'load',
      type: 'button',
      label: 'Load',
      loadedLabel: 'Reload',
      loadedSource: 'catalog',
      action: 'loadCatalog',
      reloadDocument: true,
    };
    const onAction = vi.fn();
    const view = render(
      <ScriptToolbarButton control={control} values={{}} snapshot={idleSnapshot} loading={false} onAction={onAction} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(onAction).toHaveBeenCalledWith('loadCatalog', { reloadDocument: true });

    view.rerender(
      <ScriptToolbarButton
        control={control}
        values={{}}
        snapshot={{ ...idleSnapshot, variables: { catalog: { tests: [] } } }}
        loading={false}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('switches Run to Stop only while the configured handler is active', () => {
    const onAction = vi.fn();
    render(
      <ScriptToolbarButton
        control={{
          id: 'run',
          type: 'button',
          label: 'Run',
          action: 'runTests',
          runningHandler: 'runTests',
          runningLabel: 'Stop',
          runningAction: '$stop',
        }}
        values={{}}
        snapshot={{ ...idleSnapshot, status: 'running', activeHandler: 'runTests' }}
        loading={false}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onAction).toHaveBeenCalledWith('$stop', {});
  });

  it('integrates project-root selection into the Load action', async () => {
    const pickDirectory = vi.fn().mockResolvedValue('D:/Workspace/project');
    await expect(pickScriptDirectory(
      { form: { projectRoot: 'D:/Workspace/old' } },
      'form.projectRoot',
      pickDirectory,
    )).resolves.toEqual({ form: { projectRoot: 'D:/Workspace/project' } });
    expect(pickDirectory).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: 'D:/Workspace/old',
    });

    const onAction = vi.fn();
    render(
      <ScriptToolbarButton
        control={{
          id: 'load',
          type: 'button',
          label: 'Load',
          action: 'loadCatalog',
          bind: 'form.projectRoot',
          directoryPicker: true,
          reloadDocument: true,
        }}
        values={{ form: { projectRoot: '' } }}
        snapshot={idleSnapshot}
        loading={false}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(onAction).toHaveBeenCalledWith('loadCatalog', {
      reloadDocument: true,
      directoryBind: 'form.projectRoot',
    });
  });
});
