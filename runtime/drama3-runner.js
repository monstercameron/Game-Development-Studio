import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileExclusive, verifyOutputFile } from './durable-file.js';
import { normalizeDrama3Request } from './drama3-request.js';
import { createLogger } from './app-log.js';
import { drama3ChildEnvironment } from './drama3-dependencies.js';

const log = createLogger('voices');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DRAMA3_EXECUTABLE = path.join(root, 'engines', 'drama3', 'bin', 'audiocpp_cli.exe');
export const DRAMA3_LAUNCHER = path.join(
  root,
  'engines',
  'drama3',
  'bin',
  'forge-drama3-launcher.exe',
);
export const DRAMA3_CHECKPOINT = path.join(
  root,
  'models',
  'Drama-3-GGUF-Q4',
  'drama-3-backbone-4bit-experts-Q4_K_S.gguf',
);
// Provisional admission for disk-backed experts, with compute fully on CUDA; not a measured peak.
export const DRAMA3_GPU_BUDGET_MIB = 14 * 1024;
export const DRAMA3_HOST_FLOOR_BYTES = 2 * 1024 ** 3;

async function regularFile(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw Error('Drama 3 executable or checkpoint is not a regular, complete file.');
  }
}

/** Check installed files; this does not load the checkpoint. */
export async function drama3Installation({
  executable = DRAMA3_EXECUTABLE,
  launcher = DRAMA3_LAUNCHER,
  checkpoint = DRAMA3_CHECKPOINT,
} = {}) {
  try {
    await Promise.all([regularFile(executable), regularFile(launcher), regularFile(checkpoint)]);
    return { ready: true };
  } catch (error) {
    log.debug('voices.drama3.installation.unavailable', {
      errorClass: error?.name,
      errorCode: error?.code,
    });
    return {
      ready: false,
      message:
        'Drama 3’s native CUDA engine or Q4 checkpoint is not installed. See the model setup guide.',
    };
  }
}

/** Run a single isolated CUDA process, returning only after a verified WAV is safely committed. */
export async function generateDrama3({
  projectFolder,
  jobId,
  request,
  executable = DRAMA3_EXECUTABLE,
  launcher = DRAMA3_LAUNCHER,
  checkpoint = DRAMA3_CHECKPOINT,
  signal,
  spawnProcess = spawn,
  onFinalizing = () => {},
  freeHostMemory = os.freemem,
}) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId || '')) {
    throw Error('Invalid render ID.');
  }
  const settings = normalizeDrama3Request(request);
  const installation = await drama3Installation({ executable, launcher, checkpoint });
  if (!installation.ready) {
    throw Error(installation.message);
  }
  const project = await fs.realpath(projectFolder);
  const voices = path.join(project, 'voices');
  const voicesInfo = await fs.lstat(voices);
  if (
    !voicesInfo.isDirectory() ||
    voicesInfo.isSymbolicLink() ||
    (await fs.realpath(voices)) !== voices
  ) {
    throw Error('Project voice folder is missing or is a link.');
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-drama3-'));
  const input = path.join(temp, 'request.json');
  const outputDirectory = path.join(temp, 'output');
  await fs.mkdir(outputDirectory);
  const wave = path.join(outputDirectory, 'render.wav');
  const memoryAbort = new AbortController();
  let memoryTimer;
  try {
    if (freeHostMemory() < DRAMA3_HOST_FLOOR_BYTES) {
      throw Error('Drama 3 needs at least 2 GiB of Windows-available memory to start.');
    }
    memoryTimer = setInterval(() => {
      if (freeHostMemory() < DRAMA3_HOST_FLOOR_BYTES) {
        memoryAbort.abort();
      }
    }, 1000);
    memoryTimer.unref();
    // Request text stays in a short-lived local file rather than the Windows process command line.
    await fs.writeFile(input, JSON.stringify({ requests: [{ id: 'render', ...settings }] }), {
      flag: 'wx',
    });
    const args = [
      '--task',
      'tts',
      '--family',
      'fish_drama3',
      '--backend',
      'cuda',
      '--mode',
      'offline',
      '--model',
      checkpoint,
      '--request-sequence',
      input,
      '--out-dir',
      outputDirectory,
      '--session-option',
      'fish_drama3.cpu_expert_layers=0',
      '--session-option',
      'fish_drama3.disk_experts=true',
      '--session-option',
      'fish_drama3.expert_cache_size=8',
      '--session-option',
      'fish_drama3.context_length=2048',
      '--session-option',
      'fish_drama3.backbone_prefill_cache_mb=0',
      '--session-option',
      'fish_drama3.tower_prefill_cache_mb=0',
    ];
    const boundedSignal = AbortSignal.any([
      ...(signal ? [signal] : []),
      memoryAbort.signal,
      AbortSignal.timeout(30 * 60 * 1000),
    ]);
    const childEnvironment = await drama3ChildEnvironment();
    await new Promise((resolve, reject) => {
      const child = spawnProcess(launcher, [executable, ...args], {
        env: childEnvironment,
        windowsHide: true,
        signal: boundedSignal,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errorTail = '';
      child.stderr?.on('data', (chunk) => {
        errorTail = (errorTail + chunk.toString()).slice(-3000);
      });
      let processError = null;
      // Abort requests termination asynchronously. Wait for close before cleaning its files so
      // Windows does not see the model worker still holding its request or output open.
      child.once('error', (error) => {
        processError = error;
      });
      child.once('close', (code) => {
        if (processError) {
          reject(
            memoryAbort.signal.aborted
              ? Error(
                  'Drama 3 stopped because Windows-available memory fell below 2 GiB. Free memory and retry.',
                )
              : processError,
          );
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const reason = /out of memory|cuda.*alloc/i.test(errorTail)
          ? 'The GPU did not have enough free memory for Drama 3.'
          : `Drama 3 stopped with exit code ${code ?? 'unknown'}. Check the local engine installation and GPU memory.`;
        reject(Error(reason));
      });
    });
    const checked = await verifyOutputFile(wave, '.wav');
    if (!checked.ok || checked.level !== 'structural') {
      throw Error('Drama 3 did not produce a complete WAV file.');
    }
    const name = `forge-${jobId}.wav`;
    onFinalizing();
    await copyFileExclusive(wave, path.join(voices, name));
    log.info('voices.drama3.asset.saved', { jobId, extension: 'wav' });
    return `voices/${name}`;
  } finally {
    clearInterval(memoryTimer);
    await fs.rm(temp, { recursive: true, force: true }).catch((error) => {
      log.warn('voices.drama3.temp.cleanup.failed', {
        errorClass: error?.name,
        errorCode: error?.code,
      });
    });
  }
}
