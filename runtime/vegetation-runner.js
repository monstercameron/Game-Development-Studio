// Host side of vegetation generation: finds out whether the linked SeedThree checkout is usable,
// reads the Forge schema (cached per SeedThree commit), and runs the isolated child that grows a
// plant, with a timeout and a heap cap, writing its output atomically into the project.
//
// Isolation: the child is a separate Node process (vegetation-child.js). It can crash, run out
// of memory or hang without affecting the studio; the host only reads a bounded JSON reply and
// a staged file. Limits that protect the machine: timeout, a V8 heap cap, and the triangle and
// file size caps in vegetation-adapter.js. Native typed arrays are not covered by the heap cap
// (measured worst case with every control at its maximum: about 2.1 GiB resident).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, withLogging } from './app-log.js';
import { fsyncFile } from './durable-file.js';
import { readGlbStats } from './glb-stats.js';
import { SCHEMA_VERSION } from './vegetation-adapter.js';
import { checkoutDirectory, readLinkedRepository } from './vegetation-checkout.js';

const log = createLogger('vegetation');

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const childFile = fileURLToPath(new URL('./vegetation-child.js', import.meta.url));
export const GENERATION_TIMEOUT_MS = 120_000;
export const SCHEMA_TIMEOUT_MS = 60_000;
export const HEAP_LIMIT_MIB = 3072;
// Characters of child stdout kept. Output past this cap is dropped, so a reply beyond it is lost.
const REPLY_LIMIT = 1_000_000;
const JOB_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Raised when SeedThree cannot be used; `code` tells callers which Fetch action applies. */
export class VegetationUnavailableError extends Error {
  constructor(message, code = 'unavailable') {
    super(message);
    this.code = code;
  }
}

function runtimeDirectory(env = process.env) {
  return env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime');
}

function expectedCommit({ root, env }) {
  return readLinkedRepository({ root, env }).commit;
}

/** The commit a checkout's HEAD points at, read from .git without starting git. */
export function readHeadCommitSync(directory) {
  try {
    let gitDir = path.join(directory, '.git');
    const stat = fs.statSync(gitDir);
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!pointer) {
        return null;
      }
      gitDir = path.resolve(directory, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) {
      return head;
    }
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
    if (!ref) {
      return null;
    }
    try {
      return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
    } catch (error) {
      // A loose ref is absent when the ref lives only in packed-refs; that fallback is normal.
      log.debug('vegetation.ref.lookup.failed', { error });
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      return (
        new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(
          packed,
        )?.[1] || null
      );
    }
  } catch (error) {
    log.debug('vegetation.head.read.failed', { error });
    return null;
  }
}

/**
 * A quick, synchronous readiness check used when a job is validated and started. It reads files
 * only; the Vegetation page uses the fuller inspectCheckout() (which can also see local edits).
 */
export function quickCheckoutStatus({ root = appRoot, env = process.env } = {}) {
  const directory = checkoutDirectory({ root, env });
  const entry = path.join(directory, 'src', 'api', 'seedthree.js');
  const fetchHint = 'Use Fetch SeedThree on the Vegetation page, or run install.ps1 -Vegetation.';
  if (!fs.existsSync(entry)) {
    return {
      ready: false,
      code: 'missing',
      directory,
      message: `SeedThree has not been fetched. ${fetchHint}`,
    };
  }
  const commit = readHeadCommitSync(directory);
  const expected = expectedCommit({ root, env });
  if (commit !== expected) {
    return {
      ready: false,
      code: 'outdated',
      directory,
      commit,
      message: `SeedThree is not at the version Forge is tested with. ${fetchHint}`,
    };
  }
  if (!fs.existsSync(path.join(directory, 'node_modules', 'three', 'package.json'))) {
    return {
      ready: false,
      code: 'dependencies_missing',
      directory,
      commit,
      message: `SeedThree's dependencies are not installed. ${fetchHint}`,
    };
  }
  return { ready: true, code: 'ready', directory, commit, message: 'SeedThree is ready.' };
}

function childArguments(heapMiB) {
  return [`--max-old-space-size=${heapMiB}`, childFile];
}

function parseReply(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object') {
        return value;
      }
    } catch (error) {
      // Library output before the final reply line is ignored.
      log.trace('vegetation.reply.line.ignored', { error });
    }
  }
  return null;
}

function cacheFile(commit, env) {
  return path.join(
    runtimeDirectory(env),
    'vegetation',
    `schema-${String(commit).slice(0, 12)}.json`,
  );
}

/**
 * The Forge schema for the current checkout. Built once per SeedThree commit by the isolated
 * child (about half a second) and cached under .forge-runtime. Synchronous because the queue
 * validates requests synchronously.
 */
export function loadSchemaSync({ root = appRoot, env = process.env } = {}) {
  const status = quickCheckoutStatus({ root, env });
  if (!status.ready) {
    throw new VegetationUnavailableError(status.message, status.code);
  }
  const file = cacheFile(status.commit, env);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      cached?.seedthree?.commit === status.commit &&
      cached.schemaVersion === SCHEMA_VERSION &&
      Array.isArray(cached.species)
    ) {
      return cached;
    }
  } catch (error) {
    // Missing or damaged cache: rebuild below.
    log.debug('vegetation.schema.cache.read.failed', { error, reason: 'rebuilding' });
  }
  const stopChild = log.time('vegetation.process.exited', { kind: 'schema' });
  const run = spawnSync(process.execPath, childArguments(HEAP_LIMIT_MIB), {
    input: JSON.stringify({ mode: 'schema', directory: status.directory, commit: status.commit }),
    encoding: 'utf8',
    timeout: SCHEMA_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, FORGE_VEGETATION_DEADLINE_MS: String(SCHEMA_TIMEOUT_MS + 5000) },
  });
  const reply = parseReply(run.stdout || '');
  stopChild({
    pid: run.pid,
    exitCode: run.status,
    signal: run.signal,
    outcome: reply?.ok ? 'completed' : 'failed',
  });
  if (!reply?.ok || !reply.schema) {
    throw new VegetationUnavailableError(
      `SeedThree could not describe its species${reply?.error ? `: ${reply.error}` : '.'}`,
      'schema_failed',
    );
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.${randomUUID()}.part`;
  const schemaText = JSON.stringify(reply.schema);
  fs.writeFileSync(staged, schemaText);
  fs.renameSync(staged, file);
  log.debug('vegetation.schema.cache.written', {
    kind: 'schema-cache',
    bytes: Buffer.byteLength(schemaText),
  });
  return reply.schema;
}

/** Runs the child for one command. Resolves with its parsed reply or rejects with a message. */
export function runChild(
  command,
  { timeoutMs = GENERATION_TIMEOUT_MS, heapMiB = HEAP_LIMIT_MIB, signal } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArguments(heapMiB), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORGE_VEGETATION_DEADLINE_MS: String(timeoutMs + 5000) },
    });
    const stopChild = log.time('vegetation.process.exited', { kind: command.mode, pid: child.pid });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (action, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      action(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, Object.assign(Error('Generation was cancelled.'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (stdout.length < REPLY_LIMIT) {
        stdout += chunk;
      }
    });
    child.stderr.on('data', (chunk) => {
      // Only the first 4000 characters are kept; the error message quotes their last lines.
      if (stderr.length < 4000) {
        stderr += chunk;
      }
    });
    child.once('error', (error) => {
      log.warn('vegetation.process.start.failed', { kind: command.mode, error });
      finish(reject, Error(`Could not start the generator: ${error.message}`));
    });
    child.once('close', (code, killSignal) => {
      const reply = parseReply(stdout);
      stopChild({
        exitCode: code,
        signal: killSignal,
        outcome: timedOut ? 'timed_out' : reply?.ok ? 'completed' : 'failed',
      });
      if (timedOut) {
        finish(
          reject,
          Error(
            `Generation took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
          ),
        );
      } else if (reply?.ok) {
        finish(resolve, reply);
      } else if (reply && reply.ok === false) {
        finish(reject, Error(reply.error || 'The generator reported an error.'));
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);
        const memory = /heap out of memory|allocation failed/i.test(stderr)
          ? ' It ran out of memory.'
          : '';
        finish(
          reject,
          Error(
            `The generator stopped unexpectedly (${killSignal ? `signal ${killSignal}` : `exit code ${code}`}).${memory}${tail ? ` ${tail}` : ''}`,
          ),
        );
      }
    });
    child.stdin.on('error', () => {
      // The child may exit before reading its command; its close event carries the outcome.
    });
    child.stdin.end(JSON.stringify(command));
  });
}

/** Default-design triangle counts per species and budget, measured once per SeedThree commit. */
export async function loadMeasuredBudgets({
  root = appRoot,
  env = process.env,
  timeoutMs = SCHEMA_TIMEOUT_MS,
} = {}) {
  const status = quickCheckoutStatus({ root, env });
  if (!status.ready) {
    throw new VegetationUnavailableError(status.message, status.code);
  }
  const file = path.join(
    runtimeDirectory(env),
    'vegetation',
    `budgets-${status.commit.slice(0, 12)}.json`,
  );
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (cached?.commit === status.commit && cached.measured) {
      return cached.measured;
    }
  } catch (error) {
    // Not measured yet for this commit.
    log.debug('vegetation.budgets.cache.read.failed', { error, reason: 'measuring' });
  }
  const reply = await runChild(
    { mode: 'measure', directory: status.directory, commit: status.commit },
    { timeoutMs },
  );
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const staged = `${file}.${randomUUID()}.part`;
  const budgetsText = JSON.stringify({ commit: status.commit, measured: reply.measured });
  await fsp.writeFile(staged, budgetsText);
  await fsp.rename(staged, file);
  log.debug('vegetation.budgets.cache.written', {
    kind: 'budgets-cache',
    bytes: Buffer.byteLength(budgetsText),
  });
  return reply.measured;
}

async function openAssetFolder(projectFolder, folder = '3d') {
  const realProject = await fsp.realpath(projectFolder);
  const destination = path.join(realProject, folder);
  await fsp.mkdir(destination, { recursive: true });
  const info = await fsp.lstat(destination);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await fsp.realpath(destination)) !== destination
  ) {
    throw Error('The project 3d folder is missing or is a link.');
  }
  return destination;
}

async function replaceFile(staged, final) {
  try {
    const existing = await fsp.lstat(final);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw Error('The output path is not a regular file.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  // Flushed before it gets its final name, so a power loss cannot leave a partial plant.
  await fsyncFile(staged);
  // log-coverage: ignore -- a failed rename throws to the caller; the generation wrapper logs it.
  await fsp.rename(staged, final);
}

/**
 * Generates one plant into the project. Output files are written to hidden staging names inside
 * the project's 3d folder and renamed into place only after the GLB and preset were checked.
 *
 * @returns {Promise<{output: string, presetOutput: string, result: object}>}
 */
async function generateVegetationAssetUnlogged({
  projectFolder,
  jobId,
  request,
  signal,
  timeoutMs = GENERATION_TIMEOUT_MS,
  heapMiB = HEAP_LIMIT_MIB,
  root = appRoot,
  env = process.env,
  onStage = () => {},
}) {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw Error('A valid job ID is required.');
  }
  const status = quickCheckoutStatus({ root, env });
  if (!status.ready) {
    throw new VegetationUnavailableError(status.message, status.code);
  }
  const folder = await openAssetFolder(projectFolder);
  const token = randomUUID();
  const glbName = `forge-${jobId}.glb`;
  const presetName = `forge-${jobId}.preset.json`;
  const glbPart = path.join(folder, `.${glbName}.${token}.part`);
  const presetPart = path.join(folder, `.${presetName}.${token}.part`);
  try {
    onStage('Growing the plant with SeedThree.');
    const started = performance.now();
    const reply = await runChild(
      {
        mode: 'generate',
        directory: status.directory,
        commit: status.commit,
        request,
        glbFile: glbPart,
        presetFile: presetPart,
      },
      { timeoutMs, heapMiB, signal },
    );
    onStage('Checking the exported model.');
    const stats = readGlbStats(glbPart);
    if (!stats || stats.triangles < 1) {
      throw Error('SeedThree produced a file that is not a valid GLB model.');
    }
    const preset = JSON.parse(await fsp.readFile(presetPart, 'utf8'));
    if (preset?.format !== 'seedthree-preset/1' || preset.species !== request.species) {
      throw Error('SeedThree produced an unexpected preset.');
    }
    onStage('Saving to the project.');
    await replaceFile(presetPart, path.join(folder, presetName));
    try {
      await replaceFile(glbPart, path.join(folder, glbName));
    } catch (error) {
      // log-coverage: ignore -- rollback of our own preset file; a failure propagates to the wrapper.
      await fsp.rm(path.join(folder, presetName), { force: true });
      throw error;
    }
    return {
      output: `3d/${glbName}`,
      presetOutput: `3d/${presetName}`,
      result: {
        ...reply.result,
        seedthreeCommit: status.commit,
        glbPrimitiveTriangles: stats.triangles,
        totalMs: Math.round(performance.now() - started),
      },
    };
  } finally {
    // A killed child can still hold its file for a moment on Windows, hence the retries.
    const cleanup = { force: true, maxRetries: 5, retryDelay: 100 };
    // log-coverage: ignore -- removes this run's staging files; a failure propagates to the wrapper.
    await Promise.all([fsp.rm(glbPart, cleanup), fsp.rm(presetPart, cleanup)]);
  }
}

/** Logs vegetation.generation.started, .completed (durationMs) or .failed around one run. */
export const generateVegetationAsset = withLogging(
  generateVegetationAssetUnlogged,
  'vegetation.generation',
);
