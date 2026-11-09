// Isolated browser UI check: uses the production bundle and a fake IPC boundary.
// No hardware, user configuration, native app session or public relay is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('logs', { recursive: true });
const directory = await mkdtemp(path.resolve('logs/remote-ui-'));
const chrome = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const resolved = path.resolve('dist', filename);
    if (!resolved.startsWith(`${path.resolve('dist')}${path.sep}`)) throw new Error('Invalid path');
    response.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(resolved));
  } catch { response.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${directory}/profile`, '--window-size=1100,740', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr += chunk; });
const until = async (check, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`Timeout: ${label}`);
};
let socket;
try {
  const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chrome debugger');
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (!message.id) return;
    const call = pending.get(message.id); pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const callId = ++id; pending.set(callId, { resolve, reject });
    socket.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const tcp = {mode:'client',clientAddress:'127.0.0.1:8080',serverAddress:'0.0.0.0:8080',udpBindAddress:'0.0.0.0:8080',udpTargetAddress:'127.0.0.1:8081'};
    const serial = {path:'COM42',baudRate:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',receiveTimeoutMs:50};
    const channel = {id:'serial-1',name:'Remote UART',type:'serial',state:'connected',createdAt:1};
    let snapshot = {version:1,sequence:1,themeMode:'light',channels:[{channel,revision:JSON.stringify([channel.name,channel.type,serial]),serial,tcp,ble:null,clients:[]}],ports:[],scanning:false,entries:[{id:1,kind:'rx',timestamp:1,text:'RX: 01 02 FF',sourceChannelId:'serial-1',sourceLabel:'Remote UART'}],canvases:[],canvasId:null,rows:[],chart:null,canvasView:null};
    snapshot.layoutRevision = 'fixture:1';
    snapshot.layout = {
      ui: {leftPanelWidth:140,centerPanelWidth:580,rightPanelWidth:350,centerSplitRatio:0.55,centerTopVisible:true,channelConfigPreview:false,centerBottomVisible:true,rightPanelVisible:true,channelPanelVisible:true,themeMode:'light',sendFormat:'ascii',receiveFormat:'hex',showInputPrefix:true,showTimestamp:false,showReceived:true,terminalChannelSettings:{},channelQuickOpenSelectedIds:[]},
      terminal: {root:{type:'leaf',paneId:'pane'},panes:{pane:{tabs:[{id:'terminal',channelId:'serial-1',label:'Remote UART',isPinned:true}],activeTabId:'terminal'}},focusedPaneId:'pane'},
      canvases: [], channelOrder: ['serial-1'], activeChannelId: 'serial-1',
    };
    snapshot.content = {channels:[{id:channel.id,name:channel.name,type:channel.type,serial,tcp}],canvases:[],commands:{commandSets:{},expandedGroups:{},savedConfigs:{}},bleFilters:{},customUuidNames:{services:{},characteristics:{}}};
    snapshot.connections = {serial:{connectionMap:{conn:channel.id},openConnections:['conn']},tcp:{connectionMap:{},clientConnections:[],serverClients:[],serverListening:false,serverAddr:'',udpBound:false,udpAddr:''},ble:{scanningChannelId:null,connectedChannelId:null,connectedDeviceId:null,deviceChannelMap:{},devices:[],gattServices:[],lastConnectedDeviceIds:{},lastConnectedDevices:{}}};
    snapshot.canvasFrames = {}; snapshot.chartViewState = {};
    const local = {channels:[{id:'local-1',name:'Local UART',channel_type:'serial',settings:{}}],ui:{left_panel_width:140,right_panel_width:350,data_view_mode:'text',theme_mode:'light'},protocol:{mode:'Passthrough',field_definitions:[],lua_script:''}};
    let status = {enabled:false,endpointId:'controller',pending:null,trusted:[],recent:[],controller:null,connected:{id:'host',name:'Lab computer',invitation:null},connecting:false,transport:'relay',rttMs:42,reconnectAllowed:false};
    let next = 1; const callbacks = new Map(); const listeners = new Map();
    window.remoteCalls = [];
    window.remoteSettingsCalls = [];
    window.remoteSettingsDevices = () => {status={...status,trusted:[{id:'controller-with-long-key',name:'Office controller with a very long device name',invitation:null}],recent:[{id:'host',name:'Lab host',invitation:'LA2:host'}]};window.remoteEmit('remote-status',status);};
    window.remoteEmit = (event, payload) => { for (const [id, item] of listeners) if(item.event === event) callbacks.get(item.handler)?.({event,id,payload}); };
    window.remoteDisconnect = () => {status={...status,connected:null};window.remoteEmit('remote-status',status);};
    window.remoteTheme = themeMode => {snapshot={...snapshot,themeMode,layout:{...snapshot.layout,ui:{...snapshot.layout.ui,themeMode}},sequence:snapshot.sequence+1};window.remoteEmit('remote-snapshot',snapshot);};
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener(){}};
    window.__TAURI_INTERNALS__ = {
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main',windowLabel:'main'}},
      transformCallback(callback) {const id=next++;callbacks.set(id,callback);return id;},
      unregisterCallback(id) {callbacks.delete(id);},
      async invoke(command,args={}) {
        if(command==='plugin:event|listen') {const id=next++;listeners.set(id,args);return id;}
        if(command==='plugin:event|unlisten') {listeners.delete(args.eventId);return;}
        if(command==='load_app_config') return structuredClone(local);
        if(command==='plugin:window|inner_size') return {width:innerWidth,height:innerHeight};
        if(command==='plugin:window|outer_position') return {x:0,y:0};
        if(command==='plugin:window|is_maximized') return false;
        if(command==='remote_status') return structuredClone(status);
        if(['remote_enable','remote_invite','remote_set_no_approval','remote_revoke'].includes(command)) {
          await new Promise(resolve=>setTimeout(resolve,120));
          window.remoteSettingsCalls.push({command,args});
          if(command==='remote_enable') status={...status,enabled:args.enabled,invitation:'LA2:'+'a'.repeat(64),inviteExpiresAt:Date.now()+300000};
          if(command==='remote_invite') status={...status,invitation:'LA2:'+'b'.repeat(64),persistentInvite:!!args.persistent};
          if(command==='remote_set_no_approval') status={...status,noApproval:args.enabled};
          if(command==='remote_revoke') status={...status,trusted:status.trusted.filter(peer=>peer.id!==args.id)};
          window.remoteEmit('remote-status',status);return;
        }
        if(command==='remote_snapshot') return structuredClone(snapshot);
        if(command==='remote_action') {
          window.remoteCalls.push(structuredClone(args));
          if(args.action==='workspace.edit') {
            snapshot.layout=args.args.layout; snapshot.content=args.args.content;
            snapshot.channels=snapshot.content.channels.map(c=>({channel:{id:c.id,name:c.name,type:c.type,state:snapshot.channels.find(v=>v.channel.id===c.id)?.channel.state??'disconnected',createdAt:1},serial:c.serial,tcp:c.tcp,ble:null,clients:[],revision:''}));
            snapshot.canvases=snapshot.content.canvases.map(c=>({...c,active:true}));
            snapshot.sequence++; snapshot.layoutRevision='fixture:'+snapshot.sequence;
            setTimeout(()=>window.remoteEmit('remote-snapshot',structuredClone(snapshot)),10);
            return {layout:snapshot.layout,content:snapshot.content,revision:snapshot.layoutRevision};
          }
          if(args.action==='workspace.browse') return {path:'C:/host',parent:'C:/',entries:[{name:'automation.lua',path:'C:/host/automation.lua',directory:false}]};
          return null;
        }
        if(command==='remote_disconnect') {window.remoteDisconnect();return;}
        return null;
      }
    };
  ` });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(() => evaluate(`document.body.textContent.includes('Lab computer')`), 'remote workspace');
  await until(() => evaluate(`document.body.textContent.includes('Close Port')`), 'shared UART panel');
  assert.equal(await evaluate(`document.body.textContent.includes('Recv Timeout')`), true);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Remote send data"]')===null`), true);
  const input = 'input[placeholder^="hex:"]';
  await evaluate(`{const el=document.querySelector(${JSON.stringify(input)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'01 A2 FF');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await delay(50);
  await evaluate(`document.querySelector(${JSON.stringify(input)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))`);
  await until(() => evaluate(`window.remoteCalls.some(call=>call.action==='channel.send')`), 'normal terminal send');
  const sent = await evaluate(`window.remoteCalls.find(call=>call.action==='channel.send')`);
  assert.deepEqual(sent.args.data, [1, 162, 255]); assert.equal(sent.args.channelId, 'serial-1');
  await evaluate(`document.querySelector('[title="Add channel"]').click();`);
  await evaluate(`[...document.querySelectorAll('div')].find(el=>el.textContent.trim()==='TCP/IP'&&el.children.length===1).click()`);
  await until(() => evaluate(`window.remoteCalls.some(call=>call.action==='workspace.edit'&&call.args.content.channels.length===2)`), 'create channel with shared menu');
  await until(() => evaluate(`!!document.querySelector('input[placeholder="127.0.0.1:8080"]')`), 'new channel configuration');
  await evaluate(`{const el=document.querySelector('input[placeholder="127.0.0.1:8080"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'10.0.0.8:9000');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(() => evaluate(`window.remoteCalls.some(call=>call.action==='workspace.edit'&&call.args.content.channels.some(c=>c.tcp.clientAddress==='10.0.0.8:9000'))`), 'automatic channel configuration');
  await evaluate(`{const el=[...document.querySelectorAll('p')].find(el=>el.textContent==='Right-click to add a canvas');el.parentElement.parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:950,clientY:180}));}`);
  await until(() => evaluate(`[...document.querySelectorAll('button')].some(el=>el.textContent==='Add Canvas')`), 'canvas menu');
  await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='Add Canvas').click()`);
  await until(() => evaluate(`!!document.querySelector('input[placeholder="e.g. Canvas Name 1"]')`), 'shared canvas editor');
  await evaluate(`{const el=document.querySelector('input[placeholder="e.g. Canvas Name 1"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'Remote table');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await until(() => evaluate(`window.remoteCalls.some(call=>call.action==='workspace.edit'&&call.args.content.canvases.some(c=>c.name==='Remote table'))`), 'canvas edit sync');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  for (const [width, height, theme] of [[1100,740,'light'], [760,500,'dark'], [1100,740,'high-contrast-light']]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.remoteTheme(${JSON.stringify(theme)})`);
    await delay(150);
    assert.equal(await evaluate(`document.documentElement.scrollWidth > innerWidth`), false, 'root horizontal overflow');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(directory, `${width}-${theme}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate('window.remoteDisconnect()');
  await delay(100);
  assert.equal(await evaluate(`document.body.textContent.includes('Lab computer')`), false);
  assert.equal(await evaluate(`document.body.textContent.includes('Local UART')`), true);
  await call('Emulation.setDeviceMetricsOverride', {width:1100,height:820,deviceScaleFactor:1,mobile:false});
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.querySelector('svg')?.classList.contains('translate-y-0.5')).click()`);
  await until(() => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent==='Remote')`), 'Remote settings navigation');
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Remote').click()`);
  await until(() => evaluate(`!!document.querySelector('[role=switch][aria-label="Allow remote"]')`), 'Allow remote switch');
  assert.equal(await evaluate(`!!document.querySelector('[aria-label="Pairing invitation"]')`),false);
  await evaluate(`document.querySelector('[role=switch][aria-label="Allow remote"]').click()`);
  await until(() => evaluate(`!!document.querySelector('[aria-label="Pairing invitation"]')`), 'enabled pairing options');
  await evaluate(`document.querySelector('[aria-label="Pairing invitation"]').click()`);
  assert.equal(await evaluate(`(()=>{const el=document.querySelector('[aria-label="Pairing invitation"]');return el.selectionStart===0&&el.selectionEnd===el.value.length&&getComputedStyle(el).outlineStyle==='none'})()`),true,'pairing code selects all without a focus frame');
  await evaluate(`window.remoteSettingsDevices()`);
  await until(() => evaluate(`document.querySelector('section[aria-label="Connect"]').textContent.includes('Office controller')`), 'device lists in Connect');
  const beforeBusy = await evaluate(`['Allow remote','Persistent','Connect without local approval','Refresh pairing code'].map(label=>getComputedStyle(document.querySelector('button[aria-label="'+label+'"]')).opacity)`);
  await evaluate(`document.querySelector('[aria-label="Persistent"]').click()`);
  await until(() => evaluate(`!!document.querySelector('[aria-busy="true"]')`), 'operation pending');
  const duringBusy = await evaluate(`['Allow remote','Persistent','Connect without local approval','Refresh pairing code'].map(label=>getComputedStyle(document.querySelector('button[aria-label="'+label+'"]')).opacity)`);
  assert.deepEqual(duringBusy,beforeBusy,'pending operation does not dim controls');

  await until(() => evaluate(`document.querySelector('[aria-label="Persistent"]').getAttribute('aria-checked')==='true'`), 'persistent toggle');
  await evaluate(`document.querySelector('button[aria-label="Connect without local approval"]').click()`);
  await until(() => evaluate(`document.querySelector('button[aria-label="Connect without local approval"]').getAttribute('aria-checked')==='true'`), 'no approval toggle');
  for (const [width,height,theme] of [[1100,820,'light'],[1100,820,'dark'],[1100,820,'high-contrast'],[1100,820,'high-contrast-light'],[760,650,'light'],[600,740,'dark']]) {
    await call('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.classList.remove('dark','high-contrast','high-contrast-light');document.documentElement.classList.add(...${JSON.stringify(theme==='high-contrast'?['high-contrast','dark']:theme==='light'?[]:[theme])})`);
    await delay(150);
    const layout = await evaluate(`(()=>{const top=document.querySelector('section[aria-label="Allow remote"]').getBoundingClientRect();const bottom=document.querySelector('section[aria-label="Connect"]').getBoundingClientRect();const code=document.querySelector('[aria-label="Pairing invitation"]').getBoundingClientRect();const validity=document.querySelector('[aria-label="Pairing code validity"]').getBoundingClientRect();const copy=document.querySelector('[aria-label="Copy pairing code"]').getBoundingClientRect();const persistent=document.querySelector('[aria-label="Persistent"]').getBoundingClientRect();return {stacked:bottom.y>=top.bottom&&Math.abs(bottom.x-top.x)<1&&Math.abs(bottom.width-top.width)<1,copyAlongside:Math.abs(copy.y-code.y)<8,timerAfterCode:validity.x>=code.right&&Math.abs(validity.y-code.y)<8,persistentBelow:persistent.y>=copy.bottom,overflow:[...document.querySelectorAll('.remote-ui,.remote-ui section')].some(el=>el.scrollWidth>el.clientWidth+1)}})()`);
    const sizes = await evaluate(`(()=>{const input=document.querySelector('[aria-label="Remote pairing invitation"]');const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Connect');const revoke=[...document.querySelectorAll('button')].find(b=>b.textContent==='Revoke');return [input,button,revoke].map(el=>el.getBoundingClientRect().height)})()`);
    assert.deepEqual(sizes,[28,28,28],'compact inputs and actions share height');
    const focusStyle = await evaluate(`(()=>{const input=document.querySelector('.remote-peer-code');input.focus();const style=getComputedStyle(input);return {outline:style.outlineStyle,shadow:style.boxShadow,width:style.borderTopWidth,transparent:[input,...document.querySelectorAll('.remote-borderless-action')].every(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'),buttons:[...document.querySelectorAll('.remote-borderless-action')].every(el=>getComputedStyle(el).borderTopWidth==='0px')}})()`);
    assert.equal(focusStyle.outline,'none');assert.equal(focusStyle.shadow,'none');assert.equal(focusStyle.width,'1px');assert.equal(focusStyle.buttons,true);assert.equal(focusStyle.transparent,true,'input and buttons have no background');

    assert.equal(layout.stacked,true,'full-width vertical sections');
    assert.equal(layout.copyAlongside,true);assert.equal(layout.timerAfterCode,true);assert.equal(layout.persistentBelow,true);assert.equal(layout.overflow,false,'settings overflow');
    const screenshot = await call('Page.captureScreenshot', {format:'png'});
    await writeFile(path.join(directory,`settings-${width}-${theme}.png`),Buffer.from(screenshot.data,'base64'));
  }
  await evaluate(`document.querySelector('[aria-label="Refresh pairing code"]').click()`);
  await until(() => evaluate(`document.querySelector('[aria-label="Pairing invitation"]').value.endsWith('b'.repeat(64))`), 'refresh pairing code');
  await until(() => evaluate(`!document.querySelector('[aria-busy="true"]')`), 'previous operation finished');
  await evaluate(`document.querySelector('[role=switch][aria-label="Allow remote"]').click()`);
  await until(() => evaluate(`!document.querySelector('[aria-label="Pairing invitation"]')`), 'disabled pairing options hidden');
  assert.equal(await evaluate(`document.querySelector('section[aria-label="Connect"]').textContent.includes('Lab host')`),true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: directory, checks: ['shared UART card', 'normal terminal send', 'create and configure remote channel', 'create and edit remote canvas', 'light/dark/high-contrast', '760/1100px layout', 'disconnect restores local workspace', 'Remote vertical sections and four themes', 'pairing controls and toggles', 'all devices in Connect'] }));
} finally {
  socket?.close(); browser.kill(); server.close();
}
