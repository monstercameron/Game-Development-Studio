import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP creates a project and updates asset metadata through the real project API', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const previous = process.env.FORGE_PROJECTS_DIR;
  process.env.FORGE_PROJECTS_DIR = root;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FORGE_PROJECTS_DIR;
    } else {
      process.env.FORGE_PROJECTS_DIR = previous;
    }
  });
  const { projectsService } = await import('../projects.js');
  const app = express();
  projectsService().configureServer({ middlewares: app });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client(
    { name: 'project-workflow-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../runtime/mcp.js', import.meta.url))],
      env: { ...process.env, FORGE_STUDIO_URL: origin },
      stderr: 'pipe',
    }),
  );

  const created = await client.callTool({
    name: 'forge_create_project',
    arguments: { name: 'Agent project' },
  });
  assert.notEqual(created.isError, true);
  const project = JSON.parse(created.content[0].text).project;
  assert.equal(project.name, 'Agent project');
  assert.equal(project.folder, path.join(root, 'Agent project'));
  const saved = await client.callTool({
    name: 'forge_save_text_asset',
    arguments: { projectId: project.id, kind: 'transcript', content: 'A saved transcript.' },
  });
  assert.notEqual(saved.isError, true);
  const textPath = JSON.parse(saved.content[0].text).path;
  const text = await client.callTool({
    name: 'forge_read_text_asset',
    arguments: { projectId: project.id, path: textPath },
  });
  assert.equal(text.content[0].text, 'A saved transcript.');
  const escaped = await client.callTool({
    name: 'forge_read_text_asset',
    arguments: { projectId: project.id, path: '../outside.txt' },
  });
  assert.equal(escaped.isError, true);
  await fs.writeFile(path.join(project.folder, 'images', 'sample.png'), 'test asset');

  const input = { projectId: project.id, path: 'images/sample.png', rating: 5, kept: true };
  assert.notEqual(
    (await client.callTool({ name: 'forge_update_asset', arguments: input })).isError,
    true,
  );
  let listed = await client.callTool({ name: 'forge_projects', arguments: {} });
  let asset = JSON.parse(listed.content[0].text).projects[0].assets.find(
    (item) => item.id === input.path,
  );
  assert.equal(asset.rating, 5);
  assert.equal(asset.kept, true);
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aZkAAAAASUVORK5CYII=';
  const thumbnail = await fetch(
    `${origin}/api/projects/${project.id}/thumbnail?path=${encodeURIComponent(input.path)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project', Origin: origin },
      body: JSON.stringify({
        image: `data:image/png;base64,${png}`,
        modified: asset.modified,
        size: asset.size,
      }),
    },
  );
  assert.equal(thumbnail.status, 201);
  const preview = await client.callTool({
    name: 'forge_view_thumbnail',
    arguments: { projectId: project.id, path: input.path },
  });
  assert.equal(preview.content[0].type, 'image');
  assert.equal(preview.content[0].data, png);

  assert.notEqual(
    (
      await client.callTool({
        name: 'forge_update_asset',
        arguments: { projectId: project.id, path: input.path, rating: null },
      })
    ).isError,
    true,
  );
  listed = await client.callTool({ name: 'forge_projects', arguments: {} });
  asset = JSON.parse(listed.content[0].text).projects[0].assets.find(
    (item) => item.id === input.path,
  );
  assert.equal(asset.rating, null);
  assert.equal(asset.kept, true);
  assert.equal(
    (await client.callTool({ name: 'forge_update_asset', arguments: { ...input, rating: 6 } }))
      .isError,
    true,
  );
  assert.equal(
    (
      await client.callTool({
        name: 'forge_update_asset',
        arguments: { projectId: project.id, path: input.path },
      })
    ).isError,
    true,
  );
  assert.equal(
    (await client.callTool({ name: 'forge_create_project', arguments: { name: '   ' } })).isError,
    true,
  );
});
