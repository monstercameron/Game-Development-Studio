import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) {
        return last;
      }
    } catch {
      // The service may not be listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for service');
}

test(
  'one service serves the app and APIs and restores its HTTP host after a crash',
  { timeout: 65000 },
  async (t) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-service-'));
    const engineProbe = createServer();
    engineProbe.listen(0, '127.0.0.1');
    await once(engineProbe, 'listening');
    const enginePort = engineProbe.address().port;
    await new Promise((resolve) => engineProbe.close(resolve));
    const config = [
      {
        id: 'sfx',
        name: 'Mock sound engine',
        port: enginePort,
        endpoint: '/api/status',
        kind: 'stable-audio',
        cwd: tempDirectory,
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/mock-engine.js', import.meta.url)),
          String(enginePort),
        ],
      },
    ];
    const env = {
      ...process.env,
      FORGE_RUNTIME_DIR: path.join(tempDirectory, 'runtime'),
      FORGE_DISABLE_TRAY: '1',
      FORGE_PROJECTS_DIR: path.join(tempDirectory, 'projects'),
      FORGE_ENGINE_CONFIG: JSON.stringify(config),
      FORGE_SFX_URL: `http://127.0.0.1:${enginePort}`,
      FORGE_MOTIONBRICKS_URL: `http://127.0.0.1:${enginePort}`,
    };
    const child = fork(
      fileURLToPath(new URL('../server.js', import.meta.url)),
      ['--port', String(port)],
      { env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
    );
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    let enginePid = null;
    t.after(() => {
      if (child.exitCode === null) {
        child.kill();
      }
      if (enginePid) {
        try {
          process.kill(enginePid);
        } catch {
          // The engine may have exited before cleanup.
        }
      }
    });
    const base = `http://127.0.0.1:${port}`;
    const before = await waitFor(async () => {
      const response = await fetch(`${base}/api/diagnostics`);
      return response.ok && response.json();
    });
    assert.equal(before.server.supervisorPid, child.pid);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Forge/);
    assert.equal((await fetch(`${base}/samples/alchemist.png`)).status, 200);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    const hostStatus = await new Promise((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: '/api/runtime/jobs',
            headers: { host: 'evil.example' },
            agent: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        )
        .on('error', reject);
    });
    assert.equal(hostStatus, 403);
    assert.equal(
      (
        await fetch(`${base}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'project' },
      body: JSON.stringify({ name: 'Service test' }),
    });
    assert.equal(created.status, 201);
    const project = (await created.json()).project;
    const saveText = (body) =>
      fetch(`${base}/api/projects/${project.id}/assets/create-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'project' },
        body: JSON.stringify(body),
      });
    const textCreated = await saveText({ kind: 'transcript', content: 'Welcome to the forest.' });
    assert.equal(textCreated.status, 201);
    const textPath = (await textCreated.json()).path;
    assert.match(textPath, /^text\/transcript-.*\.txt$/);
    const listed = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(
      listed.projects
        .find((item) => item.id === project.id)
        .assets.find((item) => item.id === textPath).category,
      'Text',
    );
    const textResponse = await fetch(
      `${base}/api/projects/${project.id}/asset?path=${encodeURIComponent(textPath)}`,
    );
    assert.equal(await textResponse.text(), 'Welcome to the forest.');
    assert.equal(
      (
        await fetch(`${base}/api/projects/${project.id}/assets/create-text`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'http://evil.example',
            'X-Forge-Request': 'project',
          },
          body: JSON.stringify({ kind: 'chat', content: 'bad' }),
        })
      ).status,
      403,
    );
    const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('reference')]);
    const upload = await fetch(`${base}/api/projects/${project.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', Origin: base, 'X-Forge-Request': 'project' },
      body: image,
    });
    assert.equal(upload.status, 201);
    const staged = (await upload.json()).reference;
    assert.match(staged.id, /\.png$/);
    assert.deepEqual(
      await fs.readFile(path.join(project.folder, '.forge-inputs', staged.id)),
      image,
    );
    const unauthorized = await fetch(`${base}/api/projects/${project.id}/references`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'X-Forge-Request': 'project' },
      body: image,
    });
    assert.equal(unauthorized.status, 403);
    // H3 reference clips are copied from project assets by path, never uploaded.
    await fs.writeFile(path.join(project.folder, 'video', 'motion.webm'), 'webm bytes');
    const clipRequest = (body, headers = {}) =>
      fetch(`${base}/api/projects/${project.id}/clips/from-asset`, {
        method: 'POST',
        headers: { Origin: base, 'X-Forge-Request': 'project', ...headers },
        body: JSON.stringify(body),
      });
    const clip = await clipRequest({ path: 'video/motion.webm' });
    assert.equal(clip.status, 201);
    const stagedClip = (await clip.json()).reference;
    assert.match(stagedClip.id, /^[a-f0-9-]{36}.webm$/);
    assert.equal(stagedClip.kind, 'video');
    assert.equal(
      await fs.readFile(path.join(project.folder, '.forge-inputs', stagedClip.id), 'utf8'),
      'webm bytes',
    );
    assert.equal((await clipRequest({ path: '../escape.webm' })).status, 400);
    assert.equal((await clipRequest({ path: 'video/missing.webm' })).status, 400);
    assert.equal(
      (await clipRequest({ path: 'video/motion.webm' }, { Origin: 'http://evil.example' })).status,
      403,
    );
    const uploadedClip = await fetch(`${base}/api/projects/${project.id}/clips`, {
      method: 'POST',
      headers: { Origin: base, 'X-Forge-Request': 'project' },
      body: 'webm bytes',
    });
    assert.equal(uploadedClip.status, 400);
    await fs.writeFile(path.join(project.folder, 'images', 'reference.png'), image);
    const runtime = await waitFor(async () => {
      const response = await fetch(`${base}/api/runtime/health`);
      return response.ok && response.json();
    });
    assert.equal(runtime.state, 'ready');
    const start = await fetch(`${base}/api/runtime/engines/start-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'runtime' },
      body: '{}',
    });
    const engine = (await start.json()).services[0];
    assert.equal(engine.status, 'starting');
    enginePid = engine.pid;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${enginePort}/api/status`);
      return response.ok;
    });
    const loadSound = await fetch(`${base}/api/runtime/models/sfx/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'runtime' },
      body: JSON.stringify({ token: 'test-only-secret' }),
    });
    assert.equal(loadSound.status, 200);
    assert.equal((await loadSound.json()).code, 'already_loaded');
    assert.doesNotMatch(output, /test-only-secret/);
    const bricksLoad = await fetch(`${base}/api/runtime/models/motion-bricks/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'runtime' },
      body: '{}',
    });
    assert.equal(bricksLoad.status, 503);
    assert.equal((await bricksLoad.json()).code, 'engine_unavailable');
    process.kill(runtime.pid);
    const newRuntime = await waitFor(async () => {
      const response = await fetch(`${base}/api/runtime/health`);
      if (!response.ok) {
        return null;
      }
      const value = await response.json();
      return value.pid !== runtime.pid ? value : null;
    });
    assert.notEqual(newRuntime.pid, runtime.pid);
    const runtimeLogs = await waitFor(async () => {
      const response = await fetch(`${base}/api/logs?source=runtime-worker`);
      const result = await response.json();
      const lines = result.sources?.[0]?.lines || [];
      return lines.some((line) => line.includes(`event=worker_stopped pid=${runtime.pid}`)) &&
        lines.some((line) => line.includes(`event=worker_ready pid=${newRuntime.pid}`))
        ? lines
        : null;
    });
    assert.ok(
      runtimeLogs.some((line) => line.includes(`event=worker_ready pid=${newRuntime.pid}`)),
    );
    const afterRuntimeRestart = await (await fetch(`${base}/api/runtime/services`)).json();
    assert.equal(afterRuntimeRestart.services.find((item) => item.id === 'sfx').managed, true);
    const mcp = new Client(
      { name: 'forge-service-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    t.after(() => mcp.close());
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
        env: { ...process.env, FORGE_STUDIO_URL: base },
        stderr: 'pipe',
      }),
    );
    const result = await mcp.callTool({ name: 'forge_projects', arguments: {} });
    assert.ok(JSON.parse(result.content[0].text).projects.some((item) => item.id === project.id));
    const fakeSecret = 'hf_FixtureToken1234567890';
    await fs.appendFile(
      path.join(tempDirectory, 'runtime', 'runtime-worker.log'),
      `\nfixture ${fakeSecret}\n`,
    );
    const mcpLogs = await mcp.callTool({
      name: 'forge_logs',
      arguments: { source: 'runtime-worker' },
    });
    assert.ok(
      JSON.parse(mcpLogs.content[0].text).sources[0].lines.some((line) =>
        line.includes(`event=worker_stopped pid=${runtime.pid}`),
      ),
    );
    assert.doesNotMatch(mcpLogs.content[0].text, new RegExp(fakeSecret));
    assert.match(mcpLogs.content[0].text, /REDACTED/);
    const httpMcp = new Client(
      { name: 'forge-http-test', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    t.after(() => httpMcp.close());
    await httpMcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const toolDefinitions = (await httpMcp.listTools()).tools;
    const httpTools = toolDefinitions.map((tool) => tool.name);
    assert.ok(httpTools.includes('forge_jobs'));
    assert.ok(httpTools.includes('forge_queue_video'));
    assert.ok(httpTools.includes('forge_stage_video_reference'));
    assert.ok(httpTools.includes('forge_stage_reference'));
    assert.ok(httpTools.includes('forge_load_sound_model'));
    assert.ok(httpTools.includes('forge_clear_sound_load_barrier'));
    assert.ok(httpTools.includes('forge_load_game_model'));
    assert.ok(httpTools.includes('forge_clear_game_load_barrier'));
    assert.ok(httpTools.includes('forge_stage_soma_pose'));
    assert.ok(httpTools.includes('forge_queue_motionbricks'));
    assert.ok(httpTools.includes('forge_load_motionbricks_model'));
    assert.ok(httpTools.includes('forge_model_storage'));
    assert.ok(httpTools.includes('forge_remove_managed_model'));
    assert.ok(httpTools.includes('forge_rename_asset'));
    const unconfirmedRemoval = await httpMcp.callTool({
      name: 'forge_remove_managed_model',
      arguments: { id: 'tts', confirmation: 'no' },
    });
    assert.equal(unconfirmedRemoval.isError, true);
    const inventory = await httpMcp.callTool({ name: 'forge_model_storage', arguments: {} });
    assert.notEqual(inventory.isError, true);
    assert.ok(['scanning', 'ready'].includes(JSON.parse(inventory.content[0].text).state));
    assert.ok(
      toolDefinitions
        .find((tool) => tool.name === 'forge_offload_model')
        .inputSchema.properties.id.enum.includes('images'),
    );
    assert.ok(
      toolDefinitions
        .find((tool) => tool.name === 'forge_offload_model')
        .inputSchema.properties.id.enum.includes('asr'),
    );
    assert.ok(
      toolDefinitions
        .find((tool) => tool.name === 'forge_offload_model')
        .inputSchema.properties.id.enum.includes('video'),
    );
    const soundLoad = await waitFor(async () => {
      const result = await httpMcp.callTool({ name: 'forge_load_sound_model', arguments: {} });
      return result.isError ? null : result;
    }, 30000);
    assert.equal(JSON.parse(soundLoad.content[0].text).code, 'already_loaded');
    const stagedByMcp = await httpMcp.callTool({
      name: 'forge_stage_video_reference',
      arguments: { projectId: project.id, path: 'images/reference.png' },
    });
    assert.equal(stagedByMcp.isError, false);
    assert.match(JSON.parse(stagedByMcp.content[0].text).reference.id, /\.png$/);
    const renamed = await httpMcp.callTool({
      name: 'forge_rename_asset',
      arguments: { projectId: project.id, path: 'images/reference.png', name: 'renamed.png' },
    });
    assert.equal(renamed.isError, false);
    assert.equal(JSON.parse(renamed.content[0].text).path, 'images/renamed.png');
    assert.deepEqual(await fs.readFile(path.join(project.folder, 'images', 'renamed.png')), image);
    const renamedProjects = await (await fetch(`${base}/api/projects`)).json();
    assert.equal(
      renamedProjects.projects
        .find((item) => item.id === project.id)
        .assets.find((asset) => asset.id === 'images/renamed.png').sourceOutput,
      'images/reference.png',
    );
    const jobId = randomUUID();
    const db = new DatabaseSync(path.join(tempDirectory, 'runtime', 'jobs.sqlite'));
    const now = new Date().toISOString();
    try {
      db.prepare(
        'INSERT INTO jobs(id,type,project_id,request,status,output,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ).run(jobId, 'images', project.id, '{}', 'completed', 'images/reference.png', now, now);
    } finally {
      db.close();
    }
    const relocated = await (await fetch(`${base}/api/runtime/jobs/${jobId}`)).json();
    assert.equal(relocated.job.output, 'images/renamed.png');
    assert.equal(relocated.job.originalOutput, 'images/reference.png');
    await fs.writeFile(
      path.join(project.folder, 'motion', 'soma.bvh'),
      'HIERARCHY\nROOT Hips\n{}\nMOTION\nFrames: 1\nFrame Time: 0.033333333\n0\n',
    );
    const stagedPose = await httpMcp.callTool({
      name: 'forge_stage_soma_pose',
      arguments: { projectId: project.id, path: 'motion/soma.bvh' },
    });
    assert.equal(stagedPose.isError, false);
    assert.match(JSON.parse(stagedPose.content[0].text).reference.id, /\.bvh$/);
    const badPath = await httpMcp.callTool({
      name: 'forge_stage_video_reference',
      arguments: { projectId: project.id, path: '../outside.png' },
    });
    assert.equal(badPath.isError, true);
    const mcpProjects = await httpMcp.callTool({ name: 'forge_projects', arguments: {} });
    assert.ok(
      JSON.parse(mcpProjects.content[0].text).projects.some((item) => item.id === project.id),
    );
    const crossOrigin = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    process.kill(before.server.pid);
    const after = await waitFor(async () => {
      const response = await fetch(`${base}/api/diagnostics`);
      if (!response.ok) {
        return null;
      }
      const value = await response.json();
      return value.server.pid !== before.server.pid ? value : null;
    });
    assert.equal(after.server.supervisorPid, child.pid);
    const retainedLogs = await (await fetch(`${base}/api/logs?source=runtime-worker`)).json();
    assert.ok(
      retainedLogs.sources[0].lines.some((line) =>
        line.includes(`event=worker_stopped pid=${runtime.pid}`),
      ),
    );
    const retained = await waitFor(async () => {
      const response = await fetch(`${base}/api/runtime/services`);
      if (!response.ok) {
        return null;
      }
      const value = await response.json();
      return value.services.find((item) => item.id === 'sfx' && item.managed);
    });
    assert.equal(retained.managed, true);
    const again = await fetch(`${base}/api/runtime/engines/start-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'runtime' },
      body: '{}',
    });
    const managed = (await again.json()).services[0];
    assert.equal(managed.status, 'already_managed');
    assert.equal(managed.pid, enginePid);
    // One engine can be started on its own, with the same checks as start-all.
    const startOne = (id, headers = {}) =>
      fetch(`${base}/api/runtime/engines/${id}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: base,
          'X-Forge-Request': 'runtime',
          ...headers,
        },
        body: '{}',
      });
    const single = await startOne('sfx');
    assert.equal(single.status, 200);
    const singleResult = await single.json();
    assert.equal(singleResult.status, 'already_managed');
    assert.equal(singleResult.pid, enginePid);
    const unknown = await startOne('nope');
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /Unknown engine/);
    assert.equal((await startOne('sfx', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await startOne('sfx', { 'X-Forge-Request': 'other' })).status, 403);
    assert.equal((await startOne('SFX')).status, 404, 'ids are lower case');
    assert.equal((await fetch(`${base}/api/runtime/engines/sfx/start`)).status, 404);
    assert.equal(retained.startsOnDemand, false);
    let offloadError = '';
    let stopped;
    try {
      stopped = await waitFor(async () => {
        const response = await fetch(`${base}/api/runtime/models/sfx/offload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: base,
            'X-Forge-Request': 'runtime',
          },
          body: '{}',
        });
        const result = await response.json();
        if (!response.ok) {
          offloadError = JSON.stringify(result);
          return null;
        }
        return result;
      }, 30000);
    } catch (error) {
      throw Error(`${error.message}: ${offloadError}; logs: ${output}`, { cause: error });
    }
    assert.equal(stopped.stopped, true);
    enginePid = null;
    const projects = await (await fetch(`${base}/api/projects`)).json();
    assert.ok(projects.projects.some((item) => item.id === project.id));
    assert.match(output, /event=host_restart_scheduled/);
  },
);
