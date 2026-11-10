import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateDrama3 } from '../runtime/drama3-runner.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-drama-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'voices'));
  const executable = path.join(dir, 'engine.exe'),
    checkpoint = path.join(dir, 'model.gguf');
  const launcher = path.join(dir, 'launcher.exe');
  await Promise.all([
    fs.writeFile(executable, 'engine'),
    fs.writeFile(launcher, 'launcher'),
    fs.writeFile(checkpoint, 'model'),
  ]);
  return {
    projectFolder: dir,
    executable,
    launcher,
    checkpoint,
    jobId: 'd987b3cd-f064-4dbe-b214-bf31d1ea4360',
    request: { text: 'A private prompt', seed: 12 },
  };
}
function wav() {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF');
  buffer.writeUInt32LE(36, 4);
  buffer.write('WAVE', 8);
  return buffer;
}
test('Drama 3 launches CUDA without prompt in argv and safely saves its WAV', async (t) => {
  const options = await fixture(t);
  let finalized = false,
    tempInput;
  const output = await generateDrama3({
    ...options,
    onFinalizing: () => {
      finalized = true;
    },
    spawnProcess(_exe, args) {
      assert.equal(args[args.indexOf('--backend') + 1], 'cuda');
      assert.ok(args.includes('fish_drama3.cpu_expert_layers=0'));
      assert.ok(!args.join(' ').includes(options.request.text));
      tempInput = args[args.indexOf('--request-sequence') + 1];
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(async () => {
        const contents = JSON.parse(await fs.readFile(tempInput, 'utf8'));
        assert.equal(contents.requests[0].text, options.request.text);
        await fs.writeFile(path.join(args[args.indexOf('--out-dir') + 1], 'render.wav'), wav());
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(output, `voices/forge-${options.jobId}.wav`);
  assert.ok(finalized);
  assert.deepEqual(await fs.readFile(path.join(options.projectFolder, output)), wav());
  await assert.rejects(fs.access(tempInput));
});
test('Drama 3 reports a CUDA memory failure without creating an asset', async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    generateDrama3({
      ...options,
      spawnProcess() {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stderr.emit('data', Buffer.from('CUDA out of memory'));
          child.emit('close', 1);
        });
        return child;
      },
    }),
    /GPU did not have enough free memory/,
  );
  assert.deepEqual(await fs.readdir(path.join(options.projectFolder, 'voices')), []);
});

test('Drama 3 refuses to start when Windows-available memory is already below its safety floor', async (t) => {
  const options = await fixture(t);
  let launched = false;
  await assert.rejects(
    generateDrama3({
      ...options,
      freeHostMemory: () => 512 * 1024 ** 2,
      spawnProcess() {
        launched = true;
      },
    }),
    /Windows-available memory/,
  );
  assert.equal(launched, false);
  assert.deepEqual(await fs.readdir(path.join(options.projectFolder, 'voices')), []);
});

test('Drama 3 stops its child if Windows-available memory drops during generation', async (t) => {
  const options = await fixture(t);
  let memoryReads = 0,
    tempInput;
  await assert.rejects(
    generateDrama3({
      ...options,
      freeHostMemory: () => (++memoryReads === 1 ? 4 : 1) * 1024 ** 3,
      spawnProcess(_exe, args, spawnOptions) {
        tempInput = args[args.indexOf('--request-sequence') + 1];
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        spawnOptions.signal.addEventListener(
          'abort',
          () => {
            child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
            child.emit('close', null);
          },
          { once: true },
        );
        return child;
      },
    }),
    /Windows-available memory fell below 2 GiB/,
  );
  await assert.rejects(fs.access(tempInput));
  assert.deepEqual(await fs.readdir(path.join(options.projectFolder, 'voices')), []);
});
