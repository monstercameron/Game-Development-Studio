import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The video guard (runtime/h3_guard.py) answers the recovery identity challenge, which is what
// lets a restarted studio adopt a surviving video engine. The substitute H3 server below is a
// plain HTTP server; no model, GPU or real H3 application is involved.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const python = path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe');
const enabled = process.platform === 'win32' && existsSync(python);
const token = 'test-only-control-token';
const nonce = 'ab'.repeat(32);

// Same substitute server as test/h3-guard-stop.test.js; the launcher refuses code it does not
// recognize.
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

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startGuard(t, environment) {
  const port = await freePort();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-h3-identity-'));
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
    {
      env: { ...process.env, FORGE_ENGINE_CONTROL_TOKEN: token, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  guard.stdout.resume();
  guard.stderr.resume();
  t.after(async () => {
    if (guard.exitCode === null) {
      const exited = once(guard, 'exit');
      guard.kill();
      await exited;
    }
    // The guard's job object ends the H3 process tree a moment after the guard exits; the
    // fixture folder is its working directory until then.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) {
        return { base, guard };
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('The guarded video service did not start.');
}

test(
  'the video guard proves its identity only to the holder of the control token',
  { skip: !enabled, timeout: 40000 },
  async (t) => {
    const { base } = await startGuard(t, { FORGE_ENGINE_INSTANCE_NONCE: nonce });
    const good = await fetch(`${base}/api/forge/identity`, {
      headers: { 'X-Forge-Engine-Token': token },
    });
    assert.equal(good.status, 200);
    // The pid is the interpreter's (a venv launcher may sit above it); ownership checks it
    // against the OS listener, not against the spawned process.
    const body = await good.json();
    assert.equal(body.engine, 'video');
    assert.equal(body.nonce, nonce);
    assert.ok(Number.isInteger(body.pid) && body.pid > 0);
    const wrong = await fetch(`${base}/api/forge/identity`, {
      headers: { 'X-Forge-Engine-Token': 'not-the-token' },
    });
    assert.equal(wrong.status, 403);
    assert.equal((await fetch(`${base}/api/forge/identity`)).status, 403);
  },
);

test(
  'a video guard started without an instance nonce cannot be adopted',
  { skip: !enabled, timeout: 40000 },
  async (t) => {
    const { base } = await startGuard(t, { FORGE_ENGINE_INSTANCE_NONCE: '' });
    const response = await fetch(`${base}/api/forge/identity`, {
      headers: { 'X-Forge-Engine-Token': token },
    });
    assert.equal(response.status, 404);
  },
);
