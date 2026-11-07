import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveGeneratedText } from '../project-assets.js';

test('generated text is saved in a project as reviewable TXT or JSON without overwriting', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-text-assets-'));
  t.after(async () => {
    const real = await fs.realpath(dir),
      temp = await fs.realpath(os.tmpdir());
    if (path.dirname(real) !== temp || !path.basename(real).startsWith('forge-text-assets-')) {
      throw Error('Unexpected test directory');
    }
    await fs.rm(real, { recursive: true, force: true });
  });
  const project = { folder: dir },
    text = 'Welcome, adventurer. The forest is waiting.';
  const first = await saveGeneratedText(project, { kind: 'transcript', content: text });
  const second = await saveGeneratedText(project, { kind: 'transcript', content: text });
  assert.match(first.path, /^text\/transcript-[a-f0-9-]+\.txt$/);
  assert.notEqual(first.path, second.path);
  assert.equal(await fs.readFile(path.join(dir, ...first.path.split('/')), 'utf8'), text);
  const output = await saveGeneratedText(project, { kind: 'decision', content: '{"answer":true}' });
  assert.match(output.path, /\.json$/);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dir, ...output.path.split('/')), 'utf8')),
    { answer: true },
  );
  await assert.rejects(
    saveGeneratedText(project, { kind: '../escape', content: 'hello' }),
    /unsupported/i,
  );
  await assert.rejects(
    saveGeneratedText(project, { kind: 'decision', content: 'not json' }),
    /valid JSON/i,
  );
  await assert.rejects(saveGeneratedText(project, { kind: 'chat', content: ' ' }), /text must/i);
  await assert.rejects(
    saveGeneratedText(project, { kind: 'chat', content: 'x'.repeat(100001) }),
    /text must/i,
  );
});

test('generated text refuses a linked project text directory', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-text-assets-'));
  const outside = path.join(dir, 'outside'),
    projectDir = path.join(dir, 'project');
  await fs.mkdir(outside);
  await fs.mkdir(projectDir);
  t.after(async () => {
    const real = await fs.realpath(dir),
      temp = await fs.realpath(os.tmpdir());
    if (path.dirname(real) !== temp || !path.basename(real).startsWith('forge-text-assets-')) {
      throw Error('Unexpected test directory');
    }
    await fs.unlink(path.join(projectDir, 'text')).catch(() => {});
    await fs.rm(real, { recursive: true, force: true });
  });
  await fs.symlink(
    outside,
    path.join(projectDir, 'text'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    saveGeneratedText({ folder: projectDir }, { kind: 'transcript', content: 'example' }),
    /invalid project text folder/i,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});
