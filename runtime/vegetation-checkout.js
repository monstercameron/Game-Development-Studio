// The linked SeedThree checkout: where it lives, whether it is the pinned version, and the
// explicit "Fetch" step that creates or updates it.
//
// SeedThree is an external, MIT-licensed project (see docs/VEGETATION.md). Forge never vendors its
// files: external/SeedThree is a git submodule (or, without one, a plain clone made by this
// module) that is pinned to one commit recorded in install-models.json ("linkedRepositories").
// Nothing here runs unless a person asks: the Vegetation page's "Fetch SeedThree" button, the
// installer's -Vegetation switch, or `node runtime/vegetation-checkout.js fetch`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SEEDTHREE_ID = 'seedthree';
export const DEFAULT_RELATIVE_DIRECTORY = 'external/SeedThree';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 4000;

// What is checked out: everything except the texture library and screenshots, which headless
// generation never reads (about 1 MiB instead of about 330 MiB; output is byte-identical).
export const SPARSE_PATTERNS = Object.freeze(['/*', '!/assets/', '!/docs/media/']);

export class CheckoutError extends Error {
  constructor(message, code = 'checkout_failed') {
    super(message);
    this.code = code;
  }
}

/**
 * Reads the pinned SeedThree entry from install-models.json. FORGE_SEEDTHREE_PIN (a full SHA)
 * replaces the commit, for tests and for trying an upgrade before the manifest is updated.
 */
export function readLinkedRepository({
  root = appRoot,
  id = SEEDTHREE_ID,
  env = process.env,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'install-models.json'), 'utf8'));
  } catch (error) {
    throw new CheckoutError(
      `install-models.json could not be read: ${error.message}`,
      'no_manifest',
    );
  }
  const entry = (manifest.linkedRepositories || []).find((item) => item?.id === id);
  if (!entry) {
    throw new CheckoutError(
      'install-models.json has no linkedRepositories entry for SeedThree.',
      'no_entry',
    );
  }
  const commit = env.FORGE_SEEDTHREE_PIN || entry.commit;
  if (!COMMIT_PATTERN.test(String(commit))) {
    throw new CheckoutError(
      'The pinned SeedThree commit must be a full 40-character SHA.',
      'bad_commit',
    );
  }
  if (!REPOSITORY_PATTERN.test(String(entry.repository))) {
    throw new CheckoutError(
      'The SeedThree repository must be an https://github.com/ .git URL.',
      'bad_repository',
    );
  }
  return {
    id: entry.id,
    name: String(entry.name || 'SeedThree'),
    repository: entry.repository,
    commit,
    license: String(entry.license || 'unknown'),
    destination: String(entry.destination || DEFAULT_RELATIVE_DIRECTORY),
    summary: String(entry.summary || ''),
  };
}

/** FORGE_SEEDTHREE_DIR (tests, custom locations) or external/SeedThree under the Forge root. */
export function checkoutDirectory({ root = appRoot, env = process.env } = {}) {
  const override = env.FORGE_SEEDTHREE_DIR;
  return path.resolve(override ? override : path.join(root, DEFAULT_RELATIVE_DIRECTORY));
}

function clip(text) {
  const value = String(text || '');
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}...` : value;
}

/** Runs a program without a shell. Resolves {code, stdout, stderr}; never rejects on exit code. */
export function runProgram(file, args, { cwd, timeoutMs = GIT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: clip(stdout),
          stderr: clip(stderr || (error && typeof error.code !== 'number' ? error.message : '')),
          timedOut: !!error?.killed,
        });
      },
    );
  });
}

async function gitOutput(directory, args, run) {
  const result = await run('git', ['-C', directory, ...args], { timeoutMs: 20000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isEmptyDirectory(directory) {
  try {
    return fs.readdirSync(directory).length === 0;
  } catch {
    return true;
  }
}

/**
 * Describes the checkout. `state` is one of:
 *   missing             nothing at the location
 *   incomplete          a repository without the API file
 *   outdated            checked out at a commit other than the pinned one (or unreadable)
 *   dependencies_missing  the right commit, but node_modules/three is absent
 *   ready               pinned commit with dependencies
 * `action` names what "Fetch SeedThree" will do ('fetch', 'update', 'install') or is null.
 */
export async function inspectCheckout({
  root = appRoot,
  directory = checkoutDirectory({ root }),
  linked = null,
  run = runProgram,
} = {}) {
  const expected = linked || readLinkedRepository({ root });
  const base = {
    id: expected.id,
    name: expected.name,
    repository: expected.repository,
    license: expected.license,
    expectedCommit: expected.commit,
    location: path.relative(root, directory) || '.',
    commit: null,
    isDirty: false,
    state: 'missing',
    action: 'fetch',
  };
  const hasApi = exists(path.join(directory, 'src', 'api', 'seedthree.js'));
  if (isEmptyDirectory(directory)) {
    return { ...base, message: 'SeedThree has not been fetched yet.' };
  }
  if (!hasApi) {
    return {
      ...base,
      state: 'incomplete',
      message: 'The SeedThree folder exists but is incomplete.',
    };
  }
  const commit = await gitOutput(directory, ['rev-parse', 'HEAD'], run);
  const dirtyText = await gitOutput(
    directory,
    ['status', '--porcelain', '--untracked-files=no'],
    run,
  );
  const isDirty = !!dirtyText;
  if (commit !== expected.commit) {
    return {
      ...base,
      commit,
      isDirty,
      state: 'outdated',
      action: 'update',
      message: commit
        ? `SeedThree is at ${commit.slice(0, 10)}; Forge is tested with ${expected.commit.slice(0, 10)}.`
        : 'The checked-out SeedThree version could not be read.',
    };
  }
  if (!exists(path.join(directory, 'node_modules', 'three', 'package.json'))) {
    return {
      ...base,
      commit,
      isDirty,
      state: 'dependencies_missing',
      action: 'install',
      message: 'SeedThree is present but its dependencies are not installed.',
    };
  }
  return { ...base, commit, isDirty, state: 'ready', action: null, message: 'SeedThree is ready.' };
}

/** node + npm-cli.js, because npm.cmd cannot be spawned without a shell on current Node. */
export function npmInvocation({ env = process.env, execPath = process.execPath } = {}) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    env.ProgramFiles &&
      path.join(env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((candidate) => /npm-cli\.js$/i.test(candidate) && exists(candidate));
  if (!cli) {
    throw new CheckoutError(
      'npm could not be located next to Node.js. Install Node.js 24 with npm.',
      'no_npm',
    );
  }
  return { file: execPath, prefix: [cli] };
}

async function must(run, step, file, args, options) {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(' ');
    throw new CheckoutError(
      `${step} failed${result.timedOut ? ' (timed out)' : ` (exit ${result.code})`}.${detail ? ` ${detail}` : ''}`,
      'step_failed',
    );
  }
  return result;
}

/**
 * Creates or updates the checkout at the pinned commit and installs its production
 * dependencies with `npm ci --ignore-scripts`, inside the checkout only. Existing local changes
 * are never discarded: a dirty checkout, a different remote or a foreign folder is refused.
 *
 * @param {object} options
 * @param {(step: string) => void} [options.onStep] progress callback with a plain-language step
 * @param {Function} [options.run] process runner (tests replace it)
 */
export async function fetchSeedThree({
  root = appRoot,
  directory = checkoutDirectory({ root }),
  linked = null,
  run = runProgram,
  onStep = () => {},
  npm = null,
} = {}) {
  const expected = linked || readLinkedRepository({ root });
  const state = await inspectCheckout({ root, directory, linked: expected, run });
  if (state.state === 'ready') {
    return state;
  }
  const hasGitDirectory = fs.existsSync(path.join(directory, '.git'));
  if (!isEmptyDirectory(directory) && !hasGitDirectory) {
    throw new CheckoutError(
      `${state.location} exists but is not a git checkout. Move it away and fetch again.`,
      'foreign_folder',
    );
  }
  if (state.state !== 'dependencies_missing') {
    if (hasGitDirectory) {
      const remote = await gitOutput(directory, ['remote', 'get-url', 'origin'], run);
      if (remote !== expected.repository) {
        throw new CheckoutError(
          `${state.location} has a different origin remote. Fix it or move the folder away.`,
          'wrong_remote',
        );
      }
      if (state.isDirty) {
        throw new CheckoutError(
          `${state.location} has local changes. Commit or discard them yourself, then fetch again.`,
          'dirty',
        );
      }
    } else {
      onStep('Creating the SeedThree checkout');
      fs.mkdirSync(directory, { recursive: true });
      await must(run, 'git init', 'git', ['init', '-q'], { cwd: directory });
      await must(run, 'git remote add', 'git', ['remote', 'add', 'origin', expected.repository], {
        cwd: directory,
      });
    }
    onStep('Downloading the pinned SeedThree commit (source only, about 1 MiB)');
    await must(
      run,
      'git sparse-checkout',
      'git',
      ['sparse-checkout', 'set', '--no-cone', ...SPARSE_PATTERNS],
      {
        cwd: directory,
      },
    );
    await must(
      run,
      'git fetch',
      'git',
      ['fetch', '--depth', '1', '--filter=blob:none', 'origin', expected.commit],
      { cwd: directory },
    );
    onStep('Checking out the pinned commit');
    await must(run, 'git checkout', 'git', ['checkout', '--detach', '-q', expected.commit], {
      cwd: directory,
    });
  }
  onStep('Installing SeedThree dependencies (npm ci --ignore-scripts, production only)');
  const invocation = npm || npmInvocation();
  await must(
    run,
    'npm ci',
    invocation.file,
    [...invocation.prefix, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: directory, timeoutMs: NPM_TIMEOUT_MS },
  );
  const after = await inspectCheckout({ root, directory, linked: expected, run });
  if (after.state !== 'ready') {
    throw new CheckoutError(
      `SeedThree is still not ready after fetching: ${after.message}`,
      'not_ready',
    );
  }
  return after;
}

// `node runtime/vegetation-checkout.js [status|fetch]`, used by install.ps1 -Vegetation.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || 'status';
  try {
    if (command === 'fetch') {
      const result = await fetchSeedThree({ onStep: (step) => console.log(step) });
      console.log(`SeedThree ready at ${result.commit.slice(0, 10)} (${result.location}).`);
    } else if (command === 'status') {
      const result = await inspectCheckout();
      console.log(`SeedThree: ${result.state}. ${result.message}`);
    } else {
      throw new CheckoutError('Use "status" or "fetch".', 'usage');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
