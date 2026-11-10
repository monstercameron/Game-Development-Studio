import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';

// The real queue worker is isolated to a temporary project and cannot reach model services.
test(
  'runtime project trash routes require local authorization and restore the entire folder',
  { timeout: 30000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-project-route-'));
    const projects = path.join(directory, 'projects');
    const folder = path.join(projects, 'Example');
    const id = randomUUID();
    await fs.mkdir(path.join(folder, 'images'), { recursive: true });
    await fs.writeFile(
      path.join(folder, '.forge-project.json'),
      JSON.stringify({ id, name: 'Example' }),
    );
    await fs.writeFile(path.join(folder, 'images', 'example.png'), 'fixture');
    const env = {
      FORGE_RUNTIME_DIR: path.join(directory, 'runtime'),
      FORGE_PROJECTS_DIR: projects,
    };
    for (const key of [
      'FORGE_MUSIC_URL',
      'FORGE_SFX_URL',
      'FORGE_TTS_URL',
      'FORGE_HUNYUAN_URL',
      'FORGE_TRELLIS_URL',
      'FORGE_SAM31_URL',
      'FORGE_IMAGE_URL',
      'FORGE_VIDEO_URL',
      'FORGE_WORLD_URL',
      'FORGE_HYMOTION_URL',
      'FORGE_MOTIONBRICKS_URL',
    ]) {
      env[key] = 'http://127.0.0.1:1';
    }
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const { runtimeService } = await import(
      `../runtime/supervisor.js?project-route=${randomUUID()}`
    );
    const app = express();
    const server = createServer(app);
    runtimeService().configureServer({ middlewares: app, httpServer: server });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      server.close();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, authorised = true) =>
      fetch(origin + route, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: authorised ? origin : 'http://untrusted.example',
          'X-Forge-Request': 'runtime',
        },
        body: JSON.stringify(body),
      });
    const until = Date.now() + 15000;
    let health;
    while (Date.now() < until) {
      health = await fetch(origin + '/api/runtime/health');
      if (health.ok) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(health?.ok, true, 'isolated runtime started');
    assert.equal(
      (await post('/api/runtime/projects/trash', { projectId: id, confirmation: 'Example' }, false))
        .status,
      403,
    );
    assert.equal(
      (await post('/api/runtime/projects/trash', { projectId: id, confirmation: 'wrong' })).status,
      400,
    );
    const moved = await post('/api/runtime/projects/trash', {
      projectId: id,
      confirmation: 'Example',
    });
    assert.equal(moved.status, 200);
    const { trashId } = await moved.json();
    const listed = await (await fetch(origin + '/api/runtime/projects/trash')).json();
    assert.equal(listed.projects[0].trashId, trashId);
    assert.equal((await post('/api/runtime/projects/restore', { trashId })).status, 200);
    assert.equal(await fs.readFile(path.join(folder, 'images', 'example.png'), 'utf8'), 'fixture');
  },
);
