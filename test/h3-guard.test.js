import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineManager } from '../runtime/engines.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const python = path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe');
const enabled = process.platform === 'win32' && existsSync(python);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  throw Error('Timed out waiting for guarded video service.');
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The fixture deliberately keeps H3's original check-before-body pattern.
// Its renderer is only a sleeping test process, never a real model.
const fixture = `const http=require('http');
const {spawn}=require('child_process');
const ROOT = __dirname, PORT = 8274;
let job=null;
const json=(res,data,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data))};
function body(req){return new Promise((resolve,reject)=>{let text='';req.on('data',b=>text+=b);req.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}});req.on('error',reject)})}
async function generate(req,res){
 if(job && job.state==='running')return json(res,{error:'A video is already generating.'},409);
 let b;try{b=await body(req)}catch(e){return json(res,{error:e.message},400)}
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 job={id:'test',state:'running',pid:child.pid};return json(res,{id:'test',pid:child.pid});
}
http.createServer((req,res)=>{if(req.url==='/api/status')return json(res,{ready:true,files:[],videos:[],job,serverPid:process.pid});if(req.method==='POST'&&req.url==='/api/generate')return generate(req,res);return json(res,{},404)}).listen(PORT,'127.0.0.1');`;

test('H3 bootstrap refuses changed upstream code rather than starting without the guard', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-source-'));
  await fs.writeFile(
    path.join(dir, 'server.js'),
    fixture.replace('const ROOT = __dirname, PORT = 8274;', 'const ROOT = __dirname, PORT = 8275;'),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'runtime', 'h3_bootstrap.cjs'), dir],
    {
      env: { ...process.env, FORGE_H3_INTERNAL_PORT: '12345' },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /startup code changed/);
});

test(
  'H3 guard fences overlapping uploads and kills the owned renderer after a guard crash',
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-guard-'));
    await fs.writeFile(path.join(dir, 'server.js'), fixture);
    const guard = spawn(
      python,
      [
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
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let logs = '';
    guard.stdout.on('data', (chunk) => (logs += chunk));
    guard.stderr.on('data', (chunk) => (logs += chunk));
    let serverPid = null,
      rendererPid = null;
    t.after(() => {
      if (guard.exitCode === null) {
        guard.kill();
      }
      for (const pid of [serverPid, rendererPid]) {
        if (pid && alive(pid)) {
          try {
            process.kill(pid);
          } catch {
            // The process may exit between the liveness check and the signal.
          }
        }
      }
    });
    const base = `http://127.0.0.1:${port}`;
    const status = await waitFor(async () => {
      const r = await fetch(`${base}/api/status`);
      return r.ok && r.json();
    });
    serverPid = status.serverPid;
    let firstResponse;
    const first = new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/api/generate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      req.write('{"test":');
      firstResponse = () => req.end('true}');
    });
    await pause(250);
    const second = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test":true}',
    });
    assert.equal(second.status, 200);
    rendererPid = (await second.json()).pid;
    firstResponse();
    assert.equal((await first).status, 409);
    assert.ok(alive(rendererPid));
    guard.kill();
    await once(guard, 'exit');
    await waitFor(() => !alive(serverPid) && !alive(rendererPid));
    assert.equal(alive(serverPid), false, logs);
    assert.equal(alive(rendererPid), false, logs);
  },
);

const h3 = path.join(os.homedir(), 'Desktop', 'H3 Studio');
const h3Node = path.join(h3, 'engine', 'node.exe');
test(
  'the real H3 application starts behind the guard without loading a model',
  {
    skip: !enabled || !existsSync(h3Node) || !existsSync(path.join(h3, 'server.js')),
    timeout: 20000,
  },
  async (t) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const guard = spawn(
      python,
      [
        '-u',
        path.join(root, 'runtime', 'h3_guard.py'),
        '--port',
        String(port),
        '--node',
        h3Node,
        '--bootstrap',
        path.join(root, 'runtime', 'h3_bootstrap.cjs'),
        '--engine-dir',
        h3,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let logs = '';
    guard.stdout.on('data', (chunk) => (logs += chunk));
    guard.stderr.on('data', (chunk) => (logs += chunk));
    t.after(() => {
      if (guard.exitCode === null) {
        guard.kill();
      }
    });
    const status = await waitFor(async () => {
      if (guard.exitCode !== null) {
        throw Error(logs);
      }
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      return r.ok && r.json();
    });
    assert.equal(typeof status.ready, 'boolean');
    assert.equal(status.job, null);
    assert.ok(Array.isArray(status.files));
    guard.kill();
    await once(guard, 'exit');
  },
);

test(
  'the engine supervisor restarts a crashed video guard without reviving the old render',
  { skip: !enabled, timeout: 30000 },
  async (t) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-restart-'));
    await fs.writeFile(path.join(dir, 'server.js'), fixture);
    const definition = {
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
    };
    const manager = new EngineManager({ definitions: [definition], logDir: dir });
    t.after(async () => {
      manager.closed = true;
      const entry = manager.children.get('video');
      if (entry && entry.child.exitCode === null) {
        const exited = once(entry.child, 'exit');
        entry.child.kill();
        await exited;
      }
    });
    const first = await manager.start('video');
    assert.equal(first.status, 'starting');
    const base = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const r = await fetch(`${base}/api/status`);
      return r.ok;
    });
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const renderer = (await response.json()).pid;
    assert.ok(alive(renderer));
    manager.children.get('video').child.kill();
    await waitFor(() => !alive(renderer));
    const replacement = await waitFor(async () => {
      const entry = manager.children.get('video');
      if (!entry || entry.child.pid === first.pid) {
        return null;
      }
      const r = await fetch(`${base}/api/status`);
      return r.ok ? { pid: entry.child.pid, body: await r.json() } : null;
    });
    assert.notEqual(replacement.pid, first.pid);
    assert.equal(replacement.body.job, null);
  },
);
