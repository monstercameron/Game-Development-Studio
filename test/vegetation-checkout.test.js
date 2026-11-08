import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CheckoutError,
  SPARSE_PATTERNS,
  fetchSeedThree,
  inspectCheckout,
  readLinkedRepository,
} from '../runtime/vegetation-checkout.js';
import { makeFakeSeedThree } from './fixtures/fake-seedthree-setup.js';

const linked = (commit) => ({
  id: 'seedthree',
  name: 'SeedThree',
  repository: 'https://github.com/SkyeShark/SeedThree.git',
  commit,
  license: 'MIT',
});

test('the pinned SeedThree entry in install-models.json is complete and exact', () => {
  const entry = readLinkedRepository();
  assert.match(entry.commit, /^[0-9a-f]{40}$/);
  assert.equal(entry.repository, 'https://github.com/SkyeShark/SeedThree.git');
  assert.equal(entry.license, 'MIT');
  assert.equal(entry.destination, 'external/SeedThree');
});

test('a manifest with a floating ref or a non-GitHub URL is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-'));
  try {
    const write = (value) =>
      fs.writeFile(
        path.join(root, 'install-models.json'),
        JSON.stringify({ linkedRepositories: [value] }),
      );
    await write({ id: 'seedthree', repository: 'https://github.com/a/b.git', commit: 'main' });
    assert.throws(() => readLinkedRepository({ root }), /40-character/);
    await write({
      id: 'seedthree',
      repository: 'http://example.com/b.git',
      commit: 'a'.repeat(40),
    });
    assert.throws(() => readLinkedRepository({ root }), /https:\/\/github.com/);
    await write({ id: 'other' });
    assert.throws(() => readLinkedRepository({ root }), /no linkedRepositories entry/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the checkout is classified as missing, outdated, lacking dependencies or ready', async () => {
  const fake = await makeFakeSeedThree();
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-empty-'));
  try {
    const missing = await inspectCheckout({
      directory: path.join(empty, 'nope'),
      linked: linked(fake.commit),
    });
    assert.equal(missing.state, 'missing');
    assert.equal(missing.action, 'fetch');
    const ready = await inspectCheckout({ directory: fake.directory, linked: linked(fake.commit) });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.action, null);
    assert.equal(ready.commit, fake.commit);
    const outdated = await inspectCheckout({
      directory: fake.directory,
      linked: linked('b'.repeat(40)),
    });
    assert.equal(outdated.state, 'outdated');
    assert.equal(outdated.action, 'update');
    assert.match(outdated.message, /tested with bbbbbbbbbb/);
    await fs.rm(path.join(fake.directory, 'node_modules'), { recursive: true });
    const noDependencies = await inspectCheckout({
      directory: fake.directory,
      linked: linked(fake.commit),
    });
    assert.equal(noDependencies.state, 'dependencies_missing');
    assert.equal(noDependencies.action, 'install');
    await fs.rm(path.join(fake.directory, 'src'), { recursive: true });
    const incomplete = await inspectCheckout({
      directory: fake.directory,
      linked: linked(fake.commit),
    });
    assert.equal(incomplete.state, 'incomplete');
  } finally {
    await fake.remove();
    await fs.rm(empty, { recursive: true, force: true });
  }
});

function recorder(responses = {}) {
  const calls = [];
  const run = async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    for (const [needle, response] of Object.entries(responses)) {
      if (args.join(' ').includes(needle)) {
        return { code: 0, stdout: '', stderr: '', ...response };
      }
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('fetching a fresh checkout pins the commit, uses a sparse partial fetch and no install scripts', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fetch-'));
  const directory = path.join(parent, 'SeedThree');
  const expected = linked('c'.repeat(40));
  try {
    const { calls, run } = recorder();
    // The fake runner creates what the real steps would, so the final inspection can pass.
    const create = async (file, args, options) => {
      const result = await run(file, args, options);
      if (args[0] === 'checkout') {
        await fs.mkdir(path.join(directory, 'src', 'api'), { recursive: true });
        await fs.writeFile(path.join(directory, 'src', 'api', 'seedthree.js'), '');
      }
      if (args.includes('ci')) {
        await fs.mkdir(path.join(directory, 'node_modules', 'three'), { recursive: true });
        await fs.writeFile(path.join(directory, 'node_modules', 'three', 'package.json'), '{}');
      }
      if (args.includes('rev-parse')) {
        return { ...result, stdout: `${expected.commit}\n` };
      }
      return result;
    };
    const steps = [];
    const result = await fetchSeedThree({
      directory,
      linked: expected,
      run: create,
      npm: { file: 'node', prefix: ['npm-cli.js'] },
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.state, 'ready');
    const commands = calls.map((call) => `${call.file} ${call.args.join(' ')}`);
    assert.ok(commands.some((line) => line === 'git init -q'));
    assert.ok(commands.some((line) => line === `git remote add origin ${expected.repository}`));
    assert.ok(
      commands.some(
        (line) => line === `git sparse-checkout set --no-cone ${SPARSE_PATTERNS.join(' ')}`,
      ),
    );
    assert.ok(
      commands.some(
        (line) => line === `git fetch --depth 1 --filter=blob:none origin ${expected.commit}`,
      ),
    );
    assert.ok(commands.some((line) => line === `git checkout --detach -q ${expected.commit}`));
    const install = calls.find((call) => call.args.includes('ci'));
    assert.deepEqual(install.args.slice(1, 5), [
      'ci',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
    ]);
    assert.equal(install.cwd, directory, 'dependencies are installed inside the checkout only');
    assert.ok(steps.length >= 4);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('fetching refuses a foreign folder, a different remote and local changes', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fetch-refuse-'));
  try {
    const foreign = path.join(parent, 'foreign');
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, 'notes.txt'), 'mine');
    await assert.rejects(
      fetchSeedThree({ directory: foreign, linked: linked('d'.repeat(40)), run: recorder().run }),
      (error) => error instanceof CheckoutError && error.code === 'foreign_folder',
    );
    assert.equal(await fs.readFile(path.join(foreign, 'notes.txt'), 'utf8'), 'mine');

    const repo = path.join(parent, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(path.join(repo, 'src', 'api'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'api', 'seedthree.js'), '');
    const wrongRemote = recorder({
      'remote get-url': { stdout: 'https://github.com/someone/else.git\n' },
    });
    await assert.rejects(
      fetchSeedThree({ directory: repo, linked: linked('d'.repeat(40)), run: wrongRemote.run }),
      (error) => error.code === 'wrong_remote',
    );
    const dirty = recorder({
      'remote get-url': { stdout: 'https://github.com/SkyeShark/SeedThree.git\n' },
      'status --porcelain': { stdout: ' M src/core/tree.js\n' },
      'rev-parse HEAD': { stdout: `${'e'.repeat(40)}\n` },
    });
    await assert.rejects(
      fetchSeedThree({ directory: repo, linked: linked('d'.repeat(40)), run: dirty.run }),
      (error) => error.code === 'dirty',
    );
    assert.ok(
      !dirty.calls.some((call) => call.args[0] === 'checkout'),
      'a dirty checkout is never switched',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a failing step reports which step failed', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-fetch-fail-'));
  try {
    const { run } = recorder({ fetch: { code: 128, stderr: 'fatal: unable to access network' } });
    await assert.rejects(
      fetchSeedThree({
        directory: path.join(parent, 'SeedThree'),
        linked: linked('f'.repeat(40)),
        run,
        npm: { file: 'node', prefix: [] },
      }),
      /git fetch failed \(exit 128\).*unable to access/,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
