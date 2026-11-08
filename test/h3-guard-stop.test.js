import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineManager } from '../runtime/engines.js';

// The stop operation of the video guard (runtime/h3_guard.py), against a substitute H3 server whose
// "renderer" is only a sleeping process. No model, GPU or real H3 application is involved.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const python = path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe');
const enabled = process.platform === 'win32' && existsSync(python);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = 'test-only-control-token';

async function waitFor(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch {
      // The guarded endpoint is expected to refuse connections before startup.
    }
    await pause(100);
  }
  throw Error('Timed out waiting for the guarded video service.');
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// Same substitute server as test/h3-guard.test.js; the launcher refuses code it does not recognize.
const fixture = `const http=require('http');
const {spawn}=require('child_process');
const ROOT = __dirname, PORT = 8274;
let job=null;
const json=(res,data,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
function body(req){return new Promise((resolve,reject)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}});req.on('error',reject)})}
async function generate(req,res){
 if(job && job.state==='running')return json(res,{error:'A video is already generating.'},409);
 let b;try{b=await body(req)}catch(e){return json(res,{error:e.message},400)}
 const args=['-p','x','--rng','cpu','-o','y'];
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 job={id:'test',state:'running',pid:child.pid};child.on('exit',()=>{job=null});return json(res,{id:'test',pid:child.pid,args});
}
http.createServer((req,res)=>{if(req.url==='/api/status')return json(res,{ready:true,files:[],videos:[],job,serverPid:process.pid});if(req.method==='POST'&&req.url==='/api/generate')return generate(req,res);return json(res,{},404)}).listen(PORT,'127.0.0.1');`;

function guardDefinition(port, dir, extra = {}) {
  return {
    id: 'video',
    name: 'H3 fixture',
    port,
    endpoint: '/api/status',
    kind: 'h3',
    cwd: dir,
    command: python,
    args: [
      '-u',
      path.join(root, 'runtime', 'h3_guard.py'),
      '--port',
      String(port),
      '--node',
      process.execPath,
      '--bootstrap',
      path.join(root, 'runtime', 'h3_bootstrap.cjs'),
      '--engine-dir',
      dir,
    ],
    ...extra,
  };
}
const control = (port, route, headerToken, method = 'POST') =>
  fetch(`http://127.0.0.1:${port}/api/forge/${route}`, {
    method,
    headers: headerToken === null ? {} : { 'X-Forge-Engine-Token': headerToken },
    body: method === 'POST' ? '{}' : undefined,
  });
async function fixtureFolder(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(dir, 'server.js'), fixture);
  return dir;
}
function startGuard(port, dir) {
  const guard = spawn(python, guardDefinition(port, dir).args, {
    env: { ...process.env, FORGE_ENGINE_CONTROL_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  guard.logs = '';
  guard.stdout.on('data', (chunk) => (guard.logs += chunk));
  guard.stderr.on('data', (chunk) => (guard.logs += chunk));
  return guard;
}

test(
  'the H3 guard stops its tree only when idle, with the control token',
  { skip: !enabled, timeout: 40000 },
  async (t) => {
    const port = await freePort();
    const dir = await fixtureFolder('forge-h3-stop-');
    const guard = startGuard(port, dir);
    let serverPid = null,
      rendererPid = null;
    t.after(() => {
      if (guard.exitCode === null) {
        guard.kill();
      }
      for (const pid of [serverPid, rendererPid]) {
        if (pid && alive(pid)) {
          process.kill(pid);
        }
      }
    });
    const base = `http://127.0.0.1:${port}`;
    const status = await waitFor(async () => {
      const r = await fetch(`${base}/api/status`);
      return r.ok && r.json();
    });
    serverPid = status.serverPid;
    // No token, a wrong token and an unauthenticated read are refused; nothing is stopped.
    assert.equal((await control(port, 'stop', null)).status, 403);
    assert.equal((await control(port, 'stop', 'wrong')).status, 403);
    assert.equal((await control(port, 'status', null, 'GET')).status, 403);
    assert.equal((await control(port, 'nothing', token)).status, 404);
    const health = await (await control(port, 'status', token, 'GET')).json();
    assert.deepEqual(
      { engine: health.engine, active: health.active, closing: health.closing },
      { engine: 'forge-h3-guard-v1', active: 0, closing: false },
    );
    // A render is running: the stop is refused and everything keeps working.
    const started = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    rendererPid = (await started.json()).pid;
    const busy = await control(port, 'stop', token);
    assert.equal(busy.status, 409, guard.logs);
    assert.match((await busy.json()).error, /rendering/);
    assert.equal((await fetch(`${base}/api/status`)).status, 200, 'not left in a stopping state');
    assert.ok(alive(rendererPid) && alive(serverPid) && guard.exitCode === null);
    // The renderer ends. An accepted stop refuses new work until it is resumed.
    process.kill(rendererPid);
    await waitFor(async () => !(await (await fetch(`${base}/api/status`)).json()).job);
    const accepted = await control(port, 'stop', token);
    assert.equal(accepted.status, 200, guard.logs);
    assert.deepEqual(await accepted.json(), { stopping: true });
    const refused = await fetch(`${base}/api/generate`, { method: 'POST', body: '{}' });
    assert.equal(refused.status, 503, 'new work is refused once the stop was accepted');
    assert.equal((await control(port, 'resume', token)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    await pause(1500);
    assert.equal(guard.exitCode, null, 'the resumed guard keeps running');
    // Stopping again works, and takes the whole tree with it.
    assert.equal((await control(port, 'stop', token)).status, 200);
    await once(guard, 'exit');
    assert.equal(guard.exitCode, 0, guard.logs);
    await waitFor(() => !alive(serverPid));
    assert.match(guard.logs, /stopping at Forge's request/);
  },
);

test(
  'the H3 guard refuses to stop while a request is still in flight',
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const port = await freePort();
    const dir = await fixtureFolder('forge-h3-inflight-');
    const guard = startGuard(port, dir);
    let serverPid = null;
    t.after(() => {
      if (guard.exitCode === null) {
        guard.kill();
      }
      if (serverPid && alive(serverPid)) {
        process.kill(serverPid);
      }
    });
    const base = `http://127.0.0.1:${port}`;
    serverPid = (
      await waitFor(async () => {
        const r = await fetch(`${base}/api/status`);
        return r.ok && r.json();
      })
    ).serverPid;
    // An upload that has sent only part of its body.
    let finish;
    const upload = new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/api/generate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.write('{"test":');
      finish = () => req.end('true}');
    });
    await pause(250);
    const blocked = await control(port, 'stop', token);
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /in progress/);
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    finish();
    await upload;
    assert.equal(guard.exitCode, null);
  },
);

test(
  'the engine manager stops an idle video guard it owns and refuses while a render runs',
  { skip: !enabled, timeout: 40000 },
  async (t) => {
    const port = await freePort();
    const dir = await fixtureFolder('forge-h3-offload-');
    const manager = new EngineManager({
      definitions: [guardDefinition(port, dir, { quiesce: 'h3-guard-v1' })],
      logDir: dir,
    });
    let renderer = null;
    t.after(async () => {
      manager.closed = true;
      const entry = manager.children.get('video');
      if (entry && entry.child.exitCode === null) {
        const exited = once(entry.child, 'exit');
        entry.child.kill();
        await exited;
      }
      if (renderer && alive(renderer)) {
        process.kill(renderer);
      }
    });
    assert.equal(manager.canOffload('video'), false, 'not owned yet');
    assert.equal((await manager.start('video')).status, 'starting');
    const base = `http://127.0.0.1:${port}`;
    const status = await waitFor(async () => {
      const r = await fetch(`${base}/api/status`);
      return r.ok && r.json();
    });
    assert.equal(manager.canOffload('video'), true);
    assert.equal(manager.status().video.canUnload, true);
    assert.equal(manager.status().video.startsOnDemand, false);
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    renderer = (await response.json()).pid;
    await assert.rejects(manager.offload('video'), /active or queued work/);
    assert.equal(manager.owns('video'), true, 'a refused stop leaves the engine owned and running');
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    process.kill(renderer);
    await waitFor(async () => !(await (await fetch(`${base}/api/status`)).json()).job);
    const entry = manager.children.get('video');
    const result = await manager.offload('video');
    assert.equal(result.stopped, true);
    assert.equal(entry.child.exitCode, 0);
    await waitFor(() => !alive(status.serverPid));
    await pause(1500);
    assert.equal(manager.owns('video'), false);
    assert.equal(manager.children.has('video'), false, 'a requested stop is not restarted');
  },
);
