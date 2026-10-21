// Native integration tests. Build first: cargo build --manifest-path src-tauri/Cargo.toml
// Each run uses an empty portable snapshot, isolated configuration and loopback ports.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.LINKASSIST_TEST_BINARY
  ?? path.join(root, 'src-tauri/target/debug/linkassist.exe');
let core, sandbox, env, portable, discovery, coreExited;
const sockets = new Set();
let diagnostics = '';

async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function http(route, { body, token = discovery.token, method = body ? 'POST' : 'GET' } = {}) {
  return fetch(`http://127.0.0.1:${discovery.port}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
}

async function tool(name, args = {}, expectedOk = true) {
  const response = await http(`/mcp/tools/${name}/call`, { body: { arguments: args } });
  assert.equal(response.status, 200, name);
  const json = await response.json();
  assert.equal(json.ok, expectedOk, `${name}: ${json.error ?? 'unexpected success'}`);
  if (!expectedOk) assert.equal(typeof json.error, 'string');
  return expectedOk ? json.result : json;
}

function remember(socket) {
  sockets.add(socket);
  return socket;
}

async function readBytes(socket, length) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => socket.destroy(new Error('TCP receive timeout')), 5000);
  try {
    for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= length) return Buffer.concat(chunks);
    }
    throw new Error(`TCP closed after ${size}/${length} bytes`);
  } finally {
    clearTimeout(timer);
  }
}

before(async () => {
  await mkdir(path.join(root, 'logs'), { recursive: true });
  sandbox = await mkdtemp(path.join(root, 'logs/core-smoke-'));
  const roaming = path.join(sandbox, 'roaming');
  const local = path.join(sandbox, 'local');
  await mkdir(path.join(roaming, 'com.linkassist.desktop'), { recursive: true });
  await mkdir(local);
  env = { ...process.env, APPDATA: roaming, LOCALAPPDATA: local, TEMP: sandbox, TMP: sandbox };
  await writeFile(path.join(roaming, 'com.linkassist.desktop/config.json'), JSON.stringify({
    channels: [],
    ui: { left_panel_width: 48, right_panel_width: 360, data_view_mode: 'text', simple_mode: true },
    protocol: { mode: 'Passthrough', field_definitions: [], lua_script: '' },
  }));
  portable = path.join(sandbox, 'fixture.exe');
  const snapshot = spawnSync(binary, ['snapshot', portable], {
    env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(snapshot.error);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const id = snapshot.stdout.match(/Snapshot ID: ([a-f0-9]{64})/)?.[1];
  assert.ok(id, 'snapshot CLI must return a payload ID');
  const discoveryFile = path.join(local, 'LinkAssist/Snapshots', id, 'core/core-discovery.json');
  core = spawn(portable, ['--core-headless'], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  coreExited = once(core, 'exit');
  core.stdout.on('data', data => { diagnostics += data; });
  core.stderr.on('data', data => { diagnostics += data; });
  discovery = await until(async () => {
    assert.equal(core.exitCode, null, `Core exited during startup: ${diagnostics}`);
    try { return JSON.parse(await readFile(discoveryFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }, 'Core discovery was not created', 20000);
  assert.equal(discovery.pid, core.pid, 'must use this test process, never an existing user Core');
}, { timeout: 55000 });

after(async () => {
  for (const socket of sockets) {
    if (socket instanceof net.Socket) socket.destroy();
    else { try { socket.close(); } catch { /* already closed */ } }
  }
  if (core && core.exitCode === null && discovery) {
    await http('/core/shutdown', { method: 'POST' }).catch(() => {});
    await Promise.race([coreExited, delay(6000)]);
  }
  if (core && core.exitCode === null) {
    core.kill();
    await coreExited;
  }
  if (sandbox) await writeFile(path.join(sandbox, 'core.log'), diagnostics);
});

test('Core rejects absent/wrong tokens and accepts the owning token', async () => {
  assert.equal((await http('/health', { token: '' })).status, 401);
  assert.equal((await http('/health', { token: 'wrong-token' })).status, 401);
  assert.deepEqual(await (await http('/health')).json(), { ok: true, addr: '127.0.0.1' });
  assert.equal((await http('/mcp/tools/list', { token: '' })).status, 401);
});

test('tool registry is unique, includes transport tools and rejects invalid calls', async () => {
  const { tools } = await (await http('/mcp/tools/list')).json();
  const names = tools.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of ['tcp_connect', 'tcp_server_start', 'udp_bind', 'protocol_parse_data']) assert.ok(names.includes(name));
  await tool('not_a_real_tool', {}, false);
  await tool('tcp_connect', {}, false);
  for (const data of [[-1], [256], [1.5], ['1']]) {
    const failure = await tool('tcp_send', { connectionId: 'missing', data }, false);
    assert.match(failure.error, /invalid (?:value|type)|outside 0\.\.=255/);
  }
});

test('TCP client sends exact bytes to a real loopback peer and explicitly disconnects', async () => {
  const server = remember(net.createServer());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const { connectionId } = await tool('tcp_connect', { addr: `127.0.0.1:${server.address().port}`, channelId: 'smoke-client' });
  const [peer] = await accepted;
  remember(peer);
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const received = readBytes(peer, bytes.length);
  assert.equal((await tool('tcp_send', { connectionId, data: [...bytes] })).bytesWritten, bytes.length);
  assert.deepEqual(await received, bytes);
  assert.ok((await tool('tcp_list_connections')).connections.some(item => item.id === connectionId));
  await tool('tcp_disconnect', { connectionId });
  assert.ok(!(await tool('tcp_list_connections')).connections.some(item => item.id === connectionId));
  await tool('tcp_send', { connectionId, data: [1] }, false);
  peer.destroy();
  server.close();
});

test('TCP server accepts, sends binary data, detects peer closure and rebinds its port', async () => {
  const { addr } = await tool('tcp_server_start', { addr: '127.0.0.1:0' });
  const peer = remember(net.createConnection({ host: '127.0.0.1', port: Number(addr.split(':').at(-1)) }));
  await once(peer, 'connect');
  const clients = await until(async () => {
    const { clients } = await tool('tcp_server_list_clients');
    return clients.length ? clients : null;
  }, 'server did not accept loopback client');
  assert.equal(clients.length, 1);
  const bytes = Buffer.from([255, 0, 42]);
  const received = readBytes(peer, bytes.length);
  assert.equal((await tool('tcp_server_send', { clientId: clients[0].id, data: [...bytes] })).bytesWritten, bytes.length);
  assert.deepEqual(await received, bytes);
  peer.end();
  await until(async () => (await tool('tcp_server_list_clients')).clients.length === 0, 'closed client retained by server');
  for (let iteration = 0; iteration < 5; iteration++) {
    assert.equal((await tool('tcp_server_start', { addr })).addr, addr);
  }
  await tool('tcp_server_stop');
  assert.equal((await tool('tcp_server_start', { addr })).addr, addr);
  await tool('tcp_server_stop');
});

test('UDP sends an exact datagram, rebinds and rejects sending after unbind', async () => {
  const peer = remember(dgram.createSocket('udp4'));
  peer.bind(0, '127.0.0.1');
  await once(peer, 'listening');
  const { addr } = await tool('udp_bind', { addr: '127.0.0.1:0' });
  const bytes = Buffer.from([0, 255, 13, 10]);
  const message = once(peer, 'message', { signal: AbortSignal.timeout(5000) });
  const destination = `127.0.0.1:${peer.address().port}`;
  assert.equal((await tool('udp_send', { addr: destination, data: [...bytes] })).bytesWritten, bytes.length);
  const [received, remote] = await message;
  assert.deepEqual(received, bytes);
  assert.equal(remote.port, Number(addr.split(':').at(-1)));
  for (let iteration = 0; iteration < 5; iteration++) {
    assert.equal((await tool('udp_bind', { addr })).addr, addr);
  }
  await tool('udp_unbind');
  await tool('udp_send', { addr: destination, data: [1] }, false);
  peer.close();
});

test('async tool execution reaches a queryable successful result', async () => {
  const started = await (await http('/mcp/tools/protocol_get_parser_mode/start', { body: {} })).json();
  assert.equal(started.status, 'running');
  const finished = await until(async () => {
    const value = await (await http(`/mcp/tool-executions/${started.executionId}`)).json();
    return value.status === 'completed' ? value : null;
  }, 'async execution never completed');
  assert.equal(finished.ok, true);
  assert.deepEqual(finished.result, await tool('protocol_get_parser_mode'));
  assert.equal((await http('/mcp/tool-executions/missing')).status, 404);
});

test('MCP stdio handshake, ping, errors, tool listing and calls work against the isolated Core', async () => {
  const expectedMode = await tool('protocol_get_parser_mode');
  const bridge = spawn(portable, ['--mcp-bridge'], { env, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  bridge.stdout.on('data', data => { output += data; });
  bridge.stderr.on('data', data => { diagnostics += data; });
  const exited = once(bridge, 'exit');
  try {
    for (const request of [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
      { method: 'notifications/initialized' }, { id: 2, method: 'ping' },
      { id: 3, method: 'no-such-method' }, { id: 4, method: 'tools/list' },
      { id: 5, method: 'tools/call', params: { name: 'protocol_get_parser_mode', arguments: {} } },
    ]) bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`);
    const messages = await until(() => {
      const lines = output.trim().split('\n');
      if (lines.length < 5 || !output.endsWith('\n')) return null;
      return lines.map(line => JSON.parse(line));
    }, 'MCP response timeout');
    assert.equal(messages.length, 5, 'notification must not receive a reply');
    assert.equal(messages.find(item => item.id === 1).result.serverInfo.name, 'LinkAssist');
    assert.deepEqual(messages.find(item => item.id === 2).result, {});
    assert.equal(messages.find(item => item.id === 3).error.code, -32601);
    assert.ok(messages.find(item => item.id === 4).result.tools.some(item => item.name === 'tcp_connect'));
    const called = messages.find(item => item.id === 5).result;
    assert.equal(called.isError, false);
    assert.deepEqual(JSON.parse(called.content[0].text), expectedMode);
    bridge.stdin.end();
    const timeout = AbortSignal.timeout(10000);
    await once(bridge, 'close', { signal: timeout });
    assert.equal(bridge.exitCode, 0);
  } finally {
    if (bridge.exitCode === null) { bridge.kill(); await exited; }
  }
}, { timeout: 25000 });
