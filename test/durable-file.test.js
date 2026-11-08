import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  copyFileExclusive,
  fsyncDirectory,
  moveAside,
  verifyOutputFile,
} from '../runtime/durable-file.js';
import { startCrashWorker } from './fixtures/start-crash-worker.js';

async function temp(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-durable-file-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('an atomic write replaces a file whole and leaves no staging file', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'state.json');
  await atomicWriteFile(file, '{"version":1}');
  await atomicWriteFile(file, '{"version":2}');
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":2}');
  atomicWriteFileSync(file, '{"version":3}');
  assert.equal(await fs.readFile(file, 'utf8'), '{"version":3}');
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
});

test('a write killed before the rename keeps the old file and leaves only a hidden staging file', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'state.json');
  await fs.writeFile(file, 'old complete content');
  const { child, ready } = startCrashWorker(t, 'atomic-before-rename', file, 'new content');
  await ready;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await fs.readFile(file, 'utf8'), 'old complete content');
  const leftovers = (await fs.readdir(directory)).filter((name) => name !== 'state.json');
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0], /^\.state\.json\.[0-9a-f-]{36}\.tmp$/);
});

test('the file is flushed before the rename', async (t) => {
  const directory = await temp(t);
  // Opening and closing a handle exposes FileHandle.prototype, so sync can be wrapped to record
  // the order of flush and rename.
  const handle = await fs.open(path.join(directory, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const order = [];
  const originalSync = prototype.sync;
  const originalRename = fs.rename;
  prototype.sync = async function sync() {
    order.push('fsync');
    return originalSync.call(this);
  };
  fs.rename = async (...args) => {
    order.push('rename');
    return originalRename(...args);
  };
  try {
    await atomicWriteFile(path.join(directory, 'state.json'), 'data');
  } finally {
    prototype.sync = originalSync;
    fs.rename = originalRename;
  }
  assert.ok(order.indexOf('fsync') !== -1 && order.indexOf('fsync') < order.indexOf('rename'));
});

test('copyFileExclusive never replaces a file and never exposes a partial copy', async (t) => {
  const directory = await temp(t);
  const source = path.join(directory, 'source.bin');
  const target = path.join(directory, 'target.bin');
  await fs.writeFile(source, 'payload');
  await copyFileExclusive(source, target);
  assert.equal(await fs.readFile(target, 'utf8'), 'payload');
  await assert.rejects(copyFileExclusive(source, target), { code: 'EEXIST' });
  assert.equal(await fs.readFile(target, 'utf8'), 'payload');
  assert.deepEqual((await fs.readdir(directory)).sort(), ['source.bin', 'target.bin']);
});

test('directory flushes are best effort', async (t) => {
  const directory = await temp(t);
  assert.equal(typeof (await fsyncDirectory(directory)), 'boolean');
});

test('a damaged file is moved aside under a recognisable name instead of deleted', async (t) => {
  const directory = await temp(t);
  const file = path.join(directory, 'asset.png');
  await fs.writeFile(file, 'broken');
  const moved = await moveAside(file, 'damaged');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.match(path.basename(moved), /^asset\.png\.damaged-\d+/);
  assert.equal(await fs.readFile(moved, 'utf8'), 'broken');
});

// Minimal GLB header: magic, version 2 and total length, the only fields the structural
// check reads.
function glb(size) {
  const buffer = Buffer.alloc(size);
  buffer.write('glTF', 0, 'latin1');
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(size, 8);
  return buffer;
}
// PNG signature, and an IEND chunk (zero length, type, CRC) that a complete PNG ends with.
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TAIL = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

test('output verification accepts complete files and rejects truncated ones by signature', async (t) => {
  const directory = await temp(t);
  const write = (name, data) => fs.writeFile(path.join(directory, name), data);
  const verify = (name) => verifyOutputFile(path.join(directory, name), path.extname(name));

  await write('whole.glb', glb(64));
  const whole = await verify('whole.glb');
  assert.deepEqual({ ok: whole.ok, level: whole.level }, { ok: true, level: 'structural' });
  await write('cut.glb', glb(64).subarray(0, 40));
  assert.match((await verify('cut.glb')).reason, /truncated/);

  await write('whole.png', Buffer.concat([PNG_HEAD, Buffer.alloc(20), PNG_TAIL]));
  assert.equal((await verify('whole.png')).ok, true);
  await write('cut.png', Buffer.concat([PNG_HEAD, Buffer.alloc(40)]));
  assert.match((await verify('cut.png')).reason, /truncated/);

  const wav = Buffer.alloc(60);
  wav.write('RIFF', 0, 'latin1');
  wav.writeUInt32LE(52, 4);
  wav.write('WAVE', 8, 'latin1');
  await write('whole.wav', wav);
  assert.equal((await verify('whole.wav')).ok, true);
  await write('cut.wav', wav.subarray(0, 30));
  assert.match((await verify('cut.wav')).reason, /truncated/);

  const bvh = 'HIERARCHY\nROOT Hips\n{\n}\nMOTION\nFrames: 2\nFrame Time: 0.033\n0 0 0\n1 1 1\n';
  await write('whole.bvh', bvh);
  const motion = await verify('whole.bvh');
  assert.deepEqual({ ok: motion.ok, level: motion.level }, { ok: true, level: 'structural' });
  await write('cut.bvh', bvh.slice(0, bvh.length - 6));
  assert.equal((await verify('cut.bvh')).ok, false);

  await write('empty.glb', '');
  assert.equal((await verify('empty.glb')).reason, 'empty file');
  assert.equal((await verify('missing.glb')).reason, 'missing');
  await write('song.flac', Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(100)]));
  assert.equal((await verify('song.flac')).level, 'header');
  await write('notes.txt', 'x');
  assert.equal((await verify('notes.txt')).level, 'size');
});
