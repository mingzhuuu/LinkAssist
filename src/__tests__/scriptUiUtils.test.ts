import { describe, expect, it } from 'vitest';
import type { ScriptUiDocument } from '../components/display/scriptTypes';
import {
  collectPersistedUiState,
  collectPersistedUiValues,
  mergeUiValues,
  readUiPath,
  retainScriptUiStateForPath,
  setUiPath,
} from '../components/display/scriptUiUtils';

describe('Script Canvas UI state helpers', () => {
  it('reads and immutably updates nested bindings', () => {
    const source = { form: { projectRoot: 'D:/old', nodeIds: [] } };
    const next = setUiPath(source, 'form.projectRoot', 'D:/new');

    expect(readUiPath(next, 'form.projectRoot')).toBe('D:/new');
    expect(readUiPath(source, 'form.projectRoot')).toBe('D:/old');
  });

  it('merges persisted values into current defaults', () => {
    expect(mergeUiValues(
      { form: { projectRoot: 'default', profile: 'quick', nodeIds: [] } },
      { form: { projectRoot: 'saved' } },
    )).toEqual({ form: { projectRoot: 'saved', profile: 'quick', nodeIds: [] } });
  });

  it('persists only explicitly allowed controls and waits for a catalog before saving test inputs', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      stateVersion: 'v1',
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: {
        top: { controls: [
          { id: 'root', type: 'directory', bind: 'form.projectRoot', persist: true },
          { id: 'secret', type: 'password', bind: 'form.secret', persist: true },
        ] },
        bottom: { controls: [
          {
            id: 'inputs',
            type: 'testInputs',
            bind: 'form.inputs',
            catalogSource: 'catalog',
            profileBind: 'form.profile',
            nodeIdsBind: 'form.nodeIds',
            persist: true,
          },
        ] },
      },
    };

    expect(collectPersistedUiValues(ui, {
      form: { projectRoot: 'D:/project', secret: 'token', inputs: { DEVICE: 'one' } },
    })).toEqual({ form: { projectRoot: 'D:/project' } });
  });

  it('persists safe test inputs and their catalog revision while excluding secrets', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      stateVersion: 'pytest-v1',
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: {
        left: { controls: [{
          id: 'cases',
          type: 'testCases',
          bind: 'form.nodeIds',
          catalogSource: 'catalog',
          profileBind: 'form.profile',
          persist: true,
        }, {
          id: 'inputs',
          type: 'testInputs',
          bind: 'form.inputs',
          catalogSource: 'catalog',
          profileBind: 'form.profile',
          nodeIdsBind: 'form.nodeIds',
          persist: true,
        }] },
        right: { controls: [] },
      },
    };

    expect(collectPersistedUiState(ui, {
      form: {
        nodeIds: ['case-a', 'stale-case'],
        inputs: {
          firmware: 'D:/firmware.bin',
          deviceName: 'trainer',
          password: 'secret',
          oneShot: 'do-not-save',
        },
      },
    }, {
      variables: {
        catalog: {
          catalogRevision: 'catalog-2',
          tests: [{ nodeId: 'case-a' }],
          inputDefinitions: {
            firmware: { type: 'file' },
            deviceName: { type: 'text' },
            password: { type: 'password' },
            oneShot: { type: 'text', persist: false },
          },
        },
      },
    })).toEqual({
      values: {
        form: {
          nodeIds: ['case-a'],
          inputs: { firmware: 'D:/firmware.bin', deviceName: 'trainer' },
        },
      },
      sourceRevisions: { catalog: 'catalog-2' },
    });
  });

  it('retains UI state only while the configured script path is unchanged', () => {
    const uiState = { stateVersion: 'v1', values: { form: { channelId: 'serial-1' } } };
    const current = { luaPath: 'D:/bench.lua', uiState };

    expect(retainScriptUiStateForPath(current, 'D:/bench.lua')).toBe(uiState);
    expect(retainScriptUiStateForPath(current, 'D:/other.lua')).toBeUndefined();
  });

  it('persists a directory bound to a toolbar button', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      toolbar: [{
        id: 'load',
        type: 'button',
        label: 'Load',
        action: 'loadCatalog',
        bind: 'form.projectRoot',
        directoryPicker: true,
        persist: true,
      }],
      layout: { preset: 'left-right', regions: ['left', 'right'] },
      regions: { left: { controls: [] }, right: { controls: [] } },
    };

    expect(collectPersistedUiValues(ui, { form: { projectRoot: 'D:/project' } }))
      .toEqual({ form: { projectRoot: 'D:/project' } });
  });

  it('persists channel selections and the loop option in the Script canvas state', () => {
    const ui: ScriptUiDocument = {
      schemaVersion: 1,
      stateVersion: 'bench-v1',
      toolbar: [{
        id: 'motor',
        type: 'select',
        bind: 'form.motorChannelId',
        persist: true,
        options: { source: 'app.channels.serial', valuePath: 'id', labelPath: 'name' },
      }, {
        id: 'ble',
        type: 'select',
        bind: 'form.bleChannelId',
        persist: true,
        options: { source: 'app.channels.ble', valuePath: 'id', labelPath: 'name' },
      }, {
        id: 'loop',
        type: 'checkbox',
        bind: 'form.loop',
        persist: true,
      }],
      layout: { preset: 'top-bottom', regions: ['top', 'bottom'] },
      regions: { top: { controls: [] }, bottom: { controls: [] } },
    };

    expect(collectPersistedUiValues(ui, {
      form: { motorChannelId: 'serial-1', bleChannelId: 'ble-1', loop: true },
    })).toEqual({
      form: { motorChannelId: 'serial-1', bleChannelId: 'ble-1', loop: true },
    });
  });
});
