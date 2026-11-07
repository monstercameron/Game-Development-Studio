import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHTTP,
} from '@modelcontextprotocol/client';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      // The service may not be listening yet.
    }
    await pause(60);
  }
  throw Error('Timed out');
}
test(
  'HTTP model removal only deletes confirmed files in an isolated studio',
  { timeout: 35000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-removal-http-'));
    const root = path.join(dir, 'studio');
    await fs.mkdir(root);
    let child = null;
    t.after(async () => {
      if (child?.exitCode === null) {
        child.kill();
        await Promise.race([once(child, 'exit').catch(() => {}), pause(5000)]);
        await pause(500);
      }
      await fs.unlink(path.join(root, 'node_modules')).catch(() => {});
      const resolved = await fs.realpath(dir),
        temp = await fs.realpath(os.tmpdir());
      if (
        path.dirname(resolved) !== temp ||
        !path.basename(resolved).startsWith('forge-removal-http-')
      ) {
        throw Error('Unexpected test directory.');
      }
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    for (const file of [
      'server.js',
      'projects.js',
      'project-assets.js',
      'diagnostics.js',
      'power.js',
      'chat-service.js',
      'credential-service.js',
      'package.json',
    ]) {
      await fs.copyFile(path.join(app, file), path.join(root, file));
    }
    await fs.cp(path.join(app, 'runtime'), path.join(root, 'runtime'), { recursive: true });
    await fs.symlink(path.join(app, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><title>test</title>');
    const folder = path.join(root, 'models', 'Qwen3-TTS-12Hz-1.7B-CustomVoice');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'weights.bin'), 'disposable model');
    const sentinel = path.join(root, 'preserved.txt');
    await fs.writeFile(sentinel, 'keep');
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('FORGE_')),
    );
    env.FORGE_RUNTIME_DIR = path.join(root, '.forge-runtime');
    env.FORGE_PROJECTS_DIR = path.join(root, 'projects');
    child = fork(path.join(root, 'server.js'), ['--port', String(port)], {
      cwd: root,
      env,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let logs = '';
    child.stdout.on('data', (data) => (logs += data));
    child.stderr.on('data', (data) => (logs += data));
    const base = `http://127.0.0.1:${port}`;
    const post = (body) =>
      fetch(`${base}/api/runtime/models/tts/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forge-Request': 'runtime' },
        body: JSON.stringify(body),
      });
    try {
      await waitFor(async () => {
        const response = await fetch(`${base}/api/runtime/health`);
        return response.ok;
      });
      const forbiddenOrigin = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { Origin: 'http://example.com', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(forbiddenOrigin.status, 403);
      const wrongHost = await new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/models', headers: { Host: 'example.com' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(wrongHost, 403);
      const tooLarge = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(270000) }),
      });
      assert.equal(tooLarge.status, 413);
      const catalogResponse = await fetch(`${base}/api/models`);
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json();
      assert.equal(catalog.schemaVersion, 1);
      assert.equal(catalog.runtimeAvailable, true);
      assert.ok(
        catalog.models.some((model) => model.id === 'chat' && model.purpose && model.inputs.length),
      );
      assert.ok(
        catalog.models.some(
          (model) =>
            model.id === '3d-trellis' &&
            model.notes.some((note) => /not been verified/i.test(note)),
        ),
      );
      const oldClient = new Client(
        { name: 'old-http-test', version: '1.0.0' },
        { versionNegotiation: { mode: 'legacy' } },
      );
      t.after(() => oldClient.close());
      await assert.rejects(
        oldClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))),
      );
      const mcp = new Client(
        { name: 'catalog-http-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      t.after(() => mcp.close());
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      assert.ok((await mcp.listTools()).tools.some((tool) => tool.name === 'forge_models'));
      const viaMcp = await mcp.callTool({ name: 'forge_models', arguments: {} });
      assert.equal(viaMcp.isError, undefined);
      assert.deepEqual(
        JSON.parse(viaMcp.content[0].text).models.map((model) => model.id),
        catalog.models.map((model) => model.id),
      );
      const modern = new ModernClient(
        { name: 'catalog-modern-http-test', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      t.after(() => modern.close());
      await modern.connect(new ModernHTTP(new URL(`${base}/mcp`)));
      assert.equal(modern.getProtocolEra(), 'modern');
      assert.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
      const modernResult = await modern.callTool({ name: 'forge_models', arguments: {} });
      assert.deepEqual(
        JSON.parse(modernResult.content[0].text).models.map((model) => model.id),
        catalog.models.map((model) => model.id),
      );
      const denied = await post({});
      assert.equal(denied.status, 400);
      assert.equal(await fs.readFile(path.join(folder, 'weights.bin'), 'utf8'), 'disposable model');
      let accepted;
      await waitFor(async () => {
        const response = await post({ confirmation: 'permanently-delete-model' });
        const body = await response.json();
        if (response.status === 400 && /queue check|queue lease/i.test(body.error || '')) {
          return false;
        }
        accepted = { response, body };
        return true;
      });
      assert.equal(accepted.response.status, 202, JSON.stringify(accepted.body));
      await waitFor(async () => {
        const response = await fetch(`${base}/api/runtime/model-storage`);
        const body = await response.json();
        return body.removals?.tts?.state === 'complete';
      });
      await assert.rejects(fs.stat(folder), { code: 'ENOENT' });
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
    } catch (error) {
      error.message += `\nIsolated server logs: ${logs.slice(-3000)}`;
      throw error;
    }
  },
);
