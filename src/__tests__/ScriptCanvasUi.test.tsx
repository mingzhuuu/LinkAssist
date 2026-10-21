import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatStepTimestamp, ScriptCanvasUi } from '../components/display/ScriptCanvasUi';
import type { ScriptRuntimeSnapshot, ScriptUiDocument } from '../components/display/scriptTypes';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

const openFileDialogMock = vi.mocked(openFileDialog);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ScriptCanvasUi', () => {
  it('shows every channel listed for the selected type, including closed channels', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [{
          id: 'motor',
          type: 'select',
          label: 'Motor',
          bind: 'form.motorChannelId',
          options: { source: 'app.channels.serial', valuePath: 'id', labelPath: 'name' },
        }] },
        bottom: { controls: [] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { motorChannelId: 'serial-closed' } }}
        sources={{
          app: {
            allChannels: [
              { id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' },
              { id: 'serial-closed', name: 'COM9', type: 'serial', state: 'disconnected' },
            ],
            channels: {
              serial: [
                { id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' },
                { id: 'serial-closed', name: 'COM9', type: 'serial', state: 'disconnected' },
              ],
            },
            openChannels: {
              serial: [{ id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' }],
            },
          },
        }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByRole('option', { name: 'COM4' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'COM9' })).toHaveProperty('disabled', false);
  });

  it('lets editable channel selects accept a typed COM port or a listed channel', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [{
          id: 'motor',
          type: 'select',
          label: 'Motor',
          bind: 'form.motorChannelId',
          editable: true,
          placeholder: '选择或输入 COM 口',
          options: { source: 'app.channels.serial', valuePath: 'id', labelPath: 'name' },
        }] },
        bottom: { controls: [] },
      },
    };
    const onValuesChange = vi.fn();

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { motorChannelId: 'serial-open' } }}
        sources={{
          app: {
            allChannels: [
              { id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' },
              { id: 'serial-closed', name: 'COM9', type: 'serial', state: 'disconnected' },
            ],
            channels: {
              serial: [
                { id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' },
                { id: 'serial-closed', name: 'COM9', type: 'serial', state: 'disconnected' },
              ],
            },
          },
        }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={onValuesChange}
        onAction={() => undefined}
      />,
    );

    const input = screen.getByPlaceholderText('选择或输入 COM 口') as HTMLInputElement;
    expect(input.value).toBe('COM4');
    fireEvent.change(input, { target: { value: 'COM7' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({ form: { motorChannelId: 'COM7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle options' }));
    fireEvent.click(screen.getByRole('button', { name: 'COM9' }));
    expect(onValuesChange).toHaveBeenLastCalledWith({ form: { motorChannelId: 'serial-closed' } });
  });

  it('hides the leading empty Select… choice when allowEmpty is false', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [
          {
            id: 'motor',
            type: 'select',
            label: 'Motor',
            bind: 'form.motorChannelId',
            editable: true,
            allowEmpty: false,
            placeholder: '选择或输入 COM 口',
            options: { source: 'app.channels.serial', valuePath: 'id', labelPath: 'name' },
          },
          {
            id: 'teeth',
            type: 'select',
            label: '齿数',
            bind: 'form.torqueTeeth',
            allowEmpty: false,
            options: [
              { value: '1024', label: '1024' },
              { value: '60', label: '60' },
            ],
          },
          {
            id: 'profile',
            type: 'select',
            label: 'Profile',
            bind: 'form.profile',
            options: [{ value: 'p1', label: 'Profile 1' }],
          },
        ] },
        bottom: { controls: [] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { motorChannelId: '', torqueTeeth: '1024', profile: 'p1' } }}
        sources={{
          app: {
            channels: {
              serial: [{ id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' }],
            },
          },
        }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByDisplayValue('1024').querySelector('option[value=""]')).toBeNull();
    expect(screen.getByDisplayValue('Profile 1').querySelector('option[value=""]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle options' }));
    expect(screen.getByRole('button', { name: 'COM4' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select…' })).toBeNull();
  });

  it('keeps the leading empty Select… choice by default', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [{
          id: 'motor',
          type: 'select',
          label: 'Motor',
          bind: 'form.motorChannelId',
          editable: true,
          placeholder: '选择或输入 COM 口',
          options: { source: 'app.channels.serial', valuePath: 'id', labelPath: 'name' },
        }] },
        bottom: { controls: [] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { motorChannelId: '' } }}
        sources={{
          app: {
            channels: {
              serial: [{ id: 'serial-open', name: 'COM4', type: 'serial', state: 'connected' }],
            },
          },
        }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle options' }));
    expect(screen.getByRole('button', { name: 'Select…' })).toBeTruthy();
  });

  it('restricts a script file picker to its declared extensions', async () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [{ id: 'csv', type: 'file', label: 'Control CSV', bind: 'form.csvPath', extensions: ['csv'] }] },
        bottom: { controls: [] },
      },
    };
    openFileDialogMock.mockResolvedValue(null);

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { csvPath: 'D:/commands.csv' } }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    await waitFor(() => expect(openFileDialogMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      defaultPath: 'D:/commands.csv',
      filters: [{ name: 'Control CSV', extensions: ['csv'] }],
    }));
  });

  it('renders the two-region pytest dashboard and updates checked node ids', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'left-right', regions: ['selection', 'results'] },
      regions: {
        selection: {
          title: 'Selection',
          controls: [
            { id: 'cases', type: 'testCases', label: 'Test cases', bind: 'form.nodeIds', catalogSource: 'catalog' },
            { id: 'run', type: 'button', label: 'Run tests', action: 'runTests', variant: 'primary' },
          ],
        },
        results: { title: 'Results', controls: [{ id: 'logs', type: 'logViewer', label: 'Logs' }] },
      },
    };
    const snapshot: ScriptRuntimeSnapshot = {
      status: 'idle',
      scriptName: 'dashboard',
      currentStepIndex: -1,
      steps: [],
      logs: [],
      variables: {
        catalog: {
          schemaVersion: 1,
          runnerId: 'fixture',
          title: 'Fixture',
          profiles: [],
          tests: [{
            nodeId: 'tests/test_one.py::test_one',
            id: 'one',
            title: 'One test',
            kind: 'unit',
            tags: ['fast'],
            requires: [],
            file: 'tests/test_one.py',
            danger: 'safe',
          }],
        },
      },
    };
    const onValuesChange = vi.fn();
    const onAction = vi.fn();

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { nodeIds: [] } }}
        snapshot={snapshot}
        onValuesChange={onValuesChange}
        onAction={onAction}
      />,
    );

    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.className).toContain('w-1');
    expect(separator.className).toContain('bg-transparent');
    expect(separator.firstElementChild?.className).toContain('w-px');
    const testCasesLabel = screen.getByText('Test cases');
    expect(testCasesLabel.parentElement?.textContent).toContain('0 selected / 1 visible');
    fireEvent.click(screen.getByText('One test'));
    expect(onValuesChange).toHaveBeenCalledWith({ form: { nodeIds: ['tests/test_one.py::test_one'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Run tests' }));
    expect(onAction).toHaveBeenCalledWith('runTests');
  });

  it('renders live test execution above the theme-aware log frame without history', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [] },
        bottom: { controls: [
          { id: 'progress', type: 'runSummary', source: 'lastRun' },
          { id: 'logs', type: 'logViewer', grow: true },
        ] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{}}
        snapshot={{
          status: 'idle',
          scriptName: 'dashboard',
          currentStepIndex: -1,
          steps: [],
          logs: [],
          variables: {
            lastRun: {
              runId: 'run-1',
              status: 'running',
              projectRoot: 'D:/project',
              nodeIds: ['tests/test_one.py::test_one', 'tests/test_two.py::test_two'],
              logs: [
                { runId: 'run-1', seq: 1, eventType: 'test-start', timestamp: 1, nodeId: 'tests/test_one.py::test_one' },
                { runId: 'run-1', seq: 2, eventType: 'test-result', timestamp: 2, nodeId: 'tests/test_one.py::test_one', outcome: 'passed' },
                { runId: 'run-1', seq: 3, eventType: 'test-start', timestamp: 3, nodeId: 'tests/test_two.py::test_two' },
              ],
            },
          },
        }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(screen.queryByText('History')).toBeNull();
    expect(screen.queryByRole('button', { name: /run history/i })).toBeNull();
    const separator = screen.getByRole('separator');
    expect(separator.getAttribute('aria-orientation')).toBe('horizontal');
    expect(separator.className).toContain('h-1');
    expect(separator.firstElementChild?.className).toContain('h-px');
    expect(screen.getByText('Test execution')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('Running tests/test_two.py::test_two')).toBeTruthy();
    const controls = Array.from(document.querySelectorAll('[data-script-control]'));
    expect(controls.map((element) => element.getAttribute('data-script-control'))).toEqual(['progress', 'logs']);
    const progressControl = document.querySelector('[data-script-control="progress"]');
    const logControl = document.querySelector('[data-script-control="logs"]');
    expect(progressControl?.innerHTML).toContain('bg-surface-secondary');
    expect(logControl?.innerHTML).toContain('bg-surface-secondary');
    expect(logControl?.innerHTML).not.toContain('#0d1017');
  });

  it('keeps an error-only log viewer hidden until an error is recorded', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [] },
        bottom: { controls: [{
          id: 'logs',
          type: 'logViewer',
          grow: true,
          errorOnly: true,
          hideWhenEmpty: true,
        }] },
      },
    };
    const snapshot = (logs: ScriptRuntimeSnapshot['logs']): ScriptRuntimeSnapshot => ({
      status: 'running',
      scriptName: 'meter bench',
      currentStepIndex: -1,
      steps: [],
      logs,
    });
    const props = {
      ui,
      values: {},
      onValuesChange: () => undefined,
      onAction: () => undefined,
    };

    const { rerender } = render(
      <ScriptCanvasUi
        {...props}
        snapshot={snapshot([{
          id: 'info', timestamp: 1, level: 'info', message: 'normal progress',
        }])}
      />,
    );

    expect(document.querySelector('[data-script-control="logs"]')).toBeNull();
    expect(screen.queryByText(/normal progress/)).toBeNull();

    rerender(
      <ScriptCanvasUi
        {...props}
        snapshot={snapshot([
          { id: 'info', timestamp: 1, level: 'info', message: 'normal progress' },
          { id: 'error', timestamp: 2, level: 'error', message: 'torque timeout' },
        ])}
      />,
    );

    expect(document.querySelector('[data-script-control="logs"]')).not.toBeNull();
    expect(screen.getByText(/torque timeout/)).toBeTruthy();
    expect(screen.queryByText(/normal progress/)).toBeNull();
  });

  it('filters test cases by explicit profile membership and excludes stale checks', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: {
        left: { controls: [{
          id: 'cases',
          type: 'testCases',
          label: 'Test cases',
          bind: 'form.nodeIds',
          catalogSource: 'catalog',
          profileBind: 'form.profile',
        }] },
        right: { controls: [] },
      },
    };
    const onValuesChange = vi.fn();

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { profile: 'quick', nodeIds: ['tests/test_device.py::test_device'] } }}
        snapshot={{
          status: 'idle',
          scriptName: 'dashboard',
          currentStepIndex: -1,
          steps: [],
          logs: [],
          variables: {
            catalog: {
              schemaVersion: 1,
              runnerId: 'fixture',
              title: 'Fixture',
              profiles: [{
                id: 'quick',
                title: 'Quick',
                danger: 'safe',
                nodeIds: ['tests/test_fast.py::test_fast'],
              }],
              tests: [{
                nodeId: 'tests/test_fast.py::test_fast',
                id: 'fast',
                title: 'Fast test',
                kind: 'unit',
                tags: ['fast'],
                requires: [],
                file: 'tests/test_fast.py',
                danger: 'safe',
              }, {
                nodeId: 'tests/test_device.py::test_device',
                id: 'device',
                title: 'Device test',
                kind: 'device',
                tags: ['device'],
                requires: [],
                file: 'tests/test_device.py',
                danger: 'destructive',
              }],
            },
          },
        }}
        onValuesChange={onValuesChange}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByText('Fast test')).toBeTruthy();
    expect(screen.queryByText('Device test')).toBeNull();
    expect(screen.getByText('Test cases').parentElement?.textContent).toContain('0 selected / 1 visible');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onValuesChange).toHaveBeenCalledWith({
      form: {
        profile: 'quick',
        nodeIds: ['tests/test_fast.py::test_fast'],
      },
    });
  });

  it('renders the Profile label inline with its field', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: {
        left: { controls: [
          {
            id: 'profile',
            type: 'select',
            label: 'Profile',
            bind: 'form.profile',
            inlineLabel: true,
            options: [{ value: 'quick', label: 'Quick' }],
          },
        ] },
        right: { controls: [] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { profile: 'quick' } }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByText('Profile').parentElement?.querySelector('select')).toBeTruthy();
    expect(screen.queryByText('Filter test cases')).toBeNull();
  });

  it('keeps compact controls content-sized in a row region', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: {
          controlsLayout: 'row',
          controls: [{
            id: 'torque-teeth',
            type: 'select',
            label: '齿数',
            bind: 'form.torqueTeeth',
            compact: true,
            inlineLabel: true,
            options: [{ value: '1024', label: '1024' }, { value: '60', label: '60' }],
          }],
        },
        bottom: { controls: [] },
      },
    };

    const { container } = render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { torqueTeeth: '1024' } }}
        snapshot={{ status: 'idle', scriptName: 'ui', currentStepIndex: -1, steps: [], logs: [] }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    const rowItem = container.querySelector('[data-script-control="torque-teeth"]')?.parentElement;
    expect(rowItem?.classList.contains('shrink-0')).toBe(true);
    expect(screen.getByText('齿数').parentElement?.querySelector('select')?.value).toBe('1024');
  });

  it('renders catalog-defined file inputs and writes the selected absolute path', async () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: {
        left: { controls: [{
          id: 'inputs',
          type: 'testInputs',
          bind: 'form.inputs',
          catalogSource: 'catalog',
          profileBind: 'form.profile',
          nodeIdsBind: 'form.nodeIds',
        }] },
        right: { controls: [] },
      },
    };
    const values = {
      form: {
        profile: 'device-write',
        nodeIds: [],
        inputs: { FIRMWARE_FILE: 'D:\\old firmware.bin' },
      },
    };
    const onValuesChange = vi.fn();
    openFileDialogMock.mockResolvedValue('D:\\images\\firmware = final.bin');

    render(
      <ScriptCanvasUi
        ui={ui}
        values={values}
        snapshot={{
          status: 'idle',
          scriptName: 'dashboard',
          currentStepIndex: -1,
          steps: [],
          logs: [],
          variables: {
            catalog: {
              schemaVersion: 1,
              runnerId: 'fixture',
              title: 'Fixture',
              inputDefinitions: {
                FIRMWARE_FILE: {
                  type: 'file',
                  label: 'Firmware image',
                  description: 'Select the binary to write.',
                  placeholder: 'Select or paste a path',
                  extensions: ['bin'],
                },
              },
              profiles: [{
                id: 'device-write',
                title: 'Device write',
                danger: 'destructive',
                requiredInputs: ['FIRMWARE_FILE'],
              }],
              tests: [],
            },
          },
        }}
        onValuesChange={onValuesChange}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByLabelText('Firmware image')).toHaveProperty('value', 'D:\\old firmware.bin');
    expect(screen.getByText('FIRMWARE_FILE')).toBeTruthy();
    expect(screen.getByText('Select the binary to write.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse Firmware image' }));

    await waitFor(() => expect(openFileDialogMock).toHaveBeenCalledWith({
      directory: false,
      multiple: false,
      defaultPath: 'D:\\old firmware.bin',
      filters: [{ name: 'Firmware image', extensions: ['bin'] }],
    }));
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith({
      form: {
        ...values.form,
        inputs: { FIRMWARE_FILE: 'D:\\images\\firmware = final.bin' },
      },
    }));
    expect(screen.queryByText(/one-time confirmation/i)).toBeNull();
  });

  it('keeps old catalogs compatible by rendering undeclared inputs as text', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: {
        left: { controls: [{
          id: 'inputs',
          type: 'testInputs',
          bind: 'form.inputs',
          catalogSource: 'catalog',
          profileBind: 'form.profile',
          nodeIdsBind: 'form.nodeIds',
        }] },
        right: { controls: [] },
      },
    };

    render(
      <ScriptCanvasUi
        ui={ui}
        values={{ form: { profile: 'legacy', nodeIds: [], inputs: {} } }}
        snapshot={{
          status: 'idle',
          scriptName: 'dashboard',
          currentStepIndex: -1,
          steps: [],
          logs: [],
          variables: {
            catalog: {
              schemaVersion: 1,
              runnerId: 'fixture',
              title: 'Fixture',
              profiles: [{
                id: 'legacy',
                title: 'Legacy',
                danger: 'safe',
                requiredInputs: ['LEGACY_INPUT'],
              }],
              tests: [],
            },
          },
        }}
        onValuesChange={() => undefined}
        onAction={() => undefined}
      />,
    );

    expect(screen.getByLabelText('LEGACY_INPUT').getAttribute('type')).toBe('text');
    expect(screen.queryByRole('button', { name: /browse legacy_input/i })).toBeNull();
  });

  describe('stepList timestamp', () => {
    it('formatStepTimestamp formats time down to seconds and supports datetime and none', () => {
      // 2026-09-08 16:30:15 UTC+8 or local
      const date = new Date(2026, 8, 8, 16, 30, 15);
      const ts = date.getTime();
      expect(formatStepTimestamp(ts, 'time')).toBe('16:30:15');
      expect(formatStepTimestamp(ts, 'datetime')).toBe('2026-09-08 16:30:15');
      expect(formatStepTimestamp(ts, 'none')).toBeNull();
      expect(formatStepTimestamp(undefined)).toBeNull();
    });

    it('renders timestamp in stepList when step.startedAt is present', () => {
      const date = new Date(2026, 8, 8, 16, 30, 15);
      const startedAt = date.getTime();
      const ui: ScriptUiDocument = {
        schemaVersion: 1,
        layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
        regions: {
          top: { controls: [] },
          bottom: {
            controls: [
              { id: 'steps', type: 'stepList' },
            ],
          },
        },
      };

      render(
        <ScriptCanvasUi
          ui={ui}
          values={{}}
          snapshot={{
            status: 'running',
            scriptName: 'test',
            currentStepIndex: 0,
            steps: [
              {
                id: 'row-0-0-rpm-0-percent-0-delay-2',
                action: 'group',
                status: 'passed',
                startedAt,
              },
              {
                id: 'row-0-1-rpm-100-percent-10-delay-2',
                action: 'group',
                status: 'pending',
              },
            ],
            logs: [],
          }}
          onValuesChange={() => undefined}
          onAction={() => undefined}
        />,
      );

      expect(screen.getByText('[16:30:15]')).toBeTruthy();
      expect(screen.getByText(/row-0-0-rpm-0-percent-0-delay-2/)).toBeTruthy();
      expect(screen.getByText('row-0-1-rpm-100-percent-10-delay-2')).toBeTruthy();
    });

    it('supports datetime format and disabling timestamps', () => {
      const date = new Date(2026, 8, 8, 16, 30, 15);
      const startedAt = date.getTime();

      const datetimeUi: ScriptUiDocument = {
        schemaVersion: 1,
        layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
        regions: {
          top: { controls: [] },
          bottom: {
            controls: [
              { id: 'steps', type: 'stepList', timestampFormat: 'datetime' },
            ],
          },
        },
      };

      const { unmount } = render(
        <ScriptCanvasUi
          ui={datetimeUi}
          values={{}}
          snapshot={{
            status: 'running',
            scriptName: 'test',
            currentStepIndex: 0,
            steps: [
              {
                id: 'row-0-0',
                action: 'group',
                status: 'passed',
                startedAt,
              },
            ],
            logs: [],
          }}
          onValuesChange={() => undefined}
          onAction={() => undefined}
        />,
      );

      expect(screen.getByText('[2026-09-08 16:30:15]')).toBeTruthy();
      unmount();

      const disabledUi: ScriptUiDocument = {
        schemaVersion: 1,
        layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
        regions: {
          top: { controls: [] },
          bottom: {
            controls: [
              { id: 'steps', type: 'stepList', showTimestamp: false },
            ],
          },
        },
      };

      render(
        <ScriptCanvasUi
          ui={disabledUi}
          values={{}}
          snapshot={{
            status: 'running',
            scriptName: 'test',
            currentStepIndex: 0,
            steps: [
              {
                id: 'row-0-0',
                action: 'group',
                status: 'passed',
                startedAt,
              },
            ],
            logs: [],
          }}
          onValuesChange={() => undefined}
          onAction={() => undefined}
        />,
      );

      expect(screen.queryByText('[16:30:15]')).toBeNull();
    });
  });
});
