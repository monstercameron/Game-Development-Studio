import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { convertAsset } from '../runtime/transcode.js';

async function makeProject(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-transcode-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  await fs.mkdir(path.join(folder, 'Images'));
  await fs.writeFile(path.join(folder, 'Images', 'sample.png'), 'source bytes');
  return {
    id: 'transcode-test',
    folder,
    assets: [{ id: 'Images/sample.png', category: 'Images' }],
  };
}

function stubTranscoder(t, { exitCode = 0, stdout = '{"backend":"CPU"}', stderr = '' } = {}) {
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (input) => {
      const config = JSON.parse(input);
      setImmediate(async () => {
        if (exitCode === 0) {
          await fs.writeFile(config.target, 'converted bytes');
        }
        if (stdout) {
          child.stdout.emit('data', Buffer.from(stdout));
        }
        if (stderr) {
          child.stderr.emit('data', Buffer.from(stderr));
        }
        child.emit('close', exitCode);
      });
    };
    child.kill = () => {};
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
}

test('conversion rejects unsupported formats and invalid conversion options before spawning', async (t) => {
  const project = await makeProject(t);
  stubTranscoder(t);

  await assert.rejects(
    convertAsset(project, { path: 'Images/sample.png', format: 'gif' }),
    /Choose a supported format/,
  );
  await assert.rejects(
    convertAsset(project, { path: 'Images/sample.png', format: 'jpeg', quality: 0 }),
    /Quality must be between 1 and 100/,
  );
  await assert.rejects(
    convertAsset(project, { path: 'Images/sample.png', format: 'jpeg', background: 'white' }),
    /Choose a valid background color/,
  );
  assert.equal(childProcess.spawn.mock.calls.length, 0);
});

test('conversion rejects an asset whose resolved path escapes the project', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-transcode-boundary-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const projectFolder = path.join(folder, 'project');
  await fs.mkdir(projectFolder);
  await fs.writeFile(path.join(folder, 'outside.png'), 'outside bytes');
  const project = {
    id: 'transcode-test',
    folder: projectFolder,
    assets: [{ id: '../outside.png', category: 'Images' }],
  };
  stubTranscoder(t);

  await assert.rejects(
    convertAsset(project, { path: '../outside.png', format: 'png' }),
    /Asset not found/,
  );
  assert.equal(childProcess.spawn.mock.calls.length, 0);
});

test('conversion picks a fresh destination and preserves an existing converted asset', async (t) => {
  const project = await makeProject(t);
  await fs.writeFile(path.join(project.folder, 'Images', 'sample-converted.png'), 'existing bytes');
  stubTranscoder(t);

  const result = await convertAsset(project, { path: 'Images/sample.png', format: 'png' });

  assert.equal(result.path, 'Images/sample-converted-2.png');
  assert.equal(result.name, 'sample-converted-2.png');
  assert.equal(result.backend, 'CPU');
  assert.equal(
    await fs.readFile(path.join(project.folder, 'Images', 'sample-converted.png'), 'utf8'),
    'existing bytes',
  );
  assert.equal(
    await fs.readFile(path.join(project.folder, 'Images', 'sample-converted-2.png'), 'utf8'),
    'converted bytes',
  );
  assert.deepEqual(
    (await fs.readdir(path.join(project.folder, 'Images'))).filter((name) =>
      name.startsWith('.forge-convert-'),
    ),
    [],
  );
});

test('conversion reports the final worker error line and removes the temporary output', async (t) => {
  const project = await makeProject(t);
  stubTranscoder(t, { exitCode: 1, stderr: 'traceback\nUnsupported source file.' });

  await assert.rejects(
    convertAsset(project, { path: 'Images/sample.png', format: 'png' }),
    /^Error: Unsupported source file\.$/,
  );
  assert.deepEqual((await fs.readdir(path.join(project.folder, 'Images'))).sort(), ['sample.png']);
});
