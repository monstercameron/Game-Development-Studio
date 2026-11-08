// Builds a throwaway "SeedThree checkout" for tests: a copy of test/fixtures/fake-seedthree in a
// temporary folder, with an empty node_modules/three marker and a real git commit so the adapter
// can read a HEAD commit. Nothing is downloaded and no real SeedThree is needed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-seedthree');
const identity = [
  '-c',
  'user.name=Forge Test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
];

export async function makeFakeSeedThree(prefix = 'forge-fake-seedthree-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.cp(source, directory, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', [...identity, 'add', '-A'], { cwd: directory });
  execFileSync('git', [...identity, 'commit', '-q', '-m', 'fake seedthree'], { cwd: directory });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
  // Untracked, like a real npm install: the dependency marker the readiness check looks for.
  await fs.mkdir(path.join(directory, 'node_modules', 'three'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'node_modules', 'three', 'package.json'),
    '{"name":"three"}',
  );
  return { directory, commit, remove: () => fs.rm(directory, { recursive: true, force: true }) };
}

/** Points the vegetation modules (and the worker processes they fork) at a fake checkout. */
export function useFakeSeedThree(fake, runtimeDirectory) {
  const previous = {
    FORGE_SEEDTHREE_DIR: process.env.FORGE_SEEDTHREE_DIR,
    FORGE_SEEDTHREE_PIN: process.env.FORGE_SEEDTHREE_PIN,
    FORGE_RUNTIME_DIR: process.env.FORGE_RUNTIME_DIR,
  };
  process.env.FORGE_SEEDTHREE_DIR = fake.directory;
  process.env.FORGE_SEEDTHREE_PIN = fake.commit;
  process.env.FORGE_RUNTIME_DIR = runtimeDirectory;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
