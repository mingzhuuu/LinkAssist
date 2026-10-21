import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disposeScriptRuntime,
  getScriptRuntime,
  ingestScriptPacket,
} from '../components/display/scriptRuntime';
import {
  initializeCanvasLifecycleRuntime,
  runCanvasLifecycleHook,
} from '../components/display/canvasLifecycleRuntime';
import {
  acquireChannelRuntimeLease,
  releaseChannelRuntimeLease,
} from '../components/display/channelRuntimeLease';
import type { ScriptDocument } from '../components/display/scriptTypes';
import { useBleStore } from '../stores/bleStore';
import { useChannelStore } from '../stores/channelStore';
import { useCanvasStore } from '../stores/canvasStore';
import { useSerialStore } from '../stores/serialStore';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

initializeCanvasLifecycleRuntime();

const invokeMock = vi.mocked(invoke);
const canvasId = 'script-runtime-test-canvas';
const channelId = 'ble-channel-1';
const deviceId = 'device-1';
const ftmsServiceUuid = '00001826-0000-1000-8000-00805f9b34fb';
const controlPointCharUuid = '00002ad9-0000-1000-8000-00805f9b34fb';
const statusCharUuid = '00002ada-0000-1000-8000-00805f9b34fb';
const indoorBikeDataCharUuid = '00002ad2-0000-1000-8000-00805f9b34fb';
const featureCharUuid = '00002acc-0000-1000-8000-00805f9b34fb';

function crc16Modbus(bytes: number[]): number {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
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

describe('ScriptRuntime BLE request handling', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    disposeScriptRuntime(canvasId);
    useChannelStore.setState(useChannelStore.getInitialState(), true);
    useBleStore.setState(useBleStore.getInitialState(), true);

    useChannelStore.getState().addChannel('ble', 'Active FTMS BLE Channel', channelId);
    useChannelStore.getState().setActiveChannel(channelId);
    useBleStore.getState().setConnectedDeviceId(deviceId, channelId);
  });

  afterEach(() => {
    disposeScriptRuntime(canvasId);
  });

  it('matches BLE request responses that arrive before the send promise settles', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'subscribe_ble_notifications') return undefined;

      if (command === 'write_ble_characteristic') {
        expect(args).toMatchObject({
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
          data: [0x00],
        });

        ingestScriptPacket(canvasId, {
          channelId,
          data: [0x80, 0x00, 0x01],
          timestamp: Date.now(),
          source: 'ble',
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
        });
        return undefined;
      }

      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(canvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'ble-race',
      defaults: {
        stopOnFailure: true,
        timeoutMs: 50,
        dataFormat: 'hex',
      },
      setup: [
        {
          id: 'open-ftms-control-point',
          action: 'open',
          channel: 'ftmsControl',
          channelType: 'ble',
          name: 'Active FTMS BLE Channel',
          params: {
            useActiveChannel: true,
            serviceUuid: ftmsServiceUuid,
            charUuid: controlPointCharUuid,
            subscribe: true,
          },
        },
      ],
      steps: [
        {
          id: 'request-control',
          action: 'request',
          channel: 'ftmsControl',
          send: {
            format: 'hex',
            value: '00',
          },
          expect: {
            format: 'hex',
            startsWith: '80 00 01',
          },
        },
      ],
    };

    await runtime.run(document);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.status).toBe('passed');
    expect(snapshot.steps.find((step) => step.id === 'request-control')).toMatchObject({
      status: 'passed',
      sendHex: '00',
      receiveHex: '80 00 01',
    });
  });

  it('supports Lua-helper FTMS waits for target speed and spin-down result', async () => {
    invokeMock.mockImplementation(async (command, parameters) => {
      if (command === 'subscribe_ble_notifications') return undefined;
      if (command === 'call_lua_script_helper_file') {
        const call = parameters as { func: string; args: Record<string, unknown> };
        const bytes = call.args.bytes as number[] | undefined;
        if (call.func === 'spinDownTarget') {
          return { available: true, lowKph: 6, highKph: 7, label: '6-7 km/h' };
        }
        if (call.func === 'indoorBikeSpeedInTarget') {
          const speedRaw = bytes ? bytes[2] | (bytes[3] << 8) : 0;
          return { matched: speedRaw >= 600 && speedRaw <= 700 };
        }
        if (call.func === 'indoorBikeSpeed') return { speedKph: 6.5, label: '6.5 km/h' };
        if (call.func === 'spinDownResultReady') return { matched: bytes?.[0] === 0x14 && bytes[1] === 0x02 };
        if (call.func === 'spinDownStatus') return { code: bytes?.[1] ?? -1, label: 'success' };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(canvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'ble-spin-down',
      helpers: { bench: { luaPath: 'helpers/bench.lua' } },
      defaults: {
        stopOnFailure: true,
        timeoutMs: 50,
        dataFormat: 'hex',
      },
      variables: {
        spinDownControlResponse: {
          bytes: [0x80, 0x13, 0x01, 0x58, 0x02, 0xBC, 0x02],
        },
      },
      setup: [
        {
          id: 'open-ftms-status',
          action: 'open',
          channel: 'ftmsStatus',
          channelType: 'ble',
          name: 'Active FTMS BLE Channel',
          params: {
            useActiveChannel: true,
            serviceUuid: ftmsServiceUuid,
            charUuid: statusCharUuid,
            subscribe: true,
          },
        },
        {
          id: 'open-ftms-bike-data',
          action: 'open',
          channel: 'ftmsBikeData',
          channelType: 'ble',
          name: 'Active FTMS BLE Channel',
          params: {
            useActiveChannel: true,
            serviceUuid: ftmsServiceUuid,
            charUuid: indoorBikeDataCharUuid,
            subscribe: true,
          },
        },
      ],
      steps: [
        {
          id: 'decode-spin-down-target',
          action: 'luaHelper',
          helper: 'bench',
          func: 'spinDownTarget',
          args: { bytes: { $ref: 'spinDownControlResponse.bytes' } },
          saveAs: 'spinDownTarget',
        },
        {
          id: 'wait-target-speed',
          action: 'wait',
          channel: 'ftmsBikeData',
          expect: {
            luaHelper: {
              helper: 'bench',
              func: 'indoorBikeSpeedInTarget',
              args: {
                bytes: { $ref: 'packet.bytes' },
                target: { $ref: 'spinDownTarget' },
              },
              resultPath: 'matched',
              equals: true,
            },
          },
          timeoutMs: 50,
          saveAs: 'targetSpeedPacket',
        },
        {
          id: 'decode-target-speed-label',
          action: 'luaHelper',
          helper: 'bench',
          func: 'indoorBikeSpeed',
          args: { bytes: { $ref: 'targetSpeedPacket.bytes' } },
          saveAs: 'targetSpeed',
        },
        {
          id: 'log-stop-pedaling-prompt',
          action: 'log',
          message: 'Reached ${targetSpeed.label} in target ${spinDownTarget.label}',
        },
        {
          id: 'wait-spin-down-result',
          action: 'wait',
          channel: 'ftmsStatus',
          expect: {
            luaHelper: {
              helper: 'bench',
              func: 'spinDownResultReady',
              args: { bytes: { $ref: 'packet.bytes' } },
              resultPath: 'matched',
              equals: true,
            },
          },
          timeoutMs: 50,
          saveAs: 'spinDownResultStatus',
        },
        {
          id: 'decode-spin-down-status',
          action: 'luaHelper',
          helper: 'bench',
          func: 'spinDownStatus',
          args: { bytes: { $ref: 'spinDownResultStatus.bytes' } },
          saveAs: 'spinDownResult',
        },
        {
          id: 'assert-spin-down-success',
          action: 'assert',
          left: '${spinDownResult.code}',
          operator: '=',
          right: '2',
        },
      ],
    };

    const runPromise = runtime.run(document);

    window.setTimeout(() => {
      ingestScriptPacket(canvasId, {
        channelId,
        data: [0x00, 0x00, 0x26, 0x02],
        timestamp: Date.now(),
        source: 'ble',
        deviceId,
        serviceUuid: ftmsServiceUuid,
        charUuid: indoorBikeDataCharUuid,
      });
    }, 0);

    window.setTimeout(() => {
      ingestScriptPacket(canvasId, {
        channelId,
        data: [0x00, 0x00, 0x8A, 0x02],
        timestamp: Date.now(),
        source: 'ble',
        deviceId,
        serviceUuid: ftmsServiceUuid,
        charUuid: indoorBikeDataCharUuid,
      });
    }, 5);

    window.setTimeout(() => {
      ingestScriptPacket(canvasId, {
        channelId,
        data: [0x14, 0x04],
        timestamp: Date.now(),
        source: 'ble',
        deviceId,
        serviceUuid: ftmsServiceUuid,
        charUuid: statusCharUuid,
      });
    }, 10);

    window.setTimeout(() => {
      ingestScriptPacket(canvasId, {
        channelId,
        data: [0x14, 0x02],
        timestamp: Date.now(),
        source: 'ble',
        deviceId,
        serviceUuid: ftmsServiceUuid,
        charUuid: statusCharUuid,
      });
    }, 15);

    await runPromise;

    const snapshot = runtime.getSnapshot();
    expect(snapshot.status).toBe('passed');
    expect(snapshot.steps.find((step) => step.id === 'wait-target-speed')).toMatchObject({
      status: 'passed',
      receiveHex: '00 00 8A 02',
    });
    expect(snapshot.steps.find((step) => step.id === 'wait-spin-down-result')).toMatchObject({
      status: 'passed',
      receiveHex: '14 02',
    });
    expect(snapshot.logs.some((entry) => entry.message.includes('6.5 km/h'))).toBe(true);
  });

  it('reads BLE characteristic info during script execution', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'read_ble_characteristic') {
        expect(args).toMatchObject({
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: featureCharUuid,
        });
        return [0x34, 0x12, 0x78, 0x56];
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(canvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'ble-read',
      defaults: {
        stopOnFailure: true,
        timeoutMs: 50,
        dataFormat: 'hex',
      },
      setup: [
        {
          id: 'open-ftms-feature',
          action: 'open',
          channel: 'ftmsFeature',
          channelType: 'ble',
          name: 'Active FTMS BLE Channel',
          params: {
            useActiveChannel: true,
            serviceUuid: ftmsServiceUuid,
            charUuid: featureCharUuid,
            subscribe: false,
          },
        },
      ],
      steps: [
        {
          id: 'read-ftms-feature',
          action: 'read',
          channel: 'ftmsFeature',
          saveAs: 'ftmsFeature',
        },
      ],
    };

    await runtime.run(document);

    const snapshot = runtime.getSnapshot();
    expect(snapshot.status).toBe('passed');
    expect(snapshot.steps.find((step) => step.id === 'read-ftms-feature')).toMatchObject({
      status: 'passed',
      receiveHex: '34 12 78 56',
    });
  });
});

describe('ScriptRuntime interactive bench controls', () => {
  const benchCanvasId = 'bench-runtime-canvas';

  beforeEach(() => {
    invokeMock.mockReset();
    disposeScriptRuntime(benchCanvasId);
    useChannelStore.setState(useChannelStore.getInitialState(), true);
    useCanvasStore.setState(useCanvasStore.getInitialState(), true);
    useSerialStore.setState(useSerialStore.getInitialState(), true);
    useBleStore.setState(useBleStore.getInitialState(), true);
  });

  afterEach(() => {
    useCanvasStore.getState().removeAllCanvases();
    disposeScriptRuntime(benchCanvasId);
  });

  it('reopens a remembered serial channel by id using its persisted configuration', async () => {
    const rememberedChannelId = 'remembered-motor';
    useChannelStore.getState().addChannel('serial', 'Motor', rememberedChannelId);
    useSerialStore.getState().setChannelConfig(rememberedChannelId, { path: 'COM9', baudRate: 9600 });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'open_serial_port') {
        expect(args).toMatchObject({ config: { path: 'COM9', baudRate: 9600 } });
        return 'serial-connection';
      }
      if (command === 'send_serial_data') {
        expect(args).toEqual({ connectionId: 'serial-connection', data: [0x41] });
        return undefined;
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'remembered serial',
      setup: [{
        action: 'open',
        channel: 'motor',
        channelType: 'serial',
        params: { channelId: rememberedChannelId },
      }],
      steps: [{ action: 'send', channel: 'motor', data: { format: 'text', value: 'A' } }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId: 'serial-connection' });
  });

  it('normalizes a bare serial number and reuses the matching open UI channel', async () => {
    const existingChannelId = 'open-motor-channel';
    useChannelStore.getState().addChannel('serial', '29', existingChannelId);
    useChannelStore.getState().updateChannelState(existingChannelId, 'connected');
    useSerialStore.getState().setChannelConfig(existingChannelId, { path: 'COM29', baudRate: 115200 });
    useSerialStore.getState().addConnection('COM29', existingChannelId);

    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_serial_connections') return ['COM29'];
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'reuse typed motor port',
      setup: [{ action: 'open', channel: 'motor', channelType: 'serial', params: { channelId: '29' } }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
    expect(invokeMock).toHaveBeenCalledWith('get_serial_connections');
    expect(invokeMock).not.toHaveBeenCalledWith('open_serial_port', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('close_serial_port', expect.anything());
    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(useChannelStore.getState().activeChannelId).toBe(existingChannelId);
    expect(useChannelStore.getState().channels[0].state).toBe('connected');
  });

  it('opens a bare serial number on its existing configured UI channel', async () => {
    const existingChannelId = 'closed-torque-channel';
    useChannelStore.getState().addChannel('serial', '20', existingChannelId);
    useSerialStore.getState().setChannelConfig(existingChannelId, { path: 'COM20', baudRate: 9600 });

    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'open_serial_port') {
        expect(args).toMatchObject({ config: { path: 'COM20', baudRate: 9600 } });
        return 'COM20';
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(benchCanvasId);
    const runPromise = runtime.run({
      version: 1,
      name: 'open typed torque port',
      setup: [{ action: 'open', channel: 'torque', channelType: 'serial', params: { channelId: '20' } }],
      steps: [{ action: 'delay', durationMs: 60_000 }],
    });

    await vi.waitFor(() => {
      expect(useChannelStore.getState().channels[0].state).toBe('connected');
    });
    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(useChannelStore.getState().activeChannelId).toBe(existingChannelId);
    expect(useSerialStore.getState().connectionMap.COM20).toBe(existingChannelId);

    runtime.stop();
    await runPromise;
    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId: 'COM20' });
  });

  it('opens a normalized COM port in a new UI channel when no configured channel matches', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'open_serial_port') {
        expect(args).toMatchObject({ config: { path: 'COM7' } });
        return 'COM7';
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'open new typed serial port',
      setup: [{ action: 'open', channel: 'serial', channelType: 'serial', params: { channelId: '7' } }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
    expect(useChannelStore.getState().channels).toHaveLength(1);
    const createdChannelId = useChannelStore.getState().channels[0].id;
    expect(useSerialStore.getState().channelConfigs[createdChannelId].path).toBe('COM7');
    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId: 'COM7' });
  });

  it('repairs a stale remembered serial connection before reusing the channel', async () => {
    const rememberedChannelId = 'stale-torque';
    useChannelStore.getState().addChannel('serial', 'Torque', rememberedChannelId);
    useSerialStore.getState().setChannelConfig(rememberedChannelId, { path: 'COM23', baudRate: 115200 });
    useSerialStore.getState().addConnection('COM23', rememberedChannelId);

    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_serial_connections') return [];
      if (command === 'open_serial_port') return 'COM23';
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'repair stale serial',
      setup: [{ action: 'open', channel: 'torque', channelType: 'serial', params: { channelId: rememberedChannelId } }],
    });

    expect(invokeMock).toHaveBeenCalledWith('get_serial_connections');
    expect(invokeMock).toHaveBeenCalledWith('open_serial_port', {
      config: expect.objectContaining({ path: 'COM23', baudRate: 115200 }),
    });
    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId: 'COM23' });
    expect(useSerialStore.getState().connectionMap).not.toHaveProperty('COM23');
  });

  it('skips optional serial steps whose selected channel reference is empty', async () => {
    invokeMock.mockImplementation(async (command) => {
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'no infrared selected',
      variables: { form: { infrared1ChannelId: '' } },
      setup: [{
        action: 'open',
        when: { $ref: 'form.infrared1ChannelId' },
        channel: 'infrared1',
        channelType: 'serial',
        params: { channelId: '${form.infrared1ChannelId}' },
      }],
      steps: [{
        action: 'request',
        when: { $ref: 'form.infrared1ChannelId' },
        channel: 'infrared1',
        send: { format: 'hex', value: '01 03 00 00 00 01 84 0A' },
        expect: { format: 'hex', startsWith: '01 03 02' },
      }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('samples two independently selected infrared serial channels', async () => {
    const infrared1ChannelId = 'infrared-channel-1';
    const infrared2ChannelId = 'infrared-channel-2';
    const response1 = [0x01, 0x03, 0x02, 0x01, 0x07, 0xF8, 0x16];
    const response2Payload = [0x01, 0x03, 0x02, 0x00, 0xFA];
    const response2Crc = crc16Modbus(response2Payload);
    const response2 = [...response2Payload, response2Crc & 0xFF, (response2Crc >> 8) & 0xFF];

    useChannelStore.getState().addChannel('serial', 'Infrared 1', infrared1ChannelId);
    useChannelStore.getState().addChannel('serial', 'Infrared 2', infrared2ChannelId);
    useSerialStore.getState().setChannelConfig(infrared1ChannelId, { path: 'COM31', baudRate: 9600 });
    useSerialStore.getState().setChannelConfig(infrared2ChannelId, { path: 'COM32', baudRate: 9600 });

    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'open_serial_port') {
        const path = (args as { config: { path: string } }).config.path;
        return path;
      }
      if (command === 'send_serial_data') {
        const connectionId = (args as { connectionId: string }).connectionId;
        const channelId = connectionId === 'COM31' ? infrared1ChannelId : infrared2ChannelId;
        ingestScriptPacket(benchCanvasId, {
          channelId,
          connectionId,
          data: connectionId === 'COM31' ? response1 : response2,
          timestamp: Date.now(),
          source: 'serial',
        });
        return undefined;
      }
      if (command === 'call_lua_script_helper_file') {
        const call = args as { func: string; args: { bytes: number[] } };
        const bytes = call.args.bytes;
        if (call.func === 'infraredFrameValid') {
          const crc = crc16Modbus(bytes.slice(0, 5));
          return { valid: bytes.length === 7
            && bytes[0] === 0x01
            && bytes[1] === 0x03
            && bytes[2] === 0x02
            && bytes[5] === (crc & 0xFF)
            && bytes[6] === ((crc >> 8) & 0xFF) };
        }
        if (call.func === 'infraredTemperature') {
          const raw = (bytes[3] << 8) | bytes[4];
          return { temperatureC: (raw >= 0x8000 ? raw - 0x10000 : raw) / 10 };
        }
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'two infrared sensors',
      helpers: { bench: { luaPath: 'helpers/bench-codec.lua' } },
      defaults: { timeoutMs: 50 },
      variables: {
        form: { infrared1ChannelId, infrared2ChannelId },
        infrared1Temperature: '',
        infrared2Temperature: '',
      },
      setup: [
        { action: 'open', when: { $ref: 'form.infrared1ChannelId' }, channel: 'infrared1', channelType: 'serial', params: { channelId: infrared1ChannelId } },
        { action: 'open', when: { $ref: 'form.infrared2ChannelId' }, channel: 'infrared2', channelType: 'serial', params: { channelId: infrared2ChannelId } },
      ],
      steps: [
        {
          action: 'request',
          when: { $ref: 'form.infrared1ChannelId' },
          channel: 'infrared1',
          send: { format: 'hex', value: '01 03 00 00 00 01 84 0A' },
          expect: {
            format: 'hex',
            startsWith: '01 03 02',
            length: 7,
            accumulate: true,
            luaHelper: {
              helper: 'bench',
              func: 'infraredFrameValid',
              args: { bytes: { $ref: 'packet.bytes' } },
              resultPath: 'valid',
              equals: true,
            },
          },
          saveAs: 'infrared1Sample',
        },
        {
          action: 'luaHelper',
          when: { $ref: 'form.infrared1ChannelId' },
          helper: 'bench',
          func: 'infraredTemperature',
          args: { bytes: { $ref: 'infrared1Sample.bytes' } },
          saveAs: 'infrared1Decoded',
        },
        {
          action: 'set',
          when: { $ref: 'form.infrared1ChannelId' },
          name: 'infrared1Temperature',
          value: { $ref: 'infrared1Decoded.temperatureC' },
        },
        {
          action: 'request',
          when: { $ref: 'form.infrared2ChannelId' },
          channel: 'infrared2',
          send: { format: 'hex', value: '01 03 00 00 00 01 84 0A' },
          expect: {
            format: 'hex',
            startsWith: '01 03 02',
            length: 7,
            accumulate: true,
            luaHelper: {
              helper: 'bench',
              func: 'infraredFrameValid',
              args: { bytes: { $ref: 'packet.bytes' } },
              resultPath: 'valid',
              equals: true,
            },
          },
          saveAs: 'infrared2Sample',
        },
        {
          action: 'luaHelper',
          when: { $ref: 'form.infrared2ChannelId' },
          helper: 'bench',
          func: 'infraredTemperature',
          args: { bytes: { $ref: 'infrared2Sample.bytes' } },
          saveAs: 'infrared2Decoded',
        },
        {
          action: 'set',
          when: { $ref: 'form.infrared2ChannelId' },
          name: 'infrared2Temperature',
          value: { $ref: 'infrared2Decoded.temperatureC' },
        },
      ],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().variables).toMatchObject({
      infrared1Temperature: 26.3,
      infrared2Temperature: 25,
    });
    expect(invokeMock.mock.calls.filter(([command]) => command === 'open_serial_port')).toHaveLength(2);
    expect(invokeMock.mock.calls.filter(([command]) => command === 'send_serial_data')).toHaveLength(2);
  });

  it('opens serial channel with baudRate from step params, reopening if already open with mismatched baudRate', async () => {
    const channelId = 'infrared-test-channel';
    useChannelStore.getState().addChannel('serial', 'Infrared', channelId);
    useSerialStore.getState().setChannelConfig(channelId, { path: 'COM33', baudRate: 115200 });
    useSerialStore.getState().addConnection('conn-33-old', channelId);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'get_serial_connections') return ['conn-33-old'];
      if (command === 'close_serial_port') return undefined;
      if (command === 'open_serial_port') return 'conn-33-new';
      throw new Error(`Unexpected invoke call: ${command} ${JSON.stringify(args)}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'infrared baudrate test',
      setup: [{
        action: 'open',
        channel: 'infrared1Uart',
        channelType: 'serial',
        params: { channelId, baudRate: 9600 },
      }],
    });

    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId: 'conn-33-old' });
    expect(invokeMock).toHaveBeenCalledWith('open_serial_port', {
      config: expect.objectContaining({ path: 'COM33', baudRate: 9600 }),
    });
    expect(useSerialStore.getState().channelConfigs[channelId]?.baudRate).toBe(9600);
  });

  it('pauses a linked canvas lifecycle while a script owns its serial channel and resumes it afterward', async () => {
    const rememberedChannelId = 'shared-torque';
    const connectionId = 'COM23';
    useChannelStore.getState().addChannel('serial', 'Torque', rememberedChannelId);
    useSerialStore.getState().setChannelConfig(rememberedChannelId, { path: connectionId, baudRate: 115200 });
    useSerialStore.getState().addConnection(connectionId, rememberedChannelId);

    const lifecycleCanvasId = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 320, height: 180 });
    useCanvasStore.getState().updateCanvasConfig(lifecycleCanvasId, {
      channels: [{ channelId: rememberedChannelId, protocolTemplateId: null }],
      lifecycleScript: {
        sourceType: 'file',
        luaPath: 'D:/torque-lifecycle.lua',
        enabled: true,
        runOnActivate: true,
        runOnDeactivate: false,
      },
    });

    invokeMock.mockImplementation(async (command) => {
      if (command === 'get_serial_connections') return [connectionId];
      if (command === 'parse_lua_canvas_lifecycle_file') {
        return {
          version: 1,
          name: 'torque lifecycle',
          whileActive: {
            intervalMs: 1000,
            steps: [{ action: 'send', channel: 'canvas', data: { format: 'hex', value: '01 32 81 F5' } }],
          },
        } satisfies ScriptDocument;
      }
      if (command === 'send_serial_data') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(benchCanvasId);
    const runPromise = runtime.run({
      version: 1,
      name: 'exclusive torque serial',
      setup: [{ action: 'open', channel: 'torque', channelType: 'serial', params: { channelId: rememberedChannelId } }],
      steps: [{ action: 'delay', durationMs: 10_000 }],
    });

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_serial_connections'));
    const lifecycleCanvas = useCanvasStore.getState().canvases.find((canvas) => canvas.id === lifecycleCanvasId);
    expect(lifecycleCanvas).toBeDefined();
    await runCanvasLifecycleHook(lifecycleCanvas!, 'activate');
    expect(invokeMock).not.toHaveBeenCalledWith('parse_lua_canvas_lifecycle_file', expect.anything());

    runtime.stop();
    await runPromise;

    expect(invokeMock).toHaveBeenCalledWith('parse_lua_canvas_lifecycle_file', { path: 'D:/torque-lifecycle.lua' });
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('send_serial_data', {
      connectionId,
      data: [0x01, 0x32, 0x81, 0xF5],
    }));
    expect(invokeMock).not.toHaveBeenCalledWith('close_serial_port', expect.anything());
  });

  it('keeps a linked canvas lifecycle suspended until its last channel owner releases it', async () => {
    const sharedChannelId = 'shared-owner-channel';
    const connectionId = 'COM41';
    useChannelStore.getState().addChannel('serial', 'Shared owner channel', sharedChannelId);
    useSerialStore.getState().addConnection(connectionId, sharedChannelId);

    const lifecycleCanvasId = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 320, height: 180 });
    useCanvasStore.getState().updateCanvasConfig(lifecycleCanvasId, {
      channels: [{ channelId: sharedChannelId, protocolTemplateId: null }],
      lifecycleScript: {
        sourceType: 'file',
        luaPath: 'D:/shared-owner-lifecycle.lua',
        enabled: true,
        runOnActivate: true,
        runOnDeactivate: true,
      },
    });

    invokeMock.mockImplementation(async (command) => {
      if (command === 'parse_lua_canvas_lifecycle_file') {
        return {
          version: 1,
          name: 'shared owner lifecycle',
          onActivate: [{ action: 'send', channel: 'canvas', data: { format: 'hex', value: 'A1' } }],
          onDeactivate: [{ action: 'send', channel: 'canvas', data: { format: 'hex', value: 'D1' } }],
        } satisfies ScriptDocument;
      }
      if (command === 'send_serial_data') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await acquireChannelRuntimeLease(sharedChannelId, 'owner-1');
    await acquireChannelRuntimeLease(sharedChannelId, 'owner-2');

    const sentFrames = () => invokeMock.mock.calls
      .filter(([command]) => command === 'send_serial_data')
      .map(([, args]) => (args as { data: number[] }).data);
    expect(sentFrames()).toEqual([[0xD1]]);

    await releaseChannelRuntimeLease(sharedChannelId, 'owner-1', true);
    expect(sentFrames()).toEqual([[0xD1]]);

    await releaseChannelRuntimeLease(sharedChannelId, 'owner-2', true);
    await vi.waitFor(() => expect(sentFrames()).toEqual([[0xD1], [0xA1]]));
  });

  it('clears a channel owner without resuming lifecycle scripts after closing a script-owned connection', async () => {
    const ownedChannelId = 'script-owned-channel';
    const connectionId = 'COM42';
    useChannelStore.getState().addChannel('serial', 'Script-owned channel', ownedChannelId);
    useSerialStore.getState().setChannelConfig(ownedChannelId, { path: connectionId, baudRate: 115200 });

    const lifecycleCanvasId = useCanvasStore.getState().addCanvas({ x: 0, y: 0, width: 320, height: 180 });
    useCanvasStore.getState().updateCanvasConfig(lifecycleCanvasId, {
      channels: [{ channelId: ownedChannelId, protocolTemplateId: null }],
      lifecycleScript: {
        sourceType: 'file',
        luaPath: 'D:/script-owned-lifecycle.lua',
        enabled: true,
        runOnActivate: true,
        runOnDeactivate: false,
      },
    });

    invokeMock.mockImplementation(async (command) => {
      if (command === 'open_serial_port') return connectionId;
      if (command === 'close_serial_port') return undefined;
      if (command === 'parse_lua_canvas_lifecycle_file') {
        return {
          version: 1,
          name: 'script-owned lifecycle',
          onActivate: [{ action: 'log', message: 'activated' }],
        } satisfies ScriptDocument;
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'script-owned serial',
      setup: [{ action: 'open', channel: 'owned', channelType: 'serial', params: { channelId: ownedChannelId } }],
    });

    expect(invokeMock).toHaveBeenCalledWith('close_serial_port', { connectionId });
    expect(invokeMock).not.toHaveBeenCalledWith('parse_lua_canvas_lifecycle_file', expect.anything());

    const lifecycleCanvas = useCanvasStore.getState().canvases.find((canvas) => canvas.id === lifecycleCanvasId);
    expect(lifecycleCanvas).toBeDefined();
    await runCanvasLifecycleHook(lifecycleCanvas!, 'activate');
    expect(invokeMock).toHaveBeenCalledWith('parse_lua_canvas_lifecycle_file', {
      path: 'D:/script-owned-lifecycle.lua',
    });
  });

  it('accumulates fragmented serial data and extracts one CRC-valid torque frame', async () => {
    const torqueChannelId = 'remembered-torque';
    const connectionId = 'torque-connection';
    const frame = torqueFrame(10000, 1024);
    useChannelStore.getState().addChannel('serial', 'Torque', torqueChannelId);
    useSerialStore.getState().setChannelConfig(torqueChannelId, { path: 'COM10', baudRate: 115200 });
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'open_serial_port') return connectionId;
      if (command === 'send_serial_data') {
        ingestScriptPacket(benchCanvasId, {
          channelId: torqueChannelId,
          connectionId,
          data: [0xFF, ...frame.slice(0, 5)],
          timestamp: Date.now(),
          source: 'serial',
        });
        ingestScriptPacket(benchCanvasId, {
          channelId: torqueChannelId,
          connectionId,
          data: frame.slice(5),
          timestamp: Date.now(),
          source: 'serial',
        });
        return undefined;
      }
      if (command === 'call_lua_script_helper_file') {
        const bytes = (args as { args: { bytes: number[] } }).args.bytes;
        const crc = crc16Modbus(bytes.slice(0, 11));
        return { valid: bytes.length === 13
          && bytes[11] === (crc & 0xFF)
          && bytes[12] === ((crc >> 8) & 0xFF) };
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(benchCanvasId);
    await runtime.run({
      version: 1,
      name: 'fragmented torque response',
      helpers: { bench: { luaPath: 'helpers/bench-codec.lua' } },
      defaults: { timeoutMs: 50 },
      setup: [{ action: 'open', channel: 'torque', channelType: 'serial', params: { channelId: torqueChannelId } }],
      steps: [{
        action: 'request',
        channel: 'torque',
        send: { format: 'hex', value: '01 32 81 F5' },
        expect: {
          format: 'hex',
          startsWith: '01 32 08',
          length: 13,
          accumulate: true,
          luaHelper: {
            helper: 'bench',
            func: 'torqueFrameValid',
            args: { bytes: { $ref: 'packet.bytes' } },
            resultPath: 'valid',
            equals: true,
          },
        },
        saveAs: 'sample',
      }],
    });

    expect(runtime.getSnapshot().status).toBe('passed');
    expect(runtime.getSnapshot().variables?.sample).toMatchObject({ bytes: frame, length: 13 });
  });

  it('retries a torque request until a later attempt returns a valid frame', async () => {
    const torqueChannelId = 'retry-torque';
    const connectionId = 'retry-torque-connection';
    const frame = torqueFrame(10000, 1024);
    let sendAttempts = 0;
    useChannelStore.getState().addChannel('serial', 'Torque', torqueChannelId);
    useSerialStore.getState().setChannelConfig(torqueChannelId, { path: 'COM11', baudRate: 115200 });
    invokeMock.mockImplementation(async (command) => {
      if (command === 'open_serial_port') return connectionId;
      if (command === 'send_serial_data') {
        sendAttempts += 1;
        if (sendAttempts === 3) {
          ingestScriptPacket(benchCanvasId, {
            channelId: torqueChannelId,
            connectionId,
            data: frame,
            timestamp: Date.now(),
            source: 'serial',
          });
        }
        return undefined;
      }
      if (command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(benchCanvasId);
    await runtime.run({
      version: 1,
      name: 'retry torque response',
      defaults: { timeoutMs: 5 },
      setup: [{ action: 'open', display: 'hidden', channel: 'torque', channelType: 'serial', params: { channelId: torqueChannelId } }],
      steps: [{
        id: 'read-torque',
        action: 'request',
        channel: 'torque',
        send: { format: 'hex', value: '01 32 81 F5' },
        expect: { format: 'hex', startsWith: '01 32 08', length: 13, accumulate: true },
        retry: { times: 3 },
        saveAs: 'sample',
      }],
    });

    expect(runtime.getSnapshot().status).toBe('passed');
    expect(runtime.getSnapshot().variables?.sample).toMatchObject({ bytes: frame, length: 13 });
    expect(sendAttempts).toBe(3);
  });

  it('logs one failure when the same timeout propagates through nested steps', async () => {
    const torqueChannelId = 'timeout-torque';
    const connectionId = 'timeout-torque-connection';
    useChannelStore.getState().addChannel('serial', 'Torque', torqueChannelId);
    useSerialStore.getState().setChannelConfig(torqueChannelId, { path: 'COM12', baudRate: 115200 });
    invokeMock.mockImplementation(async (command) => {
      if (command === 'open_serial_port') return connectionId;
      if (command === 'send_serial_data' || command === 'close_serial_port') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(benchCanvasId);
    await runtime.run({
      version: 1,
      name: 'nested torque timeout',
      defaults: { timeoutMs: 5, stopOnFailure: true },
      setup: [{ action: 'open', display: 'hidden', channel: 'torque', channelType: 'serial', params: { channelId: torqueChannelId } }],
      steps: [{
        id: 'row',
        action: 'group',
        childDisplay: 'nested',
        steps: [{
          id: 'samples',
          action: 'repeat',
          times: 1,
          steps: [{
            id: 'read-torque',
            action: 'request',
            channel: 'torque',
            send: { format: 'hex', value: '01 32 81 F5' },
            expect: { format: 'hex', startsWith: '01 32 08' },
          }],
        }],
      }],
    });

    const snapshot = runtime.getSnapshot();
    const timeoutLogs = snapshot.logs.filter((entry) => (
      (entry.level === 'fail' || entry.level === 'error')
      && entry.message === 'Error: Timeout waiting for torque'
    ));
    expect(snapshot.status).toBe('failed');
    expect(snapshot.steps.find((step) => step.id === 'row')?.status).toBe('failed');
    expect(timeoutLogs).toHaveLength(1);
    expect(timeoutLogs[0].stepId).toBe('read-torque');
  });

  it('scans for a typed BLE device name and reuses the configured BLE channel', async () => {
    const configuredBleChannelId = 'configured-ble-channel';
    const targetName = 'D500V2-2574';
    useChannelStore.getState().addChannel('ble', 'BLE', configuredBleChannelId);

    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'start_ble_scan' || command === 'stop_ble_scan') return undefined;
      if (command === 'get_ble_devices') {
        return [{
          id: deviceId,
          name: targetName,
          advertisementName: targetName,
          rssi: -48,
          serviceUuids: [ftmsServiceUuid],
          manufacturerData: {},
          isConnectable: true,
        }];
      }
      if (command === 'connect_ble_device') {
        expect(args).toEqual({ deviceId });
        return undefined;
      }
      if (command === 'get_gatt_services') return [];
      if (command === 'disconnect_ble_device') return undefined;
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'portable BLE device selection',
      setup: [{
        action: 'open',
        channel: 'ftms',
        channelType: 'ble',
        params: {
          channelId: targetName,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
          subscribe: false,
        },
      }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
    expect(invokeMock).toHaveBeenCalledWith('start_ble_scan');
    expect(invokeMock).toHaveBeenCalledWith('get_ble_devices');
    expect(invokeMock).toHaveBeenCalledWith('stop_ble_scan');
    expect(invokeMock).toHaveBeenCalledWith('connect_ble_device', { deviceId });
    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(useChannelStore.getState().activeChannelId).toBe(configuredBleChannelId);
  });

  it('uses Lua-helper FTMS percent and power targets and matches each response', async () => {
    const ftmsChannelId = 'remembered-ftms';
    useChannelStore.getState().addChannel('ble', 'Trainer', ftmsChannelId);
    useBleStore.getState().setLastConnectedDeviceId(ftmsChannelId, deviceId);
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'connect_ble_device') {
        expect(args).toEqual({ deviceId });
        return undefined;
      }
      if (command === 'get_gatt_services') return [];
      if (command === 'disconnect_ble_device') return undefined;
      if (command === 'call_lua_script_helper_file') {
        const call = args as { func: string; args: { mode: string } };
        expect(call.func).toBe('prepareControl');
        return call.args.mode === 'percent'
          ? { ftmsCommandHex: '04 E8 03', ftmsResponsePrefix: '80 04 01' }
          : { ftmsCommandHex: '05 C8 00', ftmsResponsePrefix: '80 05 01' };
      }
      if (command === 'write_ble_characteristic') {
        const data = (args as { data: number[] }).data;
        if (data[0] === 0x04) expect(args).toMatchObject({
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
          data: [0x04, 0xE8, 0x03],
        });
        else expect(args).toMatchObject({
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
          data: [0x05, 0xC8, 0x00],
        });
        ingestScriptPacket(benchCanvasId, {
          channelId: ftmsChannelId,
          data: [0x80, data[0], 0x01],
          timestamp: Date.now(),
          source: 'ble',
          deviceId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
        });
        return undefined;
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'ftms percent',
      helpers: { bench: { luaPath: 'helpers/bench.lua' } },
      defaults: { timeoutMs: 50 },
      variables: {
        mode: 'percent',
        value: 50,
        rpm: 100,
        direction: 1,
        delay: 1,
        resistanceRange: { bytes: [0x00, 0x00, 0xD0, 0x07, 0x01, 0x00] },
      },
      setup: [{
        action: 'open',
        channel: 'ftms',
        channelType: 'ble',
        params: {
          channelId: ftmsChannelId,
          serviceUuid: ftmsServiceUuid,
          charUuid: controlPointCharUuid,
          subscribe: false,
        },
      }],
      steps: [{
        action: 'luaHelper',
        helper: 'bench',
        func: 'prepareControl',
        args: {
          rpm: { $ref: 'rpm' },
          direction: { $ref: 'direction' },
          mode: { $ref: 'mode' },
          value: { $ref: 'value' },
          resistanceRangeBytes: { $ref: 'resistanceRange.bytes' },
          delay: { $ref: 'delay' },
        },
        saveAs: 'rowControl',
      }, {
        action: 'request',
        channel: 'ftms',
        send: { format: 'hex', value: '${rowControl.ftmsCommandHex}' },
        expect: { startsWith: '${rowControl.ftmsResponsePrefix}' },
      }, {
        action: 'set',
        name: 'mode',
        value: 'power',
      }, {
        action: 'set',
        name: 'value',
        value: 200,
      }, {
        action: 'luaHelper',
        helper: 'bench',
        func: 'prepareControl',
        args: {
          rpm: { $ref: 'rpm' },
          direction: { $ref: 'direction' },
          mode: { $ref: 'mode' },
          value: { $ref: 'value' },
          resistanceRangeBytes: { $ref: 'resistanceRange.bytes' },
          delay: { $ref: 'delay' },
        },
        saveAs: 'rowControl',
      }, {
        action: 'request',
        channel: 'ftms',
        send: { format: 'hex', value: '${rowControl.ftmsCommandHex}' },
        expect: { startsWith: '${rowControl.ftmsResponsePrefix}' },
      }],
    });

    expect(getScriptRuntime(benchCanvasId).getSnapshot().status).toBe('passed');
  });

  it('creates one timestamped CSV log beside the executable for each run', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'import_from_file') return 'rpm,delay,mode,value\n100,1,power,150\n';
      if (command === 'get_executable_directory') return 'D:\\Apps\\LinkAssist';
      if (command === 'export_to_file' || command === 'append_to_file') return undefined;
      throw new Error(`Unexpected invoke call: ${command} ${JSON.stringify(args)}`);
    });

    await getScriptRuntime(benchCanvasId).run({
      version: 1,
      name: 'csv output',
      csv: { commands: { path: 'D:/input.csv', header: true } },
      csvLog: {
        result: {
          path: '${runTimestamp()}.csv',
          baseDir: 'executable',
          bom: true,
          columns: ['time', 'rpm'],
        },
      },
      steps: [{
        action: 'forEachCsv',
        source: 'commands',
        steps: [{ action: 'logCsv', target: 'result', row: { time: '${nowIso()}', rpm: '${row.rpm}' } }],
      }],
    });

    const exportCall = invokeMock.mock.calls.find(([command]) => command === 'export_to_file');
    const appendCall = invokeMock.mock.calls.find(([command]) => command === 'append_to_file');
    expect(exportCall?.[1]).toMatchObject({ path: expect.stringMatching(/^D:\\Apps\\LinkAssist\/\d{8}_\d{6}_\d{3}\.csv$/) });
    expect(appendCall?.[1]).toMatchObject({ path: exportCall?.[1] && (exportCall[1] as { path: string }).path });
    expect((exportCall?.[1] as { content: string }).content).toBe('\uFEFFtime,rpm\n');
  });

  it('writes headerless CSV rows whose label columns repeat on every row', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 7, 4, 13, 21, 14, 47));
      invokeMock.mockImplementation(async (command) => {
        if (command === 'export_to_file' || command === 'append_to_file') return undefined;
        throw new Error(`Unexpected invoke call: ${command}`);
      });

      await getScriptRuntime(benchCanvasId).run({
        version: 1,
        name: 'headerless labeled csv output',
        csvLog: {
          result: {
            path: 'D:/result.csv',
            bom: true,
            header: false,
            columns: ['time', 'torqueTitle', 'torqueValue'],
          },
        },
        steps: [{
          action: 'logCsv',
          target: 'result',
          row: {
            time: '${nowLocalTimestampSpace()}',
            torqueTitle: '扭矩',
            torqueValue: 4.783,
          },
        }],
      });

      expect(invokeMock).toHaveBeenCalledWith('export_to_file', { path: 'D:/result.csv', content: '\uFEFF' });
      expect(invokeMock).toHaveBeenCalledWith('append_to_file', {
        path: 'D:/result.csv',
        content: '2026-08-04 13:21:14 047,扭矩,4.783\n',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('evaluates nowTime and nowDateTime helpers with second precision', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 8, 16, 30, 15, 456));
      invokeMock.mockResolvedValue(undefined);
      await getScriptRuntime(benchCanvasId).run({
        version: 1,
        name: 'timestamp helpers',
        csvLog: {
          result: {
            path: 'D:/result.csv',
            bom: true,
            header: false,
            columns: ['time', 'datetime'],
          },
        },
        steps: [{
          action: 'logCsv',
          target: 'result',
          row: {
            time: '${nowTime()}',
            datetime: '${nowDateTime()}',
          },
        }],
      });

      expect(invokeMock).toHaveBeenCalledWith('append_to_file', {
        path: 'D:/result.csv',
        content: '16:30:15,2026-09-08 16:30:15\n',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares a fixed cadence across adjacent repeat steps', async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValue(undefined);
      const runPromise = getScriptRuntime(benchCanvasId).run({
        version: 1,
        name: 'fixed cadence',
        csvLog: { result: { path: 'D:/result.csv', columns: ['tick'] } },
        steps: [{
          id: 'first-window',
          action: 'repeat',
          times: 1,
          periodMs: 1000,
          schedule: 'samples',
          steps: [{ action: 'logCsv', target: 'result', row: { tick: '1' } }],
        }, {
          id: 'second-window',
          action: 'repeat',
          times: 1,
          periodMs: 1000,
          schedule: 'samples',
          steps: [{ action: 'logCsv', target: 'result', row: { tick: '2' } }],
        }],
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(invokeMock).not.toHaveBeenCalledWith('append_to_file', expect.anything());
      await vi.advanceTimersByTimeAsync(1);
      expect(invokeMock.mock.calls.filter(([command]) => command === 'append_to_file')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      await runPromise;
      expect(invokeMock.mock.calls.filter(([command]) => command === 'append_to_file')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loops the complete CSV only while the loop option remains active', async () => {
    const runtime = getScriptRuntime(benchCanvasId);
    let appendedRows = 0;
    invokeMock.mockImplementation(async (command) => {
      if (command === 'import_from_file') return 'rpm,delay,mode,value\n100,1,power,150\n';
      if (command === 'export_to_file') return undefined;
      if (command === 'append_to_file') {
        appendedRows += 1;
        if (appendedRows === 2) runtime.stop();
        return undefined;
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await runtime.run({
      version: 1,
      name: 'loop csv',
      csv: { commands: { path: 'D:/input.csv', header: true } },
      csvLog: { result: { path: 'D:/result.csv', columns: ['rpm'] } },
      steps: [{
        action: 'forEachCsv',
        source: 'commands',
        loop: true,
        steps: [{ action: 'logCsv', target: 'result', row: { rpm: '${row.rpm}' } }],
      }],
    });

    expect(appendedRows).toBe(2);
    expect(runtime.getSnapshot().status).toBe('stopped');
  });

  it('reloads CSV per row and executes dynamic modifications and additions', async () => {
    let importCount = 0;
    const runtime = getScriptRuntime(benchCanvasId);

    invokeMock.mockImplementation(async (command) => {
      if (command === 'import_from_file') {
        importCount += 1;
        if (importCount <= 2) {
          // Initial load and row 0: initial content
          return 'rpm,delay\n100,1\n200,1\n';
        }
        // When executing row 1 and row 2: dynamically modified row 1 and added row 2
        return 'rpm,delay\n100,1\n350,5\n450,10\n';
      }
      if (command === 'export_to_file' || command === 'append_to_file') {
        return undefined;
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await runtime.run({
      version: 1,
      name: 'dynamic csv reload',
      csv: { commands: { path: 'D:/input.csv', header: true, reloadPerRow: true } },
      csvLog: { result: { path: 'D:/result.csv', columns: ['rpm'] } },
      steps: [{
        action: 'forEachCsv',
        source: 'commands',
        steps: [{ action: 'logCsv', target: 'result', row: { rpm: '${row.rpm}' } }],
      }],
    });

    expect(invokeMock).toHaveBeenCalledWith('append_to_file', { path: 'D:/result.csv', content: '100\n' });
    expect(invokeMock).toHaveBeenCalledWith('append_to_file', { path: 'D:/result.csv', content: '350\n' });
    expect(invokeMock).toHaveBeenCalledWith('append_to_file', { path: 'D:/result.csv', content: '450\n' });
    expect(runtime.getSnapshot().status).toBe('passed');
  });

  it('retries on transient file read error during dynamic reload', async () => {
    let importCount = 0;
    const runtime = getScriptRuntime(benchCanvasId);

    invokeMock.mockImplementation(async (command) => {
      if (command === 'import_from_file') {
        importCount += 1;
        if (importCount === 1) {
          return 'rpm\n100\n200\n';
        }
        if (importCount === 2) {
          // Transient lock error on first retry attempt of row 0 reload
          throw new Error('file temporarily locked by Excel');
        }
        return 'rpm\n100\n200\n';
      }
      if (command === 'export_to_file' || command === 'append_to_file') {
        return undefined;
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    await runtime.run({
      version: 1,
      name: 'dynamic csv retry',
      csv: { commands: { path: 'D:/input.csv', header: true } },
      csvLog: { result: { path: 'D:/result.csv', columns: ['rpm'] } },
      steps: [{
        action: 'forEachCsv',
        source: 'commands',
        reloadPerRow: true,
        steps: [{ action: 'logCsv', target: 'result', row: { rpm: '${row.rpm}' } }],
      }],
    });

    expect(invokeMock).toHaveBeenCalledWith('append_to_file', { path: 'D:/result.csv', content: '100\n' });
    expect(invokeMock).toHaveBeenCalledWith('append_to_file', { path: 'D:/result.csv', content: '200\n' });
    expect(runtime.getSnapshot().status).toBe('passed');
  });
});

describe('ScriptRuntime canvas lifecycle bindings', () => {
  const lifecycleCanvasId = 'lifecycle-runtime-test-canvas';

  beforeEach(() => {
    invokeMock.mockReset();
    disposeScriptRuntime(lifecycleCanvasId);
  });

  afterEach(() => {
    disposeScriptRuntime(lifecycleCanvasId);
  });

  it('sends through a prebound canvas channel alias', async () => {
    invokeMock.mockResolvedValue(undefined);

    const runtime = getScriptRuntime(lifecycleCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'lifecycle',
      defaults: {
        stopOnFailure: true,
        timeoutMs: 50,
        dataFormat: 'hex',
      },
      onActivate: [
        {
          id: 'send-init',
          action: 'send',
          channel: 'canvas',
          data: {
            format: 'hex',
            value: 'AA 55',
          },
        },
      ],
    };

    await runtime.runLifecycle(document, 'onActivate', [
      {
        alias: 'canvas',
        channelType: 'serial',
        uiChannelId: 'serial-channel-1',
        connectionId: 'serial-connection-1',
        closeOnCleanup: false,
      },
    ]);

    expect(invokeMock).toHaveBeenCalledWith('send_serial_data', {
      connectionId: 'serial-connection-1',
      data: [0xAA, 0x55],
    });
    expect(runtime.getSnapshot().status).toBe('passed');
  });
});

describe('ScriptRuntime pytest testRun action', () => {
  const testRunCanvasId = 'test-run-runtime-canvas';

  beforeEach(() => {
    invokeMock.mockReset();
    disposeScriptRuntime(testRunCanvasId);
  });

  afterEach(() => {
    disposeScriptRuntime(testRunCanvasId);
  });

  it('starts a structured selection and saves a passed snapshot', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'start_test_run') {
        expect(args).toEqual({
          request: {
            projectRoot: 'D:/project',
            pythonPath: undefined,
            profile: 'quick',
            nodeIds: ['tests/test_smoke.py::test_smoke'],
            inputs: { DEVICE: 'demo-1' },
            allowDestructive: false,
          },
        });
        return {
          runId: 'run-1',
          status: 'passed',
          projectRoot: 'D:/project',
          profile: 'quick',
          nodeIds: ['tests/test_smoke.py::test_smoke'],
          exitCode: 0,
          logs: [{
            runId: 'run-1',
            seq: 1,
            eventType: 'test-result',
            timestamp: 1000,
            nodeId: 'tests/test_smoke.py::test_smoke',
            outcome: 'passed',
            message: 'passed',
          }],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'pytest smoke',
      variables: { deviceId: 'demo-1' },
      steps: [{
        id: 'pytest',
        action: 'testRun',
        projectRoot: 'D:/project',
        profile: 'quick',
        nodeIds: ['tests/test_smoke.py::test_smoke'],
        inputs: { DEVICE: '${deviceId}' },
        saveAs: 'result',
      }],
    };

    await runtime.run(document);

    expect(runtime.getSnapshot().status).toBe('passed');
    expect(runtime.getSnapshot().logs.some((entry) => entry.message.includes('test-result'))).toBe(true);
  });

  it('loads catalog data and resolves typed UI references in named handlers', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'load_test_runner_catalog') {
        expect(args).toEqual({ request: { projectRoot: 'D:/project', pythonPath: undefined } });
        return {
          schemaVersion: 1,
          runnerId: 'project',
          catalogRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          title: 'Project tests',
          profiles: [{ id: 'quick', title: 'Quick', danger: 'safe' }],
          tests: [],
        };
      }
      if (command === 'start_test_run') {
        expect(args).toEqual({
          request: {
            projectRoot: 'D:/project',
            pythonPath: undefined,
            profile: undefined,
            nodeIds: ['tests/test_one.py::test_one'],
            inputs: { DEVICE: 'demo' },
            allowDestructive: false,
            catalogRevision: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          },
        });
        return {
          runId: 'run-handler',
          status: 'passed',
          projectRoot: 'D:/project',
          nodeIds: ['tests/test_one.py::test_one'],
          logs: [],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'interactive pytest',
      variables: { form: { projectRoot: 'D:/project', profile: 'quick', nodeIds: [], inputs: {} } },
      handlers: {
        load: [{ action: 'testCatalog', projectRoot: '${form.projectRoot}', saveAs: 'catalog' }],
        run: [{
          action: 'testRun',
          projectRoot: '${form.projectRoot}',
          profile: '${form.profile}',
          nodeIds: { $ref: 'form.nodeIds' },
          inputs: { $ref: 'form.inputs' },
          selectionMode: 'exact-or-profile',
          catalogSource: 'catalog',
          catalogRevision: { $ref: 'catalog.catalogRevision' },
          saveAs: 'lastRun',
        }],
      },
    };

    runtime.initializeInteractive(document);
    await runtime.runHandler(document, 'load', { form: { projectRoot: 'D:/project' } });
    expect(runtime.getSnapshot().variables?.catalog).toMatchObject({ runnerId: 'project' });

    await runtime.runHandler(document, 'run', {
      form: {
        projectRoot: 'D:/project',
        profile: 'quick',
        nodeIds: ['tests/test_one.py::test_one'],
        inputs: { DEVICE: 'demo' },
      },
    });
    expect(runtime.getSnapshot().variables?.lastRun).toMatchObject({ runId: 'run-handler', status: 'passed' });
  });

  it('infers destructive authorization and preserves semantic test log levels', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'start_test_run') {
        expect(args).toEqual({
          request: {
            projectRoot: 'D:/project',
            pythonPath: undefined,
            profile: undefined,
            nodeIds: ['tests/test_ota.py::test_ota'],
            inputs: {},
            allowDestructive: true,
          },
        });
        return {
          runId: 'run-destructive',
          status: 'passed',
          projectRoot: 'D:/project',
          nodeIds: ['tests/test_ota.py::test_ota'],
          logs: [{
            runId: 'run-destructive',
            seq: 1,
            eventType: 'log',
            timestamp: 1000,
            stream: 'stderr',
            message: '[flow ota] step=10 chunks 10/100',
            data: { level: 'progress' },
          }, {
            runId: 'run-destructive',
            seq: 2,
            eventType: 'log',
            timestamp: 1100,
            stream: 'stderr',
            message: 'TypeError: fetch failed',
          }, {
            runId: 'run-destructive',
            seq: 3,
            eventType: 'log',
            timestamp: 1200,
            stream: 'stderr',
            message: '[srap data] nodeId = 4660',
            data: { level: 'info' },
          }, {
            runId: 'run-destructive',
            seq: 4,
            eventType: 'log',
            timestamp: 1300,
            stream: 'stderr',
            message: '[srap result] response timeout',
            data: { level: 'warning' },
          }],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'destructive pytest',
      variables: {
        catalog: {
          schemaVersion: 1,
          runnerId: 'fixture',
          title: 'Fixture',
          profiles: [],
          tests: [{
            nodeId: 'tests/test_ota.py::test_ota',
            id: 'ota',
            title: 'OTA',
            kind: 'flow',
            tags: ['destructive'],
            requires: [],
            requiredInputs: [],
            file: 'tests/test_ota.py',
            danger: 'destructive',
          }],
        },
      },
      handlers: {
        run: [{
          action: 'testRun',
          projectRoot: 'D:/project',
          nodeIds: ['tests/test_ota.py::test_ota'],
          selectionMode: 'exact-or-profile',
          catalogSource: 'catalog',
        }],
      },
    };

    try {
      runtime.initializeInteractive(document);
      await runtime.runHandler(document, 'run');
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      confirm.mockRestore();
    }

    expect(runtime.getSnapshot().logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        level: 'pass',
        message: expect.stringContaining('[flow ota] step=10 chunks 10/100'),
      }),
      expect.objectContaining({
        level: 'error',
        message: expect.stringContaining('TypeError: fetch failed'),
      }),
      expect.objectContaining({
        level: 'info',
        message: '[srap data] nodeId = 4660',
      }),
      expect.objectContaining({
        level: 'fail',
        message: '[srap result] response timeout',
      }),
    ]));
  });

  it('ignores stale exact selections outside the active profile', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'start_test_run') {
        expect(args).toEqual({
          request: {
            projectRoot: 'D:/project',
            pythonPath: undefined,
            profile: 'quick',
            nodeIds: undefined,
            inputs: {},
            allowDestructive: false,
          },
        });
        return {
          runId: 'run-profile',
          status: 'passed',
          projectRoot: 'D:/project',
          profile: 'quick',
          nodeIds: [],
          logs: [],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'profile filtering',
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
            title: 'Fast',
            kind: 'unit',
            tags: ['fast'],
            requires: [],
            file: 'tests/test_fast.py',
            danger: 'safe',
          }, {
            nodeId: 'tests/test_device.py::test_device',
            id: 'device',
            title: 'Device',
            kind: 'device',
            tags: ['device'],
            requires: [],
            file: 'tests/test_device.py',
            danger: 'destructive',
          }],
        },
      },
      handlers: {
        run: [{
          action: 'testRun',
          projectRoot: 'D:/project',
          profile: 'quick',
          nodeIds: ['tests/test_device.py::test_device'],
          selectionMode: 'exact-or-profile',
          catalogSource: 'catalog',
          saveAs: 'lastRun',
        }],
      },
    };

    runtime.initializeInteractive(document);
    await runtime.runHandler(document, 'run');
    expect(runtime.getSnapshot().error).toBeUndefined();
    expect(runtime.getSnapshot().variables?.lastRun).toMatchObject({
      runId: 'run-profile',
      status: 'passed',
    });
  });

  it('cancels the active backend run when the canvas is stopped', async () => {
    let resolveStart!: (value: unknown) => void;
    let markStartInvoked!: () => void;
    const startResponse = new Promise((resolve) => { resolveStart = resolve; });
    const startInvoked = new Promise<void>((resolve) => { markStartInvoked = resolve; });
    invokeMock.mockImplementation(async (command) => {
      if (command === 'start_test_run') {
        markStartInvoked();
        return startResponse;
      }
      if (command === 'cancel_test_run') {
        return {
          runId: 'run-cancel',
          status: 'cancelled',
          projectRoot: 'D:/project',
          nodeIds: [],
          logs: [],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    const runPromise = runtime.run({
      version: 1,
      name: 'cancel pytest',
      steps: [{ action: 'testRun', projectRoot: 'D:/project', profile: 'quick' }],
    });
    await startInvoked;
    runtime.stop();
    resolveStart({
      runId: 'run-cancel',
      status: 'running',
      projectRoot: 'D:/project',
      profile: 'quick',
      nodeIds: [],
      logs: [],
    });
    await runPromise;

    expect(invokeMock).toHaveBeenCalledWith('cancel_test_run', { request: { runId: 'run-cancel' } });
    expect(runtime.getSnapshot().status).toBe('stopped');
  });

  it('polls structured logs incrementally and ignores an overlapping event', async () => {
    invokeMock.mockImplementation(async (command, args) => {
      if (command === 'start_test_run') {
        return {
          runId: 'run-incremental',
          status: 'running',
          projectRoot: 'D:/project',
          nodeIds: [],
          logs: [{
            runId: 'run-incremental',
            seq: 1,
            eventType: 'log',
            timestamp: 1000,
            message: 'first event',
          }],
        };
      }
      if (command === 'get_test_run') {
        expect(args).toEqual({
          request: { runId: 'run-incremental', afterSeq: 1, limit: 500 },
        });
        return {
          runId: 'run-incremental',
          status: 'passed',
          projectRoot: 'D:/project',
          nodeIds: [],
          finishedAt: 2000,
          logs: [
            {
              runId: 'run-incremental',
              seq: 1,
              eventType: 'log',
              timestamp: 1000,
              message: 'first event',
            },
            {
              runId: 'run-incremental',
              seq: 2,
              eventType: 'run-finish',
              timestamp: 2000,
              message: 'finished',
            },
          ],
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    await runtime.run({
      version: 1,
      name: 'incremental pytest',
      defaults: { logLimit: 2000 },
      steps: [{ action: 'testRun', projectRoot: 'D:/project' }],
    });

    const firstEventLogs = runtime.getSnapshot().logs
      .filter((entry) => entry.message.includes('first event'));
    expect(firstEventLogs).toHaveLength(1);
    expect(runtime.getSnapshot().status).toBe('passed');
  });

  it('caps a large backend event batch and configured canvas logs at 2000', async () => {
    const events = Array.from({ length: 2105 }, (_, seq) => ({
      runId: 'run-large',
      seq,
      eventType: 'log',
      timestamp: seq,
      message: `event-${seq}`,
    }));
    invokeMock.mockImplementation(async (command) => {
      if (command === 'start_test_run') {
        return {
          runId: 'run-large',
          status: 'passed',
          projectRoot: 'D:/project',
          nodeIds: [],
          logs: events,
        };
      }
      throw new Error(`Unexpected invoke call: ${command}`);
    });

    const runtime = getScriptRuntime(testRunCanvasId);
    await runtime.run({
      version: 1,
      name: 'large pytest log',
      defaults: { logLimit: 10_000 },
      steps: [{ action: 'testRun', projectRoot: 'D:/project' }],
    });

    const logs = runtime.getSnapshot().logs;
    expect(logs).toHaveLength(2000);
    expect(logs.some((entry) => entry.message.includes('event-0'))).toBe(false);
    expect(logs.some((entry) => entry.message.includes('event-2104'))).toBe(true);
  });

  it('can refresh secondary data without clearing the current live log', async () => {
    const runtime = getScriptRuntime(testRunCanvasId);
    const document: ScriptDocument = {
      version: 1,
      name: 'preserved log',
      handlers: {
        run: [{ action: 'log', message: 'pytest result' }],
        refresh: [{ action: 'log', message: 'history refreshed' }],
      },
    };

    runtime.initializeInteractive(document);
    await runtime.runHandler(document, 'run');
    await runtime.runHandler(document, 'refresh', {}, { preserveLogs: true });

    expect(runtime.getSnapshot().logs.some((entry) => entry.message === 'pytest result')).toBe(true);
    expect(runtime.getSnapshot().logs.some((entry) => entry.message === 'history refreshed')).toBe(true);
  });
});
