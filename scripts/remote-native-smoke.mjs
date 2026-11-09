// Two real, isolated portable apps. Requires the public iroh relay network.
// No user configuration or physical hardware is used; TCP echo stays on loopback.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const binary = process.env.LINKASSIST_TEST_BINARY ?? path.join(root, 'src-tauri/target/release/linkassist.exe');
await mkdir(path.join(root, 'logs'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'logs/remote-native-'));
const apps = [], sockets = new Set();
const echo = net.createServer(socket => {
  sockets.add(socket); socket.on('data', data => socket.write(data));
  // LinkAssist may reset its TCP connection on an explicit disconnect.
  socket.on('error', error => { if (error.code !== 'ECONNRESET') console.error(error); });
  socket.on('close', () => sockets.delete(socket));
});
echo.listen(0, '127.0.0.1'); await once(echo, 'listening');

async function until(check, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); }
  throw new Error(`Timeout: ${label}`);
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function attach(url) {
  const socket = new WebSocket(url); await once(socket, 'open');
  const pending = new Map(); let id = 0;
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data)); if (!message.id) return;
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`CDP timeout: ${method}`)); }, 100000);
    pending.set(callId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { socket, call, evaluate, invoke: (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`) };
}
async function launch(name) {
  const base = path.join(directory, name), roaming = path.join(base, 'roaming'), local = path.join(base, 'local');
  await mkdir(path.join(roaming, 'com.linkassist.desktop'), { recursive: true }); await mkdir(local);
  const port = await freePort();
  const env = { ...process.env, COMPUTERNAME: `Remote-test-${name}`, APPDATA: roaming, LOCALAPPDATA: local, TEMP: base, TMP: base,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(base, 'webview') };
  await writeFile(path.join(roaming, 'com.linkassist.desktop/config.json'), JSON.stringify({ channels: [], ui: { left_panel_width: 220, right_panel_width: 360, data_view_mode: 'text', simple_mode: false, show_received: true }, protocol: { mode: 'Passthrough', field_definitions: [], lua_script: '' } }));
  const portable = path.join(base, 'fixture.exe');
  const created = spawnSync(binary, ['snapshot', portable], { env, cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  assert.ifError(created.error); assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/Snapshot ID: ([a-f0-9]{64})/)?.[1]; assert.ok(id);
  const child = spawn(portable, ['--core-headless'], { env, cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const app = { process: child, base, port, output: '', sessions: [] }; apps.push(app);
  child.stdout.on('data', data => { app.output += data; }); child.stderr.on('data', data => { app.output += data; });
  app.discovery = await until(async () => {
    assert.equal(child.exitCode, null, app.output);
    try { return JSON.parse(await readFile(path.join(local, 'LinkAssist/Snapshots', id, 'core/core-discovery.json'), 'utf8')); } catch { return null; }
  }, `${name} startup`);
  assert.equal(app.discovery.pid, child.pid);
  const page = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(page => page.type === 'page' && !page.url.includes('remote=1')); } catch { return null; } }, `${name} webview`);
  app.main = await attach(page.webSocketDebuggerUrl); app.sessions.push(app.main);
  await until(() => app.main.evaluate(`!!document.querySelector('[data-window-titlebar]')`), `${name} loaded`);
  return app;
}

try {
  const host = await launch('host'); const client = await launch('controller');
  console.log('Isolated native apps ready');
  assert.equal((await host.main.invoke('remote_status')).enabled, false);
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b => b.querySelector('svg')?.classList.contains('translate-y-0.5')).click()`);
  await until(() => host.main.evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Remote')`), 'remote settings navigation');
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Remote').click()`);
  await until(() => host.main.evaluate(`!!document.querySelector('[role=switch][aria-label="Allow remote"]')`), 'remote settings content');
  const position = await host.main.evaluate(`(()=>{const r=document.querySelector('[role=switch][aria-label="Allow remote"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await host.main.call('Input.dispatchMouseEvent', {type:'mousePressed', ...position, button:'left', clickCount:1});
  await host.main.call('Input.dispatchMouseEvent', {type:'mouseReleased', ...position, button:'left', clickCount:1});
  await until(async () => (await host.main.invoke('remote_status')).enabled, 'switch enables remote access');
  await host.main.evaluate(`document.querySelector('[aria-label="Remote pairing invitation"]').focus()`);
  await host.main.call('Input.insertText', {text:'editable-invitation'});
  assert.equal(await host.main.evaluate(`document.querySelector('[aria-label="Remote pairing invitation"]').value`), 'editable-invitation');
  console.log('Native settings switch and text input passed');
  const invitation = await until(async () => (await host.main.invoke('remote_status')).invitation, 'automatic pairing code');
  assert.equal(invitation.length, 68);
  assert.ok((await host.main.invoke('remote_status')).inviteExpiresAt > Date.now());
  // First reject, proving an invitation alone cannot authorize control.
  const rejected = client.main.invoke('remote_connect', { invitation }).then(() => false, () => true);
  let pending = await until(async () => (await host.main.invoke('remote_status')).pending, 'pairing prompt');
  assert.ok(await host.main.evaluate(`document.body.textContent.includes('requests control')`));
  await host.main.invoke('remote_approve', { requestId: pending.requestId, allow: false }); assert.equal(await rejected, true);
  const nextInvitation = await host.main.invoke('remote_invite');
  const connecting = client.main.invoke('remote_connect', { invitation: nextInvitation });
  pending = await until(async () => (await host.main.invoke('remote_status')).pending, 'second pairing prompt');
  await host.main.invoke('remote_approve', { requestId: pending.requestId, allow: true }); await connecting;
  console.log('Pairing rejection and approval passed');
  const remote = client.main;
  await until(() => remote.evaluate(`document.body.textContent.includes('Remote · Remote-test-host')`), 'main-window remote UI');
  const pages = await (await fetch(`http://127.0.0.1:${client.port}/json`)).json();
  assert.equal(pages.filter(page => page.type === 'page').length, 1, 'no remote window created');
  await assert.rejects(remote.invoke('remote_enable', { enabled: true }), /Disconnect/);
  await assert.rejects(remote.invoke('remote_action', { action: 'save_app_config', args: {} }), /not allowed/);
  const action = (action, args = {}) => remote.invoke('remote_action', { action, args });
  const channelId = await action('channel.create', { name: 'Remote echo', type: 'tcp' });
  const getChannel = () => until(async () => (await remote.invoke('remote_snapshot'))?.channels.find(item => item.channel.id === channelId), 'channel snapshot');
  let channel = await getChannel();
  await action('channel.configure', { channelId, revision: channel.revision, config: { ...channel.tcp, clientAddress: `127.0.0.1:${echo.address().port}` } });
  await until(async () => { channel = await getChannel(); return channel.tcp.clientAddress.endsWith(`:${echo.address().port}`); }, 'config snapshot');
  await assert.rejects(action('channel.rename', { channelId, revision: 'stale', name: 'bad' }), /changed/);
  await action('channel.connect', { channelId, revision: channel.revision });
  await action('channel.send', { channelId, data: [82, 69, 77, 79, 84, 69] });
  await until(async () => (await remote.invoke('remote_snapshot'))?.entries.some(entry => entry.kind === 'rx' && entry.sourceChannelId === channelId), 'TCP echo received');
  await action('channel.disconnect', { channelId });
  console.log('Remote TCP send/receive passed');
  // New channels use the local menu/card, including immediate selection and auto-save.
  await remote.evaluate(`document.querySelector('[title="Add channel"]').click()`);
  await remote.evaluate(`[...document.querySelectorAll('div')].find(el=>el.textContent.trim()==='TCP/IP'&&el.children.length===1).click()`);
  const uiChannel = await until(async () => (await remote.invoke('remote_snapshot'))?.channels.find(item=>item.channel.name==='TCP/IP'), 'UI channel creation');
  assert.equal((await remote.invoke('remote_snapshot')).layout.activeChannelId, uiChannel.channel.id);
  await until(() => remote.evaluate(`!!document.querySelector('input[placeholder="127.0.0.1:8080"]')`), 'shared TCP configuration card');
  await remote.evaluate(`{const el=document.querySelector('input[placeholder="127.0.0.1:8080"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'127.0.0.1:${echo.address().port}');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(async () => (await remote.invoke('remote_snapshot'))?.channels.find(item=>item.channel.id===uiChannel.channel.id)?.tcp.clientAddress.endsWith(`:${echo.address().port}`), 'UI config auto-save');
  await remote.evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='Connect').click()`);
  await until(async () => (await remote.invoke('remote_snapshot'))?.channels.find(item=>item.channel.id===uiChannel.channel.id)?.channel.state==='connected', 'UI connect');
  const terminalInput = async text => {
    await remote.evaluate(`{const el=document.querySelector('input[spellcheck="false"]');el.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await delay(30);
    await remote.evaluate(`document.querySelector('input[spellcheck="false"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`);
  };
  await terminalInput('/link TCP/IP');
  await until(async () => Object.values((await remote.invoke('remote_snapshot')).layout.terminal.panes).some(p=>p.tabs.some(t=>t.channelId===uiChannel.channel.id)), 'terminal link');
  await terminalInput("'PARITY'");
  await until(async () => (await remote.invoke('remote_snapshot'))?.entries.some(e=>e.kind==='rx'&&e.sourceChannelId===uiChannel.channel.id&&e.data?.length===6), 'normal terminal echo');
  await terminalInput('/clear');
  await until(async () => { const s=await remote.invoke('remote_snapshot');const id=s.layout.terminal.focusedPaneId;const tab=s.layout.terminal.panes[id].activeTabId;return s.terminalEntryIds[id][tab].length===0; }, 'terminal clear on host');
  await remote.evaluate(`[...document.querySelectorAll('[data-channel-card-container] button')].find(el=>el.textContent.trim()==='Disconnect').click()`);
  await until(async () => (await remote.invoke('remote_snapshot'))?.channels.find(item=>item.channel.id===uiChannel.channel.id)?.channel.state==='disconnected', 'UI disconnect channel');
  await remote.evaluate(`{const el=[...document.querySelectorAll('p')].find(el=>el.textContent==='Right-click to add a canvas');el.parentElement.parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:900,clientY:200}));}`);
  await until(() => remote.evaluate(`[...document.querySelectorAll('button')].some(el=>el.textContent==='Add Canvas')`), 'canvas menu');
  await remote.evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Add Canvas').click()`);
  await until(() => remote.evaluate(`!!document.querySelector('input[placeholder="e.g. Canvas Name 1"]')`), 'remote canvas editor');
  await remote.evaluate(`{const el=document.querySelector('input[placeholder="e.g. Canvas Name 1"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Parity canvas');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(async () => (await remote.invoke('remote_snapshot'))?.canvases.some(c=>c.name==='Parity canvas'), 'canvas edit reaches host');
  await remote.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  const listing = await action('workspace.browse', {path:host.base});
  assert.ok(listing.entries.some(entry=>entry.name==='runtime-config.json'||entry.name==='config.json'||entry.directory), 'host directory is browsable');
  console.log('Shared channel creation/configuration, terminal link/send/clear, canvas creation/editing and host file browser passed');
  // Exercise real UI controls; host persistence must reflect controller edits.
  await remote.evaluate(`document.querySelector('[title="Split pane"]').click()`);
  await until(async () => (await remote.invoke('remote_snapshot'))?.layout.terminal.root.type === 'split', 'terminal split propagated');
  await until(async () => (await host.main.invoke('load_app_config')).ui.terminal_layout.root.type === 'split', 'host saves terminal layout');
  await remote.evaluate(`document.querySelector('[data-window-titlebar]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:20}))`);
  await until(() => remote.evaluate(`!!document.querySelector('[role="menuitemcheckbox"]')`), 'layout context menu');
  await remote.evaluate(`[...document.querySelectorAll('[role="menuitemcheckbox"]')].find(b=>b.textContent.includes('Channels')).click()`);
  await until(async () => (await host.main.invoke('load_app_config')).ui.channel_panel_visible === false, 'host saves controller visibility edit');
  const before = await remote.invoke('remote_snapshot');
  await assert.rejects(action('workspace.layout',{layout:before.layout,revision:'stale'}),/changed/);
  const screenshot = await remote.call('Page.captureScreenshot', {format:'png'});
  await writeFile(path.join(directory,'main-workspace.png'),Buffer.from(screenshot.data,'base64'));

  await remote.invoke('remote_disconnect');
  const hostId = (await client.main.invoke('remote_status')).recent[0].id;
  await remote.invoke('remote_reconnect', { id: hostId });
  assert.equal((await host.main.invoke('remote_status')).pending, null, 'trusted reconnect does not need another approval');
  const controllerId = (await host.main.invoke('remote_status')).controller.id;
  await host.main.invoke('remote_revoke', { id: controllerId });
  await until(async () => !(await remote.invoke('remote_status')).connected, 'revocation disconnect');
  await remote.invoke('remote_disconnect');
  await assert.rejects(remote.invoke('remote_reconnect', { id: hostId }), /expired|invalid|rejected|closed/i);
  assert.deepEqual((await host.main.invoke('remote_status')).trusted, []);
  console.log('Trusted reconnect and revocation passed');
  console.log('Testing no-approval mode');
  await host.main.invoke('remote_set_no_approval', {enabled:true});
  const persistent = await host.main.invoke('remote_invite',{persistent:true});
  await host.main.invoke('remote_enable',{enabled:false});
  await host.main.invoke('remote_enable',{enabled:true});
  assert.equal((await host.main.invoke('remote_status')).invitation,persistent);
  assert.equal((await host.main.invoke('remote_status')).inviteExpiresAt,null);
  await client.main.invoke('remote_connect',{invitation:persistent});
  assert.equal((await host.main.invoke('remote_status')).pending,null);
  await until(() => remote.evaluate(`document.body.textContent.includes('Remote ·')`), 'automatic approval main UI');
  console.log('No-approval connection passed');
  // First-close decision and remote override: actual native close event.
  await host.main.evaluate(`void window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`);
  await until(() => host.main.evaluate(`document.body.textContent.includes('When closing LinkAssist')`), 'first close confirmation');
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Keep in background').click()`);
  await until(async () => (await host.main.invoke('load_app_config')).ui.close_behavior === 'background','background preference saved');
  // Change the remembered choice through the settings UI, so beforeunload cannot overwrite it.
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Interface').click()`);
  await until(() => host.main.evaluate(`document.body.textContent.includes('Close button')`), 'close preference setting');
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Hide in system tray')).click()`);
  await until(() => host.main.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Exit program'))`), 'close preference options');
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Exit program')).click()`);
  await host.main.evaluate(`void window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`);
  await until(() => host.main.evaluate(`document.body.textContent.includes('Keep remote access running?')`), 'remote exit override confirmation');
  await host.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Keep in background').click()`);
  // Leave the host hidden for >5 minutes when explicitly requested by this test run.
  const backgroundMs = Number(process.env.LINKASSIST_BACKGROUND_TEST_MS ?? 6500);
  await delay(backgroundMs);
  assert.ok((await client.main.invoke('remote_status')).connected,'hidden host remains connected');
  const hiddenSnapshot = await remote.invoke('remote_snapshot');
  assert.ok(hiddenSnapshot.sequence > before.sequence,'hidden host keeps publishing');
  await client.main.invoke('remote_disconnect');
  await until(() => remote.evaluate(`!document.body.textContent.includes('Remote ·')`), 'local workspace restored');
  assert.equal((await client.main.invoke('load_app_config')).channels.length,0,'controller config remains local');
  await host.main.invoke('remote_enable',{enabled:false});
  console.log('Persistent code, no-approval mode, main layout sync and background close passed');
  const result = { passed: true, directory, checks: ['reject/approve pairing', 'main-window bridge', 'shared channel and canvas UI', 'terminal link/send/clear', 'remote file browser', 'automatic compact code', 'persistent code', 'no-approval mode', 'layout and persistence sync', 'background close', 'command allowlist', 'stale configuration rejected', 'remote TCP send/receive', 'trusted reconnect', 'revocation'] };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally {
  for (const app of apps) {
    for (const session of app.sessions) session.socket.close();
    if (app.discovery && app.process.exitCode === null) await fetch(`http://127.0.0.1:${app.discovery.port}/core/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${app.discovery.token}` }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    if (app.process.exitCode === null) { await Promise.race([once(app.process, 'exit'), delay(5000)]); if (app.process.exitCode === null) app.process.kill(); }
    await writeFile(path.join(app.base, 'app.log'), app.output);
  }
  for (const socket of sockets) socket.destroy(); echo.close();
}


