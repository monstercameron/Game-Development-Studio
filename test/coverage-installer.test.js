import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const shell = 'powershell.exe';

async function createInstallerFixture(t, model) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-installer-coverage-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.copyFile(path.join(root, 'install.ps1'), path.join(temp, 'install.ps1'));
  await fs.writeFile(
    path.join(temp, 'install-models.json'),
    JSON.stringify({ schemaVersion: 1, models: [model] }),
  );

  const fake = path.join(temp, 'fake-hf.ps1');
  await fs.writeFile(
    fake,
    `param([Parameter(ValueFromRemainingArguments=$true)][string[]]$rest)
$i=[array]::IndexOf($rest,'--local-dir')
if($i -lt 0){exit 3}
$dest=$rest[$i+1]
if($rest[1] -eq 'example/second'){exit 7}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
[IO.File]::WriteAllText((Join-Path $dest 'first.bin'),'first part')
exit 0
`,
  );
  return { temp, fake };
}

function runInstaller(temp, fake, staging, models, extraArgs = []) {
  return spawnSync(
    shell,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(temp, 'install.ps1'),
      '-SkipApp',
      '-Models',
      models,
      '-HfCli',
      fake,
      '-StagingDirectory',
      staging,
      ...extraArgs,
    ],
    { cwd: temp, encoding: 'utf8' },
  );
}

const windowsTest = { skip: process.platform !== 'win32', timeout: 30000 };

test(
  'activation rejects models without a managed destination before staging',
  windowsTest,
  async (t) => {
    const model = {
      id: 'images',
      name: 'Images fixture',
      sources: ['https://huggingface.co/example/model'],
      destination: 'models/images',
      notes: 'Fixture',
      downloads: [
        { repo: 'example/model', revision: 'abc', destination: 'images', files: ['first.bin'] },
      ],
    };
    const { temp, fake } = await createInstallerFixture(t, model);
    const staging = path.join(temp, 'staged');

    const result = runInstaller(temp, fake, staging, 'images', ['-Activate']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be activated automatically/i);
    await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(temp, 'models')), { code: 'ENOENT' });
  },
);

test(
  'activation rejects a traversal destination without writing outside staging',
  windowsTest,
  async (t) => {
    const model = {
      id: 'worldgen',
      name: 'WorldGen fixture',
      sources: ['https://huggingface.co/example/model'],
      destination: 'models/worldgen',
      notes: 'Fixture',
      downloads: [
        { repo: 'example/first', revision: 'a', destination: '../outside', files: ['first.bin'] },
      ],
    };
    const { temp, fake } = await createInstallerFixture(t, model);
    const staging = path.join(temp, 'staged');

    const result = runInstaller(temp, fake, staging, 'worldgen', ['-Activate']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid model destination/i);
    await assert.rejects(fs.stat(path.join(temp, 'outside')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(temp, 'models', 'worldgen')), { code: 'ENOENT' });
  },
);

test(
  'a later download failure preserves staged evidence and activates no model',
  windowsTest,
  async (t) => {
    const model = {
      id: 'worldgen',
      name: 'WorldGen fixture',
      sources: ['https://huggingface.co/example/model'],
      destination: 'models/worldgen',
      notes: 'Fixture',
      downloads: [
        { repo: 'example/first', revision: 'a', destination: 'worldgen', files: ['first.bin'] },
        { repo: 'example/second', revision: 'b', destination: 'worldgen', files: ['second.bin'] },
      ],
    };
    const { temp, fake } = await createInstallerFixture(t, model);
    const staging = path.join(temp, 'staged');

    const result = runInstaller(temp, fake, staging, 'worldgen', ['-Activate']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exited with code 7/i);
    assert.equal(
      await fs.readFile(path.join(staging, 'worldgen', 'first.bin'), 'utf8'),
      'first part',
    );
    await assert.rejects(fs.stat(path.join(staging, 'worldgen', 'second.bin')), {
      code: 'ENOENT',
    });
    await assert.rejects(fs.stat(path.join(temp, 'models', 'worldgen')), { code: 'ENOENT' });
  },
);
