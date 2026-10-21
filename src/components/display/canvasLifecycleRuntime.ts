import { useBleStore, useCanvasStore, useChannelStore, useSerialStore, useTcpStore } from '../../stores';
import type { Canvas, CanvasChannelLink, Channel } from '../../types';
import {
  disposeScriptRuntime,
  getScriptRuntime,
  ingestScriptPacket,
  type ScriptRuntimeChannelBinding,
  type ScriptRuntimeLifecycleHook,
} from './scriptRuntime';
import { registerChannelRuntimeLeasePort } from './channelRuntimeLease';
import { parseCanvasLifecycleLuaFile } from './scriptLua';
import type { ScriptDocument, ScriptInboundPacket } from './scriptTypes';

export type CanvasLifecycleHookName = 'activate' | 'deactivate';

const RUNTIME_PREFIX = 'lifecycle:';
const runTokens = new Map<string, number>();
const runPromises = new Map<string, Promise<void>>();
const skipNextDeactivateHooks = new Set<string>();
const suspendedChannelOwners = new Map<string, Set<string>>();

const canvasLifecycleChannelLeasePort = {
  acquire: suspendLinkedCanvasLifecycles,
  release: resumeLinkedCanvasLifecycles,
};

export function initializeCanvasLifecycleRuntime(): void {
  registerChannelRuntimeLeasePort(canvasLifecycleChannelLeasePort);
}

export function getCanvasLifecycleRuntimeId(canvasId: string): string {
  return `${RUNTIME_PREFIX}${canvasId}`;
}

export function hasCanvasLifecycleScript(canvas: Canvas): boolean {
  if (canvas.config.type !== 'table' && canvas.config.type !== 'chart' && canvas.config.type !== 'form') return false;
  const config = canvas.config.lifecycleScript;
  return config?.enabled === true && Boolean(config.luaPath);
}

export async function runCanvasLifecycleHook(canvas: Canvas, hook: CanvasLifecycleHookName): Promise<void> {
  if (!hasCanvasLifecycleScript(canvas)) return;
  if (hook === 'activate' && isCanvasLifecycleSuspended(canvas)) return;

  const config = canvas.config.lifecycleScript;
  if (!config?.luaPath) return;
  if (hook === 'activate' && config.runOnActivate === false) return;
  if (hook === 'deactivate' && skipNextDeactivateHooks.delete(canvas.id)) return;

  const runtimeId = getCanvasLifecycleRuntimeId(canvas.id);
  const runtime = getScriptRuntime(runtimeId);
  const token = (runTokens.get(runtimeId) ?? 0) + 1;
  runTokens.set(runtimeId, token);

  runtime.stop();
  const previousRun = runPromises.get(runtimeId);
  if (previousRun) {
    await previousRun.catch(() => undefined);
    if (runPromises.get(runtimeId) === previousRun) runPromises.delete(runtimeId);
  }
  if (runTokens.get(runtimeId) !== token) return;
  if (hook === 'deactivate' && config.runOnDeactivate === false) return;

  const bindings = buildCanvasChannelBindings(canvas);
  if (hook === 'deactivate' && bindings.length === 0) return;

  const parsedDocument = await parseCanvasLifecycleLuaFile(config.luaPath);
  if (runTokens.get(runtimeId) !== token) return;

  const document = mergeLifecycleConfig(parsedDocument, canvas, hook);
  const hookKey: ScriptRuntimeLifecycleHook = hook === 'activate' ? 'onActivate' : 'onDeactivate';
  const promise = runtime.runLifecycle(document, hookKey, bindings);
  runPromises.set(runtimeId, promise);

  try {
    await promise;
    const snapshot = runtime.getSnapshot();
    if (snapshot.status === 'failed') {
      throw new Error(snapshot.error ?? 'Canvas lifecycle script failed');
    }
  } finally {
    if (runTokens.get(runtimeId) === token) {
      runPromises.delete(runtimeId);
    }
  }
}

export async function suspendLinkedCanvasLifecycles(channelId: string, ownerId: string): Promise<void> {
  const owners = suspendedChannelOwners.get(channelId) ?? new Set<string>();
  const alreadySuspended = owners.size > 0;
  owners.add(ownerId);
  suspendedChannelOwners.set(channelId, owners);
  if (alreadySuspended) return;

  const canvases = useCanvasStore.getState().canvases.filter((canvas) => (
    canvas.active
    && hasCanvasLifecycleScript(canvas)
    && canvas.config.channels.some((link) => link.channelId === channelId)
  ));

  for (const canvas of canvases) {
    try {
      await runCanvasLifecycleHook(canvas, 'deactivate');
    } catch (error) {
      console.warn(`Canvas lifecycle suspend failed for ${canvas.id}:`, error);
    }
  }
}

export async function resumeLinkedCanvasLifecycles(channelId: string, ownerId: string, resume: boolean): Promise<void> {
  const owners = suspendedChannelOwners.get(channelId);
  if (!owners) return;
  owners.delete(ownerId);
  if (owners.size > 0) return;
  suspendedChannelOwners.delete(channelId);
  if (!resume) return;

  const canvases = useCanvasStore.getState().canvases.filter((canvas) => (
    canvas.active
    && hasCanvasLifecycleScript(canvas)
    && canvas.config.channels.some((link) => link.channelId === channelId)
    && !isCanvasLifecycleSuspended(canvas)
  ));

  for (const canvas of canvases) {
    void runCanvasLifecycleHook(canvas, 'activate').catch((error) => {
      console.warn(`Canvas lifecycle resume failed for ${canvas.id}:`, error);
    });
  }
}

export async function runLinkedCanvasDeactivateHooks(channelId: string): Promise<void> {
  const canvases = useCanvasStore.getState().canvases.filter((canvas) => (
    canvas.active
    && hasCanvasLifecycleScript(canvas)
    && canvas.config.channels.some((link) => link.channelId === channelId)
  ));

  for (const canvas of canvases) {
    try {
      await runCanvasLifecycleHook(canvas, 'deactivate');
    } catch (error) {
      console.warn(`Canvas lifecycle deactivate before channel close failed for ${canvas.id}:`, error);
    } finally {
      skipNextDeactivateHooks.add(canvas.id);
    }
  }
}

export function ingestCanvasLifecyclePacket(canvasId: string, packet: ScriptInboundPacket): boolean {
  return ingestScriptPacket(getCanvasLifecycleRuntimeId(canvasId), packet);
}

export function disposeCanvasLifecycleRuntime(canvasId: string): void {
  const runtimeId = getCanvasLifecycleRuntimeId(canvasId);
  runTokens.set(runtimeId, (runTokens.get(runtimeId) ?? 0) + 1);
  runPromises.delete(runtimeId);
  disposeScriptRuntime(runtimeId);
}

function mergeLifecycleConfig(document: ScriptDocument, canvas: Canvas, hook: CanvasLifecycleHookName): ScriptDocument {
  const config = canvas.config.lifecycleScript;
  return {
    ...document,
    defaults: {
      stopOnFailure: config?.stopOnFailure ?? true,
      timeoutMs: config?.defaultTimeoutMs ?? 2000,
      dataFormat: config?.defaultDataFormat ?? 'hex',
      logLimit: config?.logLimit ?? 200,
      ...document.defaults,
    },
    variables: {
      ...document.variables,
      lifecycle: {
        hook,
        canvasId: canvas.id,
        canvasName: canvas.name,
        canvasType: canvas.config.type,
      },
    },
  };
}

function buildCanvasChannelBindings(canvas: Canvas): ScriptRuntimeChannelBinding[] {
  const bindings: ScriptRuntimeChannelBinding[] = [];

  canvas.config.channels.forEach((link, index) => {
    const binding = buildChannelBinding(link);
    if (!binding) return;

    if (index === 0) {
      bindings.push({ ...binding, alias: 'canvas' });
    }
    bindings.push({ ...binding, alias: `ch${index + 1}` });
  });

  return bindings;
}

function isCanvasLifecycleSuspended(canvas: Canvas): boolean {
  return canvas.config.channels.some((link) => (suspendedChannelOwners.get(link.channelId)?.size ?? 0) > 0);
}

function buildChannelBinding(link: CanvasChannelLink): Omit<ScriptRuntimeChannelBinding, 'alias'> | null {
  const channel = useChannelStore.getState().channels.find((item) => item.id === link.channelId);
  if (!channel) return null;

  if (channel.type === 'serial') {
    return buildSerialBinding(channel);
  }

  if (channel.type === 'tcp') {
    return buildTcpBinding(channel);
  }

  return buildBleBinding(channel, link);
}

function buildSerialBinding(channel: Channel): Omit<ScriptRuntimeChannelBinding, 'alias'> | null {
  const connectionId = Object.entries(useSerialStore.getState().connectionMap)
    .find(([, channelId]) => channelId === channel.id)?.[0];
  if (!connectionId) return null;

  return {
    channelType: 'serial',
    uiChannelId: channel.id,
    connectionId,
    closeOnCleanup: false,
  };
}

function buildTcpBinding(channel: Channel): Omit<ScriptRuntimeChannelBinding, 'alias'> | null {
  const tcpState = useTcpStore.getState();
  const config = tcpState.channelConfigs[channel.id];

  if (config?.mode === 'udp') {
    const connectionId = Object.entries(tcpState.connectionMap)
      .find(([id, channelId]) => id.startsWith('udp:') && channelId === channel.id)?.[0]
      ?? (tcpState.udpBound && tcpState.udpAddr ? `udp:${tcpState.udpAddr}` : '');
    if (!connectionId) return null;

    return {
      channelType: 'udp',
      uiChannelId: channel.id,
      connectionId,
      targetAddr: config.udpTargetAddress || connectionId.replace(/^udp:/, ''),
      closeOnCleanup: false,
    };
  }

  if (config?.mode === 'server' || Object.entries(tcpState.connectionMap).some(([id, channelId]) => id.startsWith('server:') && channelId === channel.id)) {
    // Prefer a client routed to this channel; fall back to the first one.
    const client = tcpState.serverClients.find((item) => tcpState.connectionMap[item.id] === channel.id)
      ?? tcpState.serverClients[0];
    if (!client) return null;

    return {
      channelType: 'tcp-server',
      uiChannelId: channel.id,
      connectionId: client.id,
      closeOnCleanup: false,
    };
  }

  const clientConnection = tcpState.clientConnections.find((connection) => tcpState.connectionMap[connection.id] === channel.id);
  if (!clientConnection) return null;

  return {
    channelType: 'tcp-client',
    uiChannelId: channel.id,
    connectionId: clientConnection.id,
    closeOnCleanup: false,
  };
}

function buildBleBinding(channel: Channel, link: CanvasChannelLink): Omit<ScriptRuntimeChannelBinding, 'alias'> | null {
  const target = link.bleTarget;
  if (!target?.serviceUuid || !target.charUuid) return null;

  const bleState = useBleStore.getState();
  const deviceId = bleState.getConnectedDeviceIdForChannel(channel.id)
    ?? (bleState.connectedChannelId === channel.id ? bleState.connectedDeviceId : null);
  if (!deviceId) return null;

  return {
    channelType: 'ble',
    uiChannelId: channel.id,
    connectionId: deviceId,
    closeOnCleanup: false,
    bleDeviceId: deviceId,
    bleServiceUuid: normalizeBleUuid(target.serviceUuid),
    bleCharUuid: normalizeBleUuid(target.charUuid),
  };
}

function normalizeBleUuid(value: string): string {
  return value.trim().toLowerCase();
}
