// Native monitor negative-path checks in an isolated portable app.
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
const directory = await mkdtemp(path.join(root, 'logs/serial-monitor-native-'));
const apps = [];
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
  const env = { ...process.env, COMPUTERNAME: `Monitor-test-${name}`, APPDATA: roaming, LOCALAPPDATA: local, TEMP: base, TMP: base,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(base, 'webview') };
  await writeFile(path.join(roaming, 'com.linkassist.desktop/config.json'), JSON.stringify({ channels: [{id:'monitor-ui',name:'USB Monitor',channel_type:'serial',settings:{path:'COM3',monitor:true}}], ui: { left_panel_width: 140, right_panel_width: 360, active_channel_id:'monitor-ui', data_view_mode: 'text', simple_mode: false, show_received: true }, protocol: { mode: 'Passthrough', field_definitions: [], lua_script: '' } }));
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
  }, `${name} startup`, 90000);
  assert.equal(app.discovery.pid, child.pid);
  const page = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(page => page.type === 'page' && !page.url.includes('remote=1')); } catch { return null; } }, `${name} webview`);
  app.main = await attach(page.webSocketDebuggerUrl); app.sessions.push(app.main);
  await until(() => app.main.evaluate(`!!document.querySelector('[data-window-titlebar]')`), `${name} loaded`);
  return app;
}

try {
  const app = await launch('serial-monitor');
  await assert.rejects(app.main.invoke('check_usbpcap', { usbpcapDirectory: 'relative/path' }), /absolute/);
  await assert.rejects(app.main.invoke('check_usbpcap', { usbpcapDirectory: app.base }), /selected directory/);
  const setup = await app.main.invoke('check_usbpcap').then(path => ({ path }), error => ({ error: String(error) }));
  await assert.rejects(app.main.invoke('start_serial_monitor', {path:'INVALID',channelId:'test',manual:true,capture:{bus:1,address:3,inEndpoint:129,outEndpoint:2,profile:'raw',packetSize:64}}), /Expected a COM port/);
  await assert.rejects(app.main.invoke('start_serial_monitor', {path:'COM999999',channelId:'test',manual:true,capture:{bus:1,address:0,inEndpoint:129,outEndpoint:2,profile:'raw',packetSize:64}}), /Configure the USBPcap/);
  const absent = await app.main.invoke('inspect_serial_monitor', {path:'COM999999'});
  assert.equal(absent.status, 'unsupported'); assert.equal(absent.capture, null);
  await assert.rejects(app.main.invoke('start_serial_monitor', {path:'COM999999',channelId:'test',capture:{bus:1,address:3,inEndpoint:129,outEndpoint:2,profile:'raw',packetSize:64}}), /not present/);
  await assert.rejects(app.main.invoke('send_serial_data', {connectionId:'monitor:test',data:[1,2,3]}), /read-only/);
  await app.main.invoke('stop_serial_monitor', {connectionId:'monitor:missing'});
  await assert.rejects(app.main.invoke('open_serial_port', {config:{path:'COM999999',monitor:true}}), /dedicated monitor/);
  const ports = await app.main.invoke('list_serial_ports');
  const actualDiscovery = [];
  for (const port of ports) actualDiscovery.push({port:port.path,report:await app.main.invoke('inspect_serial_monitor',{path:port.path})});
  // UI fixtures only: exercise WebView rendering without installing a driver,
  // opening COM, or capturing USB traffic. Native discovery was checked above.
  await app.main.evaluate(`{
    const originalFetch = window.fetch.bind(window);
    window.monitorCalls = [];
    window.monitorFixture = {status:'ready',message:'COM3 identified. USB settings will be refreshed before monitoring.',capture:{bus:2,address:5,inEndpoint:131,outEndpoint:4,profile:'ftdi',packetSize:512}};
    // Tauri's bridge is immutable. Intercept only these three IPC fetch URLs
    // in this isolated test WebView, preserving the real callback machinery.
    const urls = new Map(['list_serial_ports','inspect_serial_monitor','start_serial_monitor'].map(command=>[window.__TAURI_INTERNALS__.convertFileSrc(command,'ipc'),command]));
    window.fetch = (url, options) => {
      const command = urls.get(String(url));
      if (!command) return originalFetch(url, options);
      window.monitorCalls.push({command,args:JSON.parse(options.body)});
      const value = command==='list_serial_ports' ? [{path:'COM3',portType:'USB',product:'FTDI USB serial adapter'}]
        : command==='inspect_serial_monitor' ? window.monitorFixture : 'UI fixture cannot capture hardware';
      return Promise.resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Tauri-Response':command==='start_serial_monitor'?'error':'ok'}}));
    };
    document.querySelector('[aria-label="USB Monitor channel settings"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  }`);
  assert.deepEqual(await app.main.invoke('list_serial_ports'), [{path:'COM3',portType:'USB',product:'FTDI USB serial adapter'}]);
  await app.main.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await until(() => app.main.evaluate(`!!document.querySelector('.settings-dialog')`), 'settings dialog');
  await app.main.evaluate(`[...document.querySelectorAll('.settings-sidebar button')].find(b=>b.textContent==='Channel').click()`);
  assert.equal(await app.main.evaluate(`!!document.querySelector('#usbpcap-directory')`), false);
  await app.main.evaluate(`document.querySelector('[aria-label="Enable mode selection"]').click()`);
  await until(() => app.main.evaluate(`!!document.querySelector('#usbpcap-directory')`), 'USBPcap settings shown');
  await app.main.evaluate(`{
    const input = document.querySelector('#usbpcap-directory');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input, ${JSON.stringify(app.base)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  }`);
  await until(() => app.main.evaluate(`document.querySelector('[role="status"]').textContent.includes('selected directory')`), 'native directory validation');
  await until(async () => (await app.main.invoke('load_app_config')).ui.usbpcap_directory === app.base, 'native directory persistence');
  for (const [width, theme] of [[1160,'light'],[1024,'dark'],[1160,'high-contrast'],[700,'high-contrast-light']]) {
    if (width >= 1024) {
      await app.main.call('Emulation.clearDeviceMetricsOverride');
      await app.main.invoke('plugin:window|set_size', {label:'main',value:{Logical:{width,height:740}}});
      // Windows may reserve its invisible resize frame inside the requested bounds.
      await until(() => app.main.evaluate(`innerWidth <= ${width + 1} && innerWidth >= ${width - 32}`), 'native window resize');
    } else {
      await app.main.call('Emulation.setDeviceMetricsOverride',{width,height:740,deviceScaleFactor:1,mobile:false});
    }
    await app.main.evaluate(`document.documentElement.className=${JSON.stringify(theme === 'high-contrast' ? 'dark high-contrast' : theme === 'light' ? '' : theme)}`);
    await delay(200);
    // The native window has a 1024px minimum. 700px is an extra settings-only
    // responsive probe; the underlying workspace is not supported at that size.
    if (width >= 1024) assert.equal(await app.main.evaluate(`document.documentElement.scrollWidth > innerWidth`), false, 'root horizontal overflow');
    assert.equal(await app.main.evaluate(`document.querySelector('.settings-main').scrollWidth > document.querySelector('.settings-main').clientWidth`), false, 'settings horizontal overflow');
    const screenshot = await app.main.call('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(directory,`settings-${width}-${theme}.png`),Buffer.from(screenshot.data,'base64'));
  }
  await app.main.evaluate(`document.querySelector('.settings-main').scrollTop = 9999`);
  assert.equal(await app.main.evaluate(`{
    const main = document.querySelector('.settings-main').getBoundingClientRect();
    const button = [...document.querySelectorAll('.settings-main button')].find(b=>b.textContent==='Open USBPcap website').getBoundingClientRect();
    button.top >= main.top && button.bottom <= main.bottom;
  }`), true, 'installation guide remains reachable by scrolling');
  const guide = await app.main.call('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(directory,'settings-guide.png'),Buffer.from(guide.data,'base64'));
  await app.main.evaluate(`document.querySelector('[aria-label="Supports monitor mode"]').click()`);
  assert.equal(await app.main.evaluate(`!!document.querySelector('#usbpcap-directory')`), false);
  await app.main.evaluate(`document.querySelector('[aria-label="Supports monitor mode"]').click()`);
  assert.equal(await app.main.evaluate(`document.querySelector('#usbpcap-directory').value`), app.base);
  await app.main.evaluate(`[...document.querySelectorAll('.settings-main button')].find(b=>b.textContent==='Reset').click()`);
  assert.equal(await app.main.evaluate(`document.querySelector('#usbpcap-directory').value`), '');
  await app.main.evaluate(`document.querySelector('.settings-heading button').click()`);
  await until(() => app.main.evaluate(`!!document.querySelector('[id="monitor-ui-address"]')`), 'monitor fields');
  assert.equal(await app.main.evaluate(`document.querySelector('[id="monitor-ui-address"]').value`), '');
  await until(() => app.main.evaluate(`![...document.querySelectorAll('button')].find(b=>b.textContent==='Start Monitor').disabled`), 'automatic monitor ready');
  await app.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Start Monitor').click()`);
  await until(() => app.main.evaluate(`document.body.textContent.includes('UI fixture cannot capture hardware')`), 'start error feedback');
  await app.main.evaluate(`window.monitorFixture={status:'missing_tool',message:'USBPcapCMD.exe not found',capture:null}; [...document.querySelectorAll('button')].find(b=>b.textContent==='Normal').click()`);
  await app.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Monitor').click()`);
  await delay(100);
  assert.equal(await app.main.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Start Monitor').disabled`), true);
  await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,setup,actualDiscovery,checks:['native command registration','invalid port rejection','USB capture target validation','automatic discovery rejects absent COM','backend read-only protection','idempotent stop','normal-open monitor guard','custom directory validation','settings visibility and native directory persistence','native WebView auto/error UI fixtures','four themes at 1160/1024px plus a 700px settings-only probe','scrollable installation guide']},null,2));
  console.log('Native monitor negative-path checks passed:',directory);
} catch (error) {
  for (const app of apps) {
    if (!app.main) continue;
    await writeFile(path.join(directory, 'failure-layout.json'), JSON.stringify(await app.main.evaluate(`({width:innerWidth,root:document.documentElement.scrollWidth,main:document.querySelector('.settings-main')?.scrollWidth,mainClient:document.querySelector('.settings-main')?.clientWidth,overflow:[...document.querySelectorAll('body *')].map(e=>({tag:e.tagName,class:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).filter(e=>e.right>innerWidth+1).slice(0,20)})`), null, 2));
    await writeFile(path.join(directory, 'failure-state.txt'), await app.main.evaluate('document.body.innerText').catch(() => 'WebView unavailable'));
    await writeFile(path.join(directory, 'failure-calls.json'), JSON.stringify(await app.main.evaluate('window.monitorCalls'), null, 2));
    const screenshot = await app.main.call('Page.captureScreenshot',{format:'png'}).catch(() => null);
    if (screenshot) await writeFile(path.join(directory,'failure.png'),Buffer.from(screenshot.data,'base64'));
  }
  console.error('Native test artifacts:', directory);
  throw error;
} finally {
  for (const app of apps) {
    for (const session of app.sessions) session.socket.close();
    if (app.discovery && app.process.exitCode === null) await fetch(`http://127.0.0.1:${app.discovery.port}/core/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${app.discovery.token}` }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    if (app.process.exitCode === null) { await Promise.race([once(app.process, 'exit'), delay(5000)]); if (app.process.exitCode === null) app.process.kill(); }
    await writeFile(path.join(app.base, 'app.log'), app.output);
  }

}


