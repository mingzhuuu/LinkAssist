import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeScriptRuntime,
  getScriptRuntime,
  ingestScriptPacket,
  type ScriptRuntimeChannelBinding,
} from '../components/display/scriptRuntime';
import type { ScriptDocument, ScriptStep } from '../components/display/scriptTypes';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const runtimeId = 'script-runtime-lua-helper-test';
const channelId = 'helper-packet-channel';
const deviceId = 'helper-device';
const serviceUuid = '00001826-0000-1000-8000-00805f9b34fb';
const charUuid = '00002ad2-0000-1000-8000-00805f9b34fb';
const helperFile = 'helpers/bench-codec.lua';

const packetBinding: ScriptRuntimeChannelBinding = {
  alias: 'sensor',
  channelType: 'ble',
  uiChannelId: channelId,
  connectionId: deviceId,
  bleDeviceId: deviceId,
  bleServiceUuid: serviceUuid,
  bleCharUuid: charUuid,
  closeOnCleanup: false,
};

function helperDocument(steps: ScriptStep[]): ScriptDocument {
  return {
    version: 1,
    name: 'generic Lua helper runtime',
    helpers: {
      bench: { luaPath: helperFile },
    },
    onActivate: steps,
  };
}

async function waitUntilLifecycleStepRuns(stepId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getScriptRuntime(runtimeId).getSnapshot().steps.find((step) => step.id === stepId)?.status).toBe('running');
  });
}

function ingest(bytes: number[], timestamp = Date.now()): void {
  ingestScriptPacket(runtimeId, {
    channelId,
    data: bytes,
    timestamp,
    source: 'ble',
    deviceId,
    serviceUuid,
    charUuid,
  });
}

function crc16Modbus(bytes: number[]): number {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
    }
  }
  return crc & 0xFFFF;
}

function torqueFrame(torqueHz: number, speedHz: number): number[] {
  const payload = new Uint8Array(11);
  payload.set([0x01, 0x32, 0x08]);
  const view = new DataView(payload.buffer);
  view.setFloat32(3, torqueHz, true);
  view.setFloat32(7, speedHz, true);
  const bytes = [...payload];
  const crc = crc16Modbus(bytes);
  return [...bytes, crc & 0xFF, (crc >> 8) & 0xFF];
}

beforeEach(() => {
  invokeMock.mockReset();
  disposeScriptRuntime(runtimeId);
});

afterEach(() => {
  disposeScriptRuntime(runtimeId);
  vi.useRealTimers();
});

describe('ScriptRuntime generic Lua helpers', () => {
  it('calls an embedded helper from the owning file-backed automation script', async () => {
    invokeMock.mockImplementation(async (command, parameters) => {
      expect(command).toBe('call_lua_script_helper_file');
      expect(parameters).toEqual({
        filePath: 'D:/scripts/meter.lua',
        func: 'torqueFrameValid',
        args: { bytes: [0x01, 0x32] },
        baseFilePath: 'D:/scripts/meter.lua',
        embedded: true,
      });
      return { valid: true };
    });

    const runtime = getScriptRuntime(runtimeId);
    await runtime.run({
      version: 1,
      name: 'self-contained meter helper',
      sourcePath: 'D:/scripts/meter.lua',
      helpers: { bench: { embedded: true } },
      variables: { sample: { bytes: [0x01, 0x32] } },
      steps: [{
        action: 'luaHelper',
        helper: 'bench',
        func: 'torqueFrameValid',
        args: { bytes: { $ref: 'sample.bytes' } },
        saveAs: 'validation',
      }],
    });

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'passed',
      variables: { validation: { valid: true } },
    });
  });

  it('runs a luaHelper step with typed arguments and saves its result', async () => {
    const zero = torqueFrame(10000, 0);
    const sample = torqueFrame(10250, 60);
    invokeMock.mockImplementation(async (command, parameters) => {
      expect(command).toBe('call_lua_script_helper_file');
      expect(parameters).toMatchObject({
        filePath: helperFile,
        func: 'torqueMeasurement',
        args: { sampleBytes: sample, zeroBytes: zero, toothCount: '60' },
        baseFilePath: 'D:/scripts/bench.lua',
      });
      return { torqueNm: 5, rpm: 60, powerW: 31.416 };
    });

    const runtime = getScriptRuntime(runtimeId);
    await runtime.run({
      version: 1,
      name: 'selected torque teeth',
      sourcePath: 'D:/scripts/bench.lua',
      helpers: { bench: { luaPath: helperFile } },
      variables: {
        form: { torqueTeeth: '60' },
        torqueSample: { bytes: sample },
        zeroSample: { bytes: zero },
      },
      steps: [{
        action: 'luaHelper',
        helper: 'bench',
        func: 'torqueMeasurement',
        args: {
          sampleBytes: { $ref: 'torqueSample.bytes' },
          zeroBytes: { $ref: 'zeroSample.bytes' },
          toothCount: { $ref: 'form.torqueTeeth' },
        },
        saveAs: 'measurement',
      }],
    });

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'passed',
      variables: {
        measurement: { torqueNm: 5, rpm: 60, powerW: 31.416 },
      },
    });
  });

  it('keeps waiting when an asynchronous Lua matcher returns false and accepts the next packet', async () => {
    invokeMock.mockImplementation(async (command, parameters) => {
      if (command !== 'call_lua_script_helper_file') throw new Error(`Unexpected invoke call: ${command}`);
      const bytes = (parameters as { args: { bytes: number[] } }).args.bytes;
      await Promise.resolve();
      return { matched: bytes[0] === 0x02 };
    });

    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle(helperDocument([{
      id: 'wait-helper-match',
      action: 'wait',
      channel: 'sensor',
      timeoutMs: 500,
      expect: {
        luaHelper: {
          helper: 'bench',
          func: 'packetMatches',
          args: { bytes: { $ref: 'packet.bytes' } },
          resultPath: 'matched',
          equals: true,
        },
      },
      saveAs: 'acceptedPacket',
    }]), 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-helper-match');
    ingest([0x01, 0x10]);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    ingest([0x02, 0x20]);
    await runPromise;

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'passed',
      variables: {
        acceptedPacket: { bytes: [0x02, 0x20], hex: '02 20', length: 2 },
      },
    });
  });

  it('continues scanning one accumulated buffer after a bad frame and accepts the following good frame', async () => {
    const good = torqueFrame(10250, 1024);
    const bad = [...good];
    bad[12] ^= 0xFF;
    invokeMock.mockImplementation(async (command, parameters) => {
      if (command !== 'call_lua_script_helper_file') throw new Error(`Unexpected invoke call: ${command}`);
      const bytes = (parameters as { args: { bytes: number[] } }).args.bytes;
      const expected = crc16Modbus(bytes.slice(0, 11));
      return bytes[11] === (expected & 0xFF) && bytes[12] === ((expected >> 8) & 0xFF);
    });

    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle(helperDocument([{
      id: 'wait-valid-frame',
      action: 'wait',
      channel: 'sensor',
      timeoutMs: 500,
      expect: {
        format: 'hex',
        startsWith: '01 32 08',
        length: 13,
        accumulate: true,
        luaHelper: {
          helper: 'bench',
          func: 'torqueFrameValid',
          args: { bytes: { $ref: 'packet.bytes' } },
          equals: true,
        },
      },
      saveAs: 'sample',
    }]), 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-valid-frame');
    ingest([...bad, ...good]);
    await runPromise;

    const helperCalls = invokeMock.mock.calls.filter(([command]) => command === 'call_lua_script_helper_file');
    expect(helperCalls).toHaveLength(2);
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'passed',
      variables: { sample: { bytes: good, length: 13 } },
    });
  });

  it('ignores a Lua matcher result that arrives after the wait timed out', async () => {
    let resolveHelper!: (value: unknown) => void;
    invokeMock.mockImplementation((command) => {
      if (command !== 'call_lua_script_helper_file') return Promise.reject(new Error(`Unexpected invoke call: ${command}`));
      return new Promise((resolve) => { resolveHelper = resolve; });
    });

    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle(helperDocument([{
      id: 'wait-timeout',
      action: 'wait',
      channel: 'sensor',
      timeoutMs: 200,
      expect: {
        luaHelper: { helper: 'bench', func: 'slowMatch', args: { bytes: { $ref: 'packet.bytes' } }, equals: true },
      },
      saveAs: 'latePacket',
    }]), 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-timeout');
    ingest([0xAA]);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await runPromise;
    const failedSnapshot = runtime.getSnapshot();
    expect(failedSnapshot.status).toBe('failed');
    expect(failedSnapshot.variables).not.toHaveProperty('latePacket');

    resolveHelper(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'failed',
      error: failedSnapshot.error,
    });
    expect(runtime.getSnapshot().variables).not.toHaveProperty('latePacket');
  });

  it('ignores a Lua matcher result that arrives after Stop', async () => {
    let resolveHelper!: (value: unknown) => void;
    invokeMock.mockImplementation((command) => {
      if (command !== 'call_lua_script_helper_file') return Promise.reject(new Error(`Unexpected invoke call: ${command}`));
      return new Promise((resolve) => { resolveHelper = resolve; });
    });

    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle(helperDocument([{
      id: 'wait-stop',
      action: 'wait',
      channel: 'sensor',
      timeoutMs: 5000,
      expect: {
        luaHelper: { helper: 'bench', func: 'slowMatch', args: { bytes: { $ref: 'packet.bytes' } }, equals: true },
      },
      saveAs: 'latePacket',
    }]), 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-stop');
    ingest([0xBB]);
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    runtime.stop();
    await runPromise;
    expect(runtime.getSnapshot().status).toBe('stopped');

    resolveHelper(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runtime.getSnapshot().status).toBe('stopped');
    expect(runtime.getSnapshot().variables).not.toHaveProperty('latePacket');
  });
});

describe('ScriptRuntime latest packet sampling', () => {
  it('returns a fresh packet once when consume is enabled', async () => {
    const timestamp = Date.now();
    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle({
      version: 1,
      name: 'consume latest packet',
      onActivate: [{
        id: 'wait-sample',
        action: 'wait',
        channel: 'sensor',
        timeoutMs: 500,
        expect: { length: 2 },
      }, {
        action: 'takeLatestPacket',
        channel: 'sensor',
        maxAgeMs: 1000,
        consume: true,
        required: true,
        saveAs: 'first',
      }, {
        action: 'takeLatestPacket',
        channel: 'sensor',
        maxAgeMs: 1000,
        consume: true,
        required: false,
        saveAs: 'second',
      }],
    }, 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-sample');
    ingest([0x41, 0x42], timestamp);
    await runPromise;

    expect(runtime.getSnapshot()).toMatchObject({
      status: 'passed',
      variables: {
        first: {
          available: true,
          reason: '',
          bytes: [0x41, 0x42],
          hex: '41 42',
          text: 'AB',
          length: 2,
          timestamp,
          sequence: 1,
        },
        second: {
          available: false,
        },
      },
    });
  });

  it('reports a stale latest packet without exposing it as available', async () => {
    const runtime = getScriptRuntime(runtimeId);
    const runPromise = runtime.runLifecycle({
      version: 1,
      name: 'stale latest packet',
      onActivate: [{
        id: 'wait-stale-sample',
        action: 'wait',
        channel: 'sensor',
        timeoutMs: 500,
        expect: { length: 1 },
      }, {
        action: 'takeLatestPacket',
        channel: 'sensor',
        maxAgeMs: 50,
        consume: true,
        required: false,
        saveAs: 'sample',
      }],
    }, 'onActivate', [packetBinding]);

    await waitUntilLifecycleStepRuns('wait-stale-sample');
    ingest([0x7F], Date.now() - 1000);
    await runPromise;

    expect(runtime.getSnapshot().status).toBe('passed');
    expect(runtime.getSnapshot().variables?.sample).toMatchObject({
      available: false,
      reason: expect.stringMatching(/stale/i),
    });
  });
});
