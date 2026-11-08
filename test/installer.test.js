import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelCatalog } from '../runtime/model-catalog.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'install-models.json'), 'utf8'));
const shell = 'powershell.exe';

test('installer catalog covers each selectable studio model and uses HTTPS sources', () => {
  const entries = manifest.models;
  const ids = entries.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  // Optional entries stage extra checkpoints for features beyond the core studio models.
  // Optional entries stage extra checkpoints; the catalog marks the same entries as optional.
  assert.deepEqual(
    entries
      .filter((item) => item.optional)
      .map((item) => item.id)
      .sort(),
    ['tts-base', 'tts-voicedesign'],
  );
  assert.deepEqual(
    modelCatalog
      .filter((item) => item.optional)
      .map((item) => item.id)
      .sort(),
    ['tts-base', 'tts-voicedesign'],
  );
  assert.deepEqual(
    entries
      .filter((item) => !item.optional)
      .map((item) => item.id)
      .sort(),
    modelCatalog
      .filter((item) => !item.role && !item.optional)
      .map((item) => item.id)
      .sort(),
  );
  for (const model of entries) {
    assert.ok(model.name && model.destination && model.notes);
    assert.ok(model.sources.length);
    for (const url of model.sources) {
      assert.equal(new URL(url).protocol, 'https:');
    }
    for (const part of model.downloads) {
      assert.match(part.repo, /^[\w.-]+\/[\w.-]+$/);
      assert.ok(part.revision);
      assert.doesNotMatch(part.destination, /(^|\/)\.\.(\/|$)/);
      if (part.sha256) {
        assert.match(part.sha256, /^[a-f0-9]{64}$/);
      }
    }
  }
});

test(
  'installer plans without downloading and rejects unknown model IDs',
  { skip: process.platform !== 'win32' },
  async () => {
    const script = path.join(root, 'install.ps1');
    const plan = execFileSync(
      shell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-SkipApp',
        '-Plan',
        '-Models',
        'worldgen,hy-world',
      ],
      { encoding: 'utf8' },
    );
    assert.match(plan, /city96\/FLUX\.1-dev-gguf/);
    assert.match(plan, /tencent\/HY-World-2\.0/);
    assert.match(plan, /no files were changed/i);
    const all = execFileSync(
      shell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-SkipApp',
        '-Plan',
        '-Models',
        'all',
      ],
      { encoding: 'utf8' },
    );
    for (const model of manifest.models) {
      assert.equal(
        all.includes(`${model.id}:`),
        !model.optional,
        `${model.id} in the all-model plan`,
      );
    }
    const bad = spawnSync(
      shell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-SkipApp',
        '-Plan',
        '-Models',
        'not-a-model',
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown model/);
  },
);

test(
  'installer stages and verifies a selected file without touching a live model',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-installer-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.copyFile(path.join(root, 'install.ps1'), path.join(temp, 'install.ps1'));
    const hash = createHash('sha256').update('weights').digest('hex');
    const fixture = {
      schemaVersion: 1,
      models: [
        {
          id: 'demo',
          name: 'Demo',
          sources: ['https://huggingface.co/example/model'],
          destination: 'models/demo',
          notes: 'Fixture',
          downloads: [
            {
              repo: 'example/model',
              revision: 'abc123',
              destination: 'demo',
              files: ['model.bin'],
              sha256File: 'model.bin',
              sha256: hash,
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(temp, 'install-models.json'), JSON.stringify(fixture));
    const fake = path.join(temp, 'fake-hf.ps1');
    await fs.writeFile(
      fake,
      `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)\n$i=[array]::IndexOf($rest,'--local-dir')\nif($i -lt 0){exit 3}\n$dest=$rest[$i+1]\nNew-Item -ItemType Directory -Force -Path $dest | Out-Null\n[IO.File]::WriteAllText((Join-Path $dest 'model.bin'),'weights')\nexit 0\n`,
    );
    const staging = path.join(temp, 'staged'),
      live = path.join(temp, 'models', 'demo');
    await fs.mkdir(live, { recursive: true });
    await fs.writeFile(path.join(live, 'existing.bin'), 'keep');
    const run = () =>
      spawnSync(
        shell,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(temp, 'install.ps1'),
          '-SkipApp',
          '-Models',
          'demo',
          '-HfCli',
          fake,
          '-StagingDirectory',
          staging,
        ],
        { cwd: temp, encoding: 'utf8' },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /not activated/i);
    assert.equal(await fs.readFile(path.join(staging, 'demo', 'model.bin'), 'utf8'), 'weights');
    assert.equal(await fs.readFile(path.join(live, 'existing.bin'), 'utf8'), 'keep');
    const second = run();
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/i);
  },
);

test(
  'installer activates into a new managed folder and refuses to replace it',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-activate-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.copyFile(path.join(root, 'install.ps1'), path.join(temp, 'install.ps1'));
    const folder = 'Qwen3-TTS-12Hz-1.7B-CustomVoice',
      hash = createHash('sha256').update('weights').digest('hex');
    const fixture = {
      schemaVersion: 1,
      models: [
        {
          id: 'tts',
          name: 'TTS fixture',
          sources: ['https://huggingface.co/example/model'],
          destination: `models/${folder}`,
          notes: 'Fixture',
          downloads: [
            {
              repo: 'example/model',
              revision: 'abc',
              destination: folder,
              files: ['model.bin'],
              sha256File: 'model.bin',
              sha256: hash,
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(temp, 'install-models.json'), JSON.stringify(fixture));
    const fake = path.join(temp, 'fake-hf.ps1');
    await fs.writeFile(
      fake,
      `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)\n$i=[array]::IndexOf($rest,'--local-dir')\n$dest=$rest[$i+1]\nNew-Item -ItemType Directory -Force -Path $dest | Out-Null\n[IO.File]::WriteAllText((Join-Path $dest 'model.bin'),'weights')\nexit 0\n`,
    );
    const staging = path.join(temp, 'staged');
    const run = (stage) =>
      spawnSync(
        shell,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(temp, 'install.ps1'),
          '-SkipApp',
          '-Models',
          'tts',
          '-Activate',
          '-HfCli',
          fake,
          '-StagingDirectory',
          stage,
        ],
        { cwd: temp, encoding: 'utf8' },
      );
    const first = run(staging);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      await fs.readFile(path.join(temp, 'models', folder, 'model.bin'), 'utf8'),
      'weights',
    );
    const secondStage = path.join(temp, 'second-stage'),
      second = run(secondStage);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/i);
    await assert.rejects(fs.stat(secondStage), { code: 'ENOENT' });
  },
);

test(
  'checksum failure leaves staged files inactive',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bad-hash-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.copyFile(path.join(root, 'install.ps1'), path.join(temp, 'install.ps1'));
    const folder = 'Qwen3-TTS-12Hz-1.7B-CustomVoice';
    const fixture = {
      schemaVersion: 1,
      models: [
        {
          id: 'tts',
          name: 'TTS fixture',
          sources: ['https://huggingface.co/example/model'],
          destination: `models/${folder}`,
          notes: 'Fixture',
          downloads: [
            {
              repo: 'example/model',
              revision: 'abc',
              destination: folder,
              files: ['model.bin'],
              sha256File: 'model.bin',
              sha256: '0'.repeat(64),
            },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(temp, 'install-models.json'), JSON.stringify(fixture));
    const fake = path.join(temp, 'fake-hf.ps1');
    await fs.writeFile(
      fake,
      `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)\n$i=[array]::IndexOf($rest,'--local-dir')\n$dest=$rest[$i+1]\nNew-Item -ItemType Directory -Force -Path $dest | Out-Null\n[IO.File]::WriteAllText((Join-Path $dest 'model.bin'),'wrong weights')\nexit 0\n`,
    );
    const staging = path.join(temp, 'staged');
    const result = spawnSync(
      shell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(temp, 'install.ps1'),
        '-SkipApp',
        '-Models',
        'tts',
        '-Activate',
        '-HfCli',
        fake,
        '-StagingDirectory',
        staging,
      ],
      { cwd: temp, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 verification failed/i);
    assert.equal(
      await fs.readFile(path.join(staging, folder, 'model.bin'), 'utf8'),
      'wrong weights',
    );
    await assert.rejects(fs.stat(path.join(temp, 'models', folder)), { code: 'ENOENT' });
  },
);

test(
  'multiple source repositories can stage distinct files in one model folder',
  { skip: process.platform !== 'win32', timeout: 30000 },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-multi-part-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    await fs.copyFile(path.join(root, 'install.ps1'), path.join(temp, 'install.ps1'));
    const fixture = {
      schemaVersion: 1,
      models: [
        {
          id: 'demo',
          name: 'Demo',
          sources: ['https://huggingface.co/example/model'],
          destination: 'models/demo',
          notes: 'Fixture',
          downloads: [
            { repo: 'example/first', revision: 'a', destination: 'demo', files: ['first.bin'] },
            { repo: 'example/second', revision: 'b', destination: 'demo', files: ['second.bin'] },
          ],
        },
      ],
    };
    await fs.writeFile(path.join(temp, 'install-models.json'), JSON.stringify(fixture));
    const fake = path.join(temp, 'fake-hf.ps1');
    await fs.writeFile(
      fake,
      `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)\n$i=[array]::IndexOf($rest,'--local-dir')\n$dest=$rest[$i+1]\nNew-Item -ItemType Directory -Force -Path $dest | Out-Null\n[IO.File]::WriteAllText((Join-Path $dest $rest[2]),$rest[1])\nexit 0\n`,
    );
    const staging = path.join(temp, 'staged');
    const result = spawnSync(
      shell,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(temp, 'install.ps1'),
        '-SkipApp',
        '-Models',
        'demo',
        '-HfCli',
        fake,
        '-StagingDirectory',
        staging,
      ],
      { cwd: temp, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await fs.readFile(path.join(staging, 'demo', 'first.bin'), 'utf8'),
      'example/first',
    );
    assert.equal(
      await fs.readFile(path.join(staging, 'demo', 'second.bin'), 'utf8'),
      'example/second',
    );
  },
);
