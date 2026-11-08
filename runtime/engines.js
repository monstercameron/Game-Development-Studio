import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectService } from './catalog.js';
import { defaultModelsRoot, managedModels } from './model-inventory.js';
import { ModelRemoval } from './model-removal.js';
import { EngineRecovery } from './engine-recovery.js';
import { expectedEngineExecutables, inspectWindowsProcess } from './engine-ownership.js';
import { forceStopWindows } from './force-stop.js';
import { DEFAULT_CHAT_CONTEXT, validateChatContext } from './chat-memory.js';
import { resolveEngineLaunch } from './engine-launch.js';
import { asrLatencyArgs } from './asr-latency.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(os.homedir(), 'Desktop');
const music = path.join(desktop, 'Snapdargon-DJ'),
  images = path.join(desktop, 'Qwen Image Studio'),
  sfx = path.join(desktop, 'Stable Audio Lab'),
  video = path.join(desktop, 'H3 Studio'),
  game = path.join(desktop, 'Mammoth Studio');
export const engineDefinitions = [
  {
    id: 'chat',
    name: 'Qwen3.8 Chat',
    port: 8098,
    endpoint: '/health',
    kind: 'openai',
    cwd: root,
    command: path.join(root, 'engines', 'llama-cuda', 'bin', 'llama-server.exe'),
    args: [
      '--model',
      path.join(root, 'models', 'Qwen3.8-27B-GGUF', 'Qwen3.8-27B-Q4_K_M.gguf'),
      '--alias',
      'qwen3.8-27b',
      '--host',
      '127.0.0.1',
      '--port',
      '8098',
      '--device',
      'CUDA0',
      '--n-gpu-layers',
      'all',
      '--fit',
      'off',
      '--ctx-size',
      '4096',
      '--spec-type',
      'draft-mtp',
      '--spec-draft-n-max',
      '3',
    ],
    onDemand: true,
    noRestart: true,
  },
  {
    id: 'images',
    name: 'Qwen Image Studio',
    port: 8189,
    endpoint: '/api/status',
    kind: 'qwen',
    cwd: images,
    command: path.join(images, '.venv', 'Scripts', 'python.exe'),
    args: [
      '-u',
      path.join(root, 'runtime', 'qwen_worker.py'),
      '--port',
      '8189',
      '--engine-dir',
      images,
    ],
    env: {
      QWEN_MODEL: path.join(root, 'models', 'Qwen-Image-2.1'),
      QWEN_LORA_DIR: path.join(root, 'models', 'Qwen-Image-2.1-LoRA'),
    },
    quiesce: 'qwen-v1',
  },
  {
    id: 'music',
    name: 'YuE2 Studio',
    port: 8765,
    endpoint: '/api/v1/health',
    kind: 'yue',
    cwd: music,
    command: path.join(music, '.runtime', 'python.exe'),
    args: ['-u', '-m', 'vkyue.webapp', '--port', '8765'],
    consoleLauncher: true,
    env: {
      YUE2_BACKEND: 'cuda',
      YUE2_PRELOAD: '0',
      PYTHONUTF8: '1',
      FORGE_MODELS_ROOT: defaultModelsRoot,
    },
  },
  {
    id: 'sfx',
    name: 'Stable Audio Lab',
    port: 7863,
    endpoint: '/api/status',
    kind: 'stable-audio',
    cwd: sfx,
    command: path.join(music, '.runtime', 'python.exe'),
    args: ['-u', path.join(sfx, 'bootstrap.py')],
    consoleLauncher: true,
    env: {
      HF_HUB_CACHE: path.join(defaultModelsRoot, 'Stable-Audio-3', 'hub'),
      FORGE_STABLE_AUDIO_HUB: path.join(defaultModelsRoot, 'Stable-Audio-3', 'hub'),
    },
  },
  {
    id: 'video',
    name: 'H3 Studio',
    port: 8274,
    endpoint: '/api/status',
    kind: 'h3',
    cwd: video,
    command: path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe'),
    args: [
      '-u',
      path.join(root, 'runtime', 'h3_guard.py'),
      '--port',
      '8274',
      '--node',
      path.join(video, 'engine', 'node.exe'),
      '--bootstrap',
      path.join(root, 'runtime', 'h3_bootstrap.cjs'),
      '--engine-dir',
      video,
    ],
    env: {
      FORGE_H3_MODEL_ROOT: path.join(defaultModelsRoot, 'MiniMax-H3', 'h3-studio'),
      FORGE_H3_VAE_ROOT: path.join(defaultModelsRoot, 'MiniMax-H3', 'sol-engine'),
      // Prepared reference clips and frames for the extra video options (runtime/h3_args.cjs).
      FORGE_H3_INPUT_ROOT: path.join(root, '.forge-runtime', 'h3-inputs'),
      FORGE_H3_LORA_DIR: path.join(defaultModelsRoot, 'MiniMax-H3', 'loras'),
    },
  },
  {
    id: 'world',
    name: 'World generation',
    port: 8288,
    endpoint: '/api/status',
    kind: 'world',
    cwd: root,
    command: path.join(desktop, 'HY-World-2.0', '.venv', 'Scripts', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'world_worker.py'), '--port', '8288'],
    env: {
      HF_HUB_CACHE: path.join(defaultModelsRoot, 'hf-cache', 'hub'),
      HUGGINGFACE_HUB_CACHE: path.join(defaultModelsRoot, 'hf-cache', 'hub'),
      FORGE_HYWORLD_WEIGHTS: path.join(defaultModelsRoot, 'HY-World-2.0', 'weights'),
      FORGE_HYWORLD_SKYSEG: path.join(defaultModelsRoot, 'HY-World-2.0', 'skyseg.onnx'),
    },
    onDemand: true,
    noRestart: true,
  },
  {
    id: 'game',
    name: 'Mammoth-1',
    port: 8791,
    endpoint: '/health',
    kind: 'mammoth',
    cwd: game,
    command: path.join(desktop, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'),
    args: [
      '-u',
      path.join(root, 'runtime', 'mammoth_worker.py'),
      '--port',
      '8791',
      '--engine-dir',
      game,
    ],
    env: { FORGE_MAMMOTH_MODELS: path.join(defaultModelsRoot, 'Mammoth-1') },
    quiesce: 'mammoth-v1',
    onDemand: true,
  },
  {
    id: 'tts',
    name: 'Qwen3-TTS',
    port: 8281,
    endpoint: '/api/status',
    kind: 'tts',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'tts-python-embed', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'tts_worker.py'), '--port', '8281'],
    quiesce: 'tts-v1',
  },
  {
    id: '3d-hunyuan',
    name: 'Hunyuan3D shape',
    port: 8283,
    endpoint: '/api/status',
    kind: 'hunyuan',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'hunyuan_worker.py'), '--port', '8283'],
    quiesce: 'hunyuan-v1',
  },
  {
    id: '3d-trellis',
    name: 'TRELLIS.2 512',
    port: 8285,
    endpoint: '/api/status',
    kind: 'trellis',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'trellis2-venv', 'Scripts', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'trellis_worker.py'), '--port', '8285'],
    quiesce: 'trellis-v1',
  },
  {
    id: 'segmentation',
    name: 'SAM 3.1',
    port: 8284,
    endpoint: '/api/status',
    kind: 'sam31',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'sam3-python-embed', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'sam31_worker.py'), '--port', '8284'],
    env: {
      CUDA_HOME:
        process.env.CUDA_HOME ||
        process.env.CUDA_PATH ||
        'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.5',
      HF_HUB_OFFLINE: '1',
    },
    quiesce: 'sam31-v1',
  },
  {
    id: 'motion-hy',
    name: 'HY-Motion 1.0',
    port: 8286,
    endpoint: '/api/status',
    kind: 'hymotion',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'hymotion_worker.py'), '--port', '8286'],
    env: {
      PYTHONPATH: path.join(root, '.forge-runtime', 'hymotion-packages'),
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
    quiesce: 'hymotion-v1',
  },
  {
    id: 'motion-bricks',
    name: 'MotionBricks SOMA',
    port: 8287,
    endpoint: '/api/status',
    kind: 'motionbricks',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe'),
    args: ['-u', path.join(root, 'runtime', 'motionbricks_worker.py'), '--port', '8287'],
    env: { PYTHONPATH: path.join(root, '.forge-runtime', 'hymotion-packages') },
    quiesce: 'motionbricks-v1',
  },
  // The native ASR server loads its model at startup. Only the admission path
  // may start it, and automatic restarts would bypass a fresh memory check.
  {
    id: 'asr',
    name: 'Nemotron ASR',
    port: 8282,
    endpoint: '/v1/models',
    kind: 'nemotron-asr',
    cwd: root,
    command: path.join(root, '.forge-runtime', 'hunyuan3d-venv', 'Scripts', 'python.exe'),
    args: [
      '-u',
      path.join(root, 'runtime', 'asr_guard.py'),
      '--port',
      '8282',
      '--native',
      path.join(root, '.forge-runtime', 'nemo-speech-0.3.0', 'bin', 'nemo-speech.exe'),
      '--model',
      path.join(
        root,
        'models',
        'nemotron-speech-streaming-en-0.6b',
        'nemotron-speech-streaming-en-0.6b.q8_0.gguf',
      ),
      '--cwd',
      root,
    ],
    onDemand: true,
    noRestart: true,
    quiesce: 'asr-guard-v1',
  },
];
export function engineStartArgs(definition, options = {}) {
  if (definition.id === 'chat') {
    const contextSize = validateChatContext(options.contextSize ?? DEFAULT_CHAT_CONTEXT);
    return [
      ...definition.args.map((arg, index) =>
        definition.args[index - 1] === '--spec-type' && options.speculative === false
          ? 'none'
          : definition.args[index - 1] === '--ctx-size'
            ? String(contextSize)
            : arg,
      ),
      '--parallel',
      '1',
    ];
  }
  if (definition.id === 'asr') {
    // The saved streaming latency mode (80, 160, 560 or 1120 ms); the default adds no argument.
    return [...definition.args, ...asrLatencyArgs()];
  }
  return definition.args;
}
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (value) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}
function requireClosedPort(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (error) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.once('connect', () =>
      finish(Error('The model service is still running. Stop it before removing files.')),
    );
    socket.once('error', (error) =>
      finish(
        error.code === 'ECONNREFUSED'
          ? null
          : Error('Could not verify the model service is stopped.'),
      ),
    );
    socket.setTimeout(1500, () => finish(Error('Could not verify the model service is stopped.')));
  });
}
const customEndpoints = {
  tts: ['FORGE_TTS_URL', 'FORGE_TTS_MODEL'],
  '3d-hunyuan': ['FORGE_HUNYUAN_URL', 'FORGE_HUNYUAN_MODEL'],
  '3d-trellis': ['FORGE_TRELLIS_URL'],
  segmentation: ['FORGE_SAM31_URL', 'FORGE_SAM31_MODEL'],
  'motion-hy': ['FORGE_HYMOTION_URL', 'FORGE_HYMOTION_MODEL'],
  'motion-bricks': ['FORGE_MOTIONBRICKS_URL', 'FORGE_MOTIONBRICKS_MODEL'],
  asr: ['FORGE_ASR_URL', 'FORGE_ASR_MODEL'],
};
const recoverableGuards = Object.freeze({
  images: 'qwen-v1',
  game: 'mammoth-v1',
  tts: 'tts-v1',
  '3d-hunyuan': 'hunyuan-v1',
  '3d-trellis': 'trellis-v1',
  segmentation: 'sam31-v1',
  'motion-hy': 'hymotion-v1',
  'motion-bricks': 'motionbricks-v1',
  asr: 'asr-guard-v1',
});
for (const definition of engineDefinitions) {
  if (
    Object.hasOwn(recoverableGuards, definition.id) &&
    recoverableGuards[definition.id] === definition.quiesce
  ) {
    definition.recoverable = true;
  }
}

export class EngineManager {
  constructor({
    definitions = engineDefinitions,
    logDir = process.env.FORGE_RUNTIME_DIR || path.join(root, '.forge-runtime'),
    logger = (message) => console.error(message),
    modelRoot = defaultModelsRoot,
    modelDefinitions = managedModels,
    env = process.env,
  } = {}) {
    this.definitions = definitions;
    this.logDir = logDir;
    this.log = logger;
    this.children = new Map();
    this.starting = new Map();
    this.offloading = new Set();
    this.failures = new Map();
    this.closed = false;
    this.env = env;
    this.recoveryDefinitions = new Map(
      process.platform === 'win32'
        ? definitions
            .filter(
              (item) =>
                item.recoverable === true &&
                Object.hasOwn(recoverableGuards, item.id) &&
                recoverableGuards[item.id] === item.quiesce,
            )
            .map((item) => [item.id, item])
        : [],
    );
    this.recovery = this.recoveryDefinitions.size
      ? new EngineRecovery({ directory: logDir })
      : null;
    this.recoveryStates = new Map(
      [...this.recoveryDefinitions.keys()].map((id) => [id, 'checking']),
    );
    this.recoveryCleanups = new Map();
    this.recoveryReady = this.recovery ? this.initializeRecovery() : Promise.resolve();
    this.removals = new ModelRemoval({
      root: modelRoot,
      stateDir: path.join(logDir, 'model-removals'),
      models: modelDefinitions,
      logger,
      checkStopped: async (id) => {
        const definition = this.definitions.find((item) => item.id === id);
        if (!definition) {
          throw Error('The model service is not configured; removal is unavailable.');
        }
        if (
          this.env.FORGE_ENGINE_CONFIG ||
          (customEndpoints[id] || []).some((name) => this.env[name] || definition.env?.[name])
        ) {
          throw Error(
            'A custom model or service endpoint is configured. Manage its files separately.',
          );
        }
        if (this.children.has(id) || this.starting.has(id)) {
          throw Error('The model service is running or starting. Stop it before removing files.');
        }
        await requireClosedPort(definition.port);
        if (this.children.has(id) || this.starting.has(id)) {
          throw Error('The model service is running or starting. Stop it before removing files.');
        }
      },
    });
  }
  async initializeRecovery() {
    try {
      mkdirSync(this.logDir, { recursive: true });
      // The previous supervisor's lock helper may need a moment to notice its
      // closed stdin after a crash. Never start a duplicate while waiting.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          this.recoveryLock = await this.recovery.journal.acquireLock();
          break;
        } catch (error) {
          if (attempt === 4) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      this.recoveryLock.lost.then((result) => {
        if (result.state === 'lost') {
          for (const id of this.recoveryDefinitions.keys()) {
            this.recoveryStates.set(id, 'unresolved');
            const entry = this.children.get(id);
            if (entry?.recovered) {
              this.children.delete(id);
            }
          }
          this.log('Engine ownership lock was lost; recovery is unavailable.');
        }
      });
      await Promise.all(
        [...this.recoveryDefinitions.values()].map(async (definition) => {
          try {
            await this.reconcileRecovery(definition);
          } catch (error) {
            this.recoveryStates.set(definition.id, 'unresolved');
            this.log(`Engine ${definition.id} ownership recovery failed: ${error.message}`);
          }
        }),
      );
    } catch (error) {
      for (const id of this.recoveryDefinitions.keys()) {
        this.recoveryStates.set(id, 'unresolved');
      }
      this.log(`Engine ownership recovery unavailable: ${error.message}`);
    }
  }
  async reconcileRecovery(definition) {
    const result = await this.recovery.reconcile(definition);
    if (!this.recoveryLock?.held) {
      throw Error('Engine ownership lock was lost during verification.');
    }
    if (result.state === 'recovered') {
      const existing = this.children.get(definition.id);
      if (existing) {
        if (
          existing.controlToken !== result.record.token ||
          existing.nonce !== result.record.nonce
        ) {
          throw Error('A different worker is already managed.');
        }
        existing.record = result.record;
      } else {
        const entry = {
          child: { pid: result.process.pid, exitCode: null, killed: false },
          controlToken: result.record.token,
          nonce: result.record.nonce,
          record: result.record,
          recovered: true,
          stopping: false,
        };
        this.children.set(definition.id, entry);
        entry.forceIdentityPromise = this.captureForceIdentity(entry, definition);
        this.monitorRecovered(entry, definition);
      }
    }
    this.recoveryStates.set(definition.id, result.state);
    return result;
  }
  monitorRecovered(entry, definition) {
    const schedule = () => {
      if (entry.monitorTimer) {
        return;
      }
      entry.monitorTimer = setTimeout(() => {
        entry.monitorTimer = null;
        check();
      }, 10000);
      entry.monitorTimer.unref();
    };
    const check = async () => {
      if (this.closed || !this.recoveryLock?.held || this.children.get(definition.id) !== entry) {
        return;
      }
      if (entry.stopping) {
        if (entry.stopUnknown) {
          await this.reconcileUnknownStop(entry, definition);
          if (this.children.get(definition.id) === entry) {
            schedule();
          }
        }
        return;
      }
      const state = await this.recovery.alive(entry.record);
      if (
        this.closed ||
        !this.recoveryLock?.held ||
        this.children.get(definition.id) !== entry ||
        entry.stopping
      ) {
        return;
      }
      if (state === 'exited_or_reused') {
        try {
          if (!(await this.recovery.clearIfExited(definition, entry.record))) {
            schedule();
            return;
          }
          if (this.children.get(definition.id) === entry) {
            this.children.delete(definition.id);
          }
          this.recoveryStates.set(definition.id, 'none');
          this.log(`Recovered engine ${definition.id} exited.`);
          if (!definition.noRestart) {
            this.start(definition.id).catch((error) =>
              this.log(`Engine ${definition.id} restart failed: ${error.message}`),
            );
          }
        } catch (error) {
          this.recoveryStates.set(definition.id, 'unresolved');
          this.log(`Engine ownership cleanup failed: ${error.message}`);
        }
      } else {
        schedule();
      }
    };
    schedule();
  }
  async reconcileUnknownStop(entry, definition) {
    if (!this.recoveryLock?.held || this.children.get(definition.id) !== entry) {
      return;
    }
    try {
      const state = await this.recovery.alive(entry.record);
      if (!this.recoveryLock?.held || this.children.get(definition.id) !== entry) {
        return;
      }
      if (state === 'exited_or_reused') {
        await this.recovery.journal.clear(definition.id, entry.record.nonce);
        if (this.children.get(definition.id) === entry) {
          this.children.delete(definition.id);
        }
        this.recoveryStates.set(definition.id, 'none');
        return;
      }
      if (state !== 'alive') {
        return;
      }
      const verified = await this.recovery.check(definition, entry.record);
      if (
        !verified.verified ||
        !this.recoveryLock?.held ||
        this.children.get(definition.id) !== entry
      ) {
        return;
      }
      const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/resume`, {
        method: 'POST',
        headers: { 'X-Forge-Engine-Token': entry.controlToken },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const body = await response.json();
      if (
        response.ok &&
        body?.resumed === true &&
        this.recoveryLock?.held &&
        this.children.get(definition.id) === entry
      ) {
        entry.stopUnknown = false;
        entry.stopping = false;
        this.recoveryStates.set(definition.id, 'recovered');
      }
    } catch (error) {
      this.log(`Engine stop reconciliation failed: ${error.message}`);
    }
  }
  async bindRecovery(entry, definition) {
    for (
      let attempt = 0;
      attempt < 5 && !this.closed && this.children.get(definition.id) === entry;
      attempt++
    ) {
      try {
        const result = await this.recovery.reconcile(definition);
        if (!this.recoveryLock?.held) {
          throw Error('Engine ownership lock was lost during verification.');
        }
        if (result.state === 'recovered') {
          entry.record = result.record;
          this.recoveryStates.set(definition.id, 'recovered');
          return true;
        }
      } catch (error) {
        this.log(`Engine ownership binding failed: ${error.message}`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.recoveryStates.set(definition.id, 'unresolved');
    return false;
  }
  owns(id) {
    const entry = this.children.get(id);
    return !!entry && !entry.stopping && entry.child.exitCode === null && !entry.child.killed;
  }
  canOffload(id) {
    const definition = this.definitions.find((item) => item.id === id);
    return (
      (!this.recoveryDefinitions.has(id) || !!this.recoveryLock?.held) &&
      (['music', 'sfx'].includes(id) ||
        (id === 'images' && definition?.quiesce === 'qwen-v1') ||
        (id === 'tts' && definition?.quiesce === 'tts-v1') ||
        (id === '3d-hunyuan' && definition?.quiesce === 'hunyuan-v1') ||
        (id === '3d-trellis' && definition?.quiesce === 'trellis-v1') ||
        (id === 'segmentation' && definition?.quiesce === 'sam31-v1') ||
        (id === 'motion-hy' && definition?.quiesce === 'hymotion-v1') ||
        (id === 'motion-bricks' && definition?.quiesce === 'motionbricks-v1') ||
        (id === 'asr' && definition?.quiesce === 'asr-guard-v1') ||
        (id === 'game' && definition?.quiesce === 'mammoth-v1')) &&
      this.owns(id)
    );
  }
  status() {
    return Object.fromEntries(
      this.definitions.map((item) => [
        item.id,
        {
          managed: this.owns(item.id),
          canUnload: this.canOffload(item.id),
          canForceStop:
            !!this.children.get(item.id)?.forceIdentity &&
            (!this.recoveryDefinitions.has(item.id) || !!this.recoveryLock?.held),
          ...(item.id === 'chat' && this.owns(item.id)
            ? { contextSize: this.children.get(item.id).contextSize }
            : {}),
          removal: this.removals.status(item.id),
          ...(this.recoveryDefinitions.has(item.id)
            ? { ownershipRecovery: this.recoveryStates.get(item.id) }
            : {}),
        },
      ]),
    );
  }
  async captureForceIdentity(entry, definition) {
    if (process.platform !== 'win32') {
      return false;
    }
    try {
      const [info, allowed] = await Promise.all([
        inspectWindowsProcess(entry.child.pid, definition.port),
        expectedEngineExecutables(definition.command),
      ]);
      const norm = (value) => path.win32.normalize(value).toLowerCase();
      if (
        !allowed.some((value) => norm(value) === norm(info.executable)) ||
        (entry.recovered &&
          entry.record &&
          (entry.record.pid !== info.pid || entry.record.creationTicks !== info.creationTicks)) ||
        this.children.get(definition.id) !== entry ||
        entry.child.exitCode !== null
      ) {
        return false;
      }
      entry.forceIdentity = {
        pid: info.pid,
        creationTicks: info.creationTicks,
        executable: info.executable,
      };
      return true;
    } catch {
      return false;
    }
  }
  async forceStop(id) {
    const entry = this.children.get(id),
      definition = this.definitions.find((item) => item.id === id);
    if (!entry || !definition) {
      throw Error('Forge does not own a running process for this service.');
    }
    if (this.offloading.has(id)) {
      throw Error('A stop operation is already in progress.');
    }
    if (this.recoveryDefinitions.has(id) && !this.recoveryLock?.held) {
      throw Error('Engine ownership cannot be verified. Check Diagnostics.');
    }
    this.offloading.add(id);
    try {
      if (entry.forceIdentityPromise) {
        await entry.forceIdentityPromise;
      }
      if (!entry.forceIdentity || this.children.get(id) !== entry) {
        throw Error('The engine process identity is unavailable. Check Diagnostics.');
      }
      entry.stopping = true;
      try {
        const result = await forceStopWindows(entry.forceIdentity);
        if (entry.record && this.recoveryDefinitions.has(id)) {
          if (
            !this.recoveryLock?.held ||
            !(await this.recovery.clearIfExited(definition, entry.record))
          ) {
            throw Error('The process stopped, but ownership cleanup could not be verified.');
          }
          this.recoveryStates.set(id, 'none');
        }
        clearTimeout(entry.monitorTimer);
        if (this.children.get(id) === entry) {
          this.children.delete(id);
        }
        this.log(`Force-stopped Forge-owned engine ${id} (${result.processes} process(es)).`);
        return {
          id,
          stopped: true,
          processes: result.processes,
          message: 'Process tree stopped. Memory may take a moment to become available.',
        };
      } catch (error) {
        entry.forceUncertain = true;
        if (entry.record) {
          this.markUnknownStop(entry, definition);
        }
        throw error;
      }
    } finally {
      this.offloading.delete(id);
    }
  }
  async speechActivity() {
    const entry = this.children.get('asr'),
      definition = this.definitions.find((item) => item.id === 'asr');
    if (!entry || !this.canOffload('asr') || !entry.controlToken) {
      return null;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/status`, {
        headers: { 'X-Forge-Engine-Token': entry.controlToken },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const body = await response.json();
      return response.ok &&
        body.engine === 'forge-asr-guard-v1' &&
        Number.isSafeInteger(body.active) &&
        body.active >= 0 &&
        typeof body.closing === 'boolean'
        ? { active: body.active, closing: body.closing }
        : null;
    } catch {
      return null;
    }
  }
  async gameActivity() {
    const entry = this.children.get('game'),
      definition = this.definitions.find((item) => item.id === 'game');
    if (!entry || !this.canOffload('game') || !entry.controlToken) {
      return null;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/status`, {
        headers: { 'X-Forge-Engine-Token': entry.controlToken },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      const body = await response.json();
      return response.ok &&
        body.engine === 'forge-mammoth-v1' &&
        Number.isSafeInteger(body.active) &&
        body.active >= 0 &&
        Number.isSafeInteger(body.threads) &&
        body.threads >= 0 &&
        ['loading', 'closing', 'loaded', 'model_downloaded', 'load_finished'].every(
          (key) => typeof body[key] === 'boolean',
        )
        ? body
        : null;
    } catch {
      return null;
    }
  }
  async requestGameLoad() {
    const entry = this.children.get('game'),
      definition = this.definitions.find((item) => item.id === 'game');
    if (!entry || !this.canOffload('game') || !entry.controlToken) {
      throw Error('Forge does not own the Mammoth service.');
    }
    const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/load`, {
      method: 'POST',
      headers: { 'X-Forge-Engine-Token': entry.controlToken },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const body = await response.json();
    return { status: response.status, body };
  }
  async start(id, options = {}) {
    if (
      id === 'chat' &&
      options?.speculative !== undefined &&
      typeof options.speculative !== 'boolean'
    ) {
      throw Error('Invalid speculative decoding setting.');
    }
    if (id === 'chat') {
      validateChatContext(options.contextSize ?? DEFAULT_CHAT_CONTEXT);
    }
    await this.removals.ready.catch((error) =>
      this.log(`Model removal recovery unavailable: ${error.message}`),
    );
    if (this.offloading.has(id)) {
      return { id, status: 'stopping', message: 'The engine is stopping.' };
    }
    if (this.recoveryDefinitions.has(id)) {
      await this.recoveryReady;
      if (this.recoveryCleanups.has(id)) {
        await this.recoveryCleanups.get(id);
      }
      const state = this.recoveryStates.get(id);
      if (
        (state === 'unresolved' || (state === 'recovered' && !this.children.has(id))) &&
        this.recoveryLock?.held
      ) {
        try {
          await this.reconcileRecovery(this.recoveryDefinitions.get(id));
        } catch {
          /* The recovery state below remains fenced. */
        }
      }
      if (this.recoveryStates.get(id) === 'unresolved' || !this.recoveryLock?.held) {
        return {
          id,
          status: 'recovery_unresolved',
          message: `A prior ${id} process could not be verified. Check Diagnostics before starting another.`,
        };
      }
    }
    if (this.offloading.has(id)) {
      return { id, status: 'stopping', message: 'The engine is stopping.' };
    }
    if (this.removals.isActive(id)) {
      return { id, status: 'deleting', message: 'Model files are being removed.' };
    }
    if (this.starting.has(id)) {
      return this.starting.get(id);
    }
    const task = this.startOnce(id, options).finally(() => this.starting.delete(id));
    this.starting.set(id, task);
    return task;
  }
  async removeModel(id, retry = false) {
    return retry ? this.removals.retry(id) : this.removals.begin(id);
  }
  async startOnce(id, options = {}) {
    const definition = this.definitions.find((item) => item.id === id);
    if (!definition) {
      throw Error('Unknown engine.');
    }
    if (this.owns(id)) {
      return { id, status: 'already_managed', pid: this.children.get(id).child.pid };
    }
    const observed = await inspectService(definition);
    if (observed.status === 'reachable') {
      return { id, status: 'already_running', managed: false };
    }
    if (await portOpen(definition.port)) {
      return {
        id,
        status: 'port_in_use',
        message: 'The port is occupied by an unverified service.',
      };
    }
    if (!existsSync(definition.command) || !existsSync(definition.cwd)) {
      return { id, status: 'missing', message: 'Engine runtime or directory not found.' };
    }
    mkdirSync(this.logDir, { recursive: true });
    const logFile = path.join(this.logDir, `engine-${id}.log`);
    const fd = openSync(logFile, 'a');
    let child;
    const controlToken =
      (id === 'images' && definition.quiesce === 'qwen-v1') ||
      (id === 'tts' && definition.quiesce === 'tts-v1') ||
      (id === '3d-hunyuan' && definition.quiesce === 'hunyuan-v1') ||
      (id === '3d-trellis' && definition.quiesce === 'trellis-v1') ||
      (id === 'segmentation' && definition.quiesce === 'sam31-v1') ||
      (id === 'motion-hy' && definition.quiesce === 'hymotion-v1') ||
      (id === 'motion-bricks' && definition.quiesce === 'motionbricks-v1') ||
      (id === 'asr' && definition.quiesce === 'asr-guard-v1') ||
      (id === 'game' && definition.quiesce === 'mammoth-v1')
        ? randomBytes(32).toString('hex')
        : null;
    const recoverable = this.recoveryDefinitions.has(id),
      nonce = recoverable ? randomBytes(32).toString('hex') : null;
    let prepared = false;
    try {
      if (recoverable) {
        await this.recovery.prepare(definition, nonce, controlToken);
        prepared = true;
      }
      // Engines are detached (so they survive a studio restart), which gives them no
      // console on Windows; resolveEngineLaunch keeps what they start from opening
      // visible console windows (see engine-launch.js).
      const launch = resolveEngineLaunch(definition, engineStartArgs(definition, options));
      child = spawn(launch.command, launch.args, {
        cwd: definition.cwd,
        env: {
          ...process.env,
          ...definition.env,
          ...launch.env,
          ...(controlToken
            ? {
                [id === 'images' ? 'FORGE_IMAGE_CONTROL_TOKEN' : 'FORGE_ENGINE_CONTROL_TOKEN']:
                  controlToken,
              }
            : {}),
          ...(nonce ? { FORGE_ENGINE_INSTANCE_NONCE: nonce } : {}),
        },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        detached: true,
      });
    } catch (error) {
      if (recoverable) {
        this.recoveryStates.set(id, 'unresolved');
        // A synchronous spawn failure created no process; only that case may
        // clear a confirmed prepared record without probing a listener.
        if (prepared && !child && this.recoveryLock?.held) {
          try {
            await this.recovery.journal.clear(id, nonce);
            this.recoveryStates.set(id, 'none');
          } catch {
            /* Preserve unresolved state when journal cleanup fails. */
          }
        }
      }
      if (recoverable && !prepared) {
        return {
          id,
          status: 'recovery_unresolved',
          message: 'Engine ownership could not be recorded. Check Diagnostics.',
        };
      }
      return { id, status: 'failed', message: error.message };
    } finally {
      closeSync(fd);
    }
    const entry = {
      child,
      controlToken,
      nonce,
      stopping: false,
      startedAt: Date.now(),
      ...(id === 'chat' ? { contextSize: options.contextSize ?? DEFAULT_CHAT_CONTEXT } : {}),
    };
    this.children.set(id, entry);
    child.unref();
    entry.forceIdentityPromise = this.captureForceIdentity(entry, definition);
    child.on('error', (error) => this.log(`Engine ${id} failed: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.children.get(id) === entry) {
        this.children.delete(id);
      }
      if (recoverable && !entry.stopping) {
        if (entry.record && this.recoveryLock?.held) {
          const cleanup = this.recovery
            .clearIfExited(definition, entry.record)
            .then(
              (cleared) => {
                this.recoveryStates.set(id, cleared ? 'none' : 'unresolved');
              },
              (error) => {
                this.recoveryStates.set(id, 'unresolved');
                this.log(`Engine ownership cleanup failed: ${error.message}`);
              },
            )
            .finally(() => {
              this.recoveryCleanups.delete(id);
            });
          this.recoveryCleanups.set(id, cleanup);
        } else {
          this.recoveryStates.set(id, 'unresolved');
        }
      }
      if (entry.stopping || this.closed) {
        return;
      }
      this.log(`Engine ${id} exited (${code ?? signal}).`);
      if (definition.noRestart) {
        return;
      }
      const failures = (Date.now() - entry.startedAt > 30000 ? 0 : this.failures.get(id) || 0) + 1;
      this.failures.set(id, failures);
      if (failures <= 3) {
        const timer = setTimeout(
          () =>
            this.start(id).catch((error) =>
              this.log(`Engine ${id} restart failed: ${error.message}`),
            ),
          Math.min(1000 * 2 ** (failures - 1), 5000),
        );
        timer.unref();
      } else {
        this.log(`Engine ${id} restart limit reached.`);
      }
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      this.children.delete(id);
      if (recoverable) {
        this.recoveryStates.set(id, 'unresolved');
        if (this.recoveryLock?.held) {
          try {
            await this.recovery.journal.clear(id, nonce);
            this.recoveryStates.set(id, 'none');
          } catch {
            /* Preserve unresolved state when journal cleanup fails. */
          }
        }
      }
      return { id, status: 'failed', message: error.message };
    }
    if (recoverable) {
      entry.binding = this.bindRecovery(entry, definition);
    }
    return { id, status: 'starting', pid: child.pid, logFile, modelLoading: 'on demand' };
  }
  async startAll() {
    return {
      services: await Promise.all(
        this.definitions.map(async (definition) => {
          if (definition.onDemand) {
            return {
              id: definition.id,
              status: 'on_demand',
              message: 'Starts after a GPU memory check.',
            };
          }
          try {
            return await this.start(definition.id);
          } catch (error) {
            return { id: definition.id, status: 'failed', message: error.message };
          }
        }),
      ),
    };
  }
  async stopGuardedEngine(entry, definition, id) {
    if (entry.recovered) {
      return this.stopRecoveredEngine(entry, definition, id);
    }
    if (entry.binding && !entry.record) {
      if (!(await entry.binding)) {
        throw Error('Engine ownership is not yet verified. Check Diagnostics before stopping it.');
      }
    }
    if (this.recoveryDefinitions.has(id) && !this.recoveryLock?.held) {
      throw Error('Engine ownership lock is unavailable. Check Diagnostics.');
    }
    entry.stopping = true;
    let done = false,
      timer,
      exitHandler;
    const exited = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 10000);
      timer.unref();
      exitHandler = () => {
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      entry.child.once('exit', exitHandler);
    });
    const cancelWait = () => {
      clearTimeout(timer);
      entry.child.removeListener('exit', exitHandler);
    };
    const resume = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/resume`, {
          method: 'POST',
          headers: { 'X-Forge-Engine-Token': entry.controlToken },
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        return response.ok;
      } catch {
        return false;
      }
    };
    let accepted = false,
      busy = false;
    try {
      const response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/stop`, {
        method: 'POST',
        headers: { 'X-Forge-Engine-Token': entry.controlToken },
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      const body = await response.json();
      accepted = response.ok && body.stopping === true;
      busy = response.status === 409;
    } catch {
      /* The stop outcome remains unverified and is handled below. */
    }
    if (!accepted) {
      if (!busy) {
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
      }
      if (done) {
        return this.finishOwnedStop(entry, definition, id);
      }
      if (busy || (await resume())) {
        entry.stopping = false;
        cancelWait();
      } else {
        this.markUnknownStop(entry, definition);
      }
      throw Error(
        busy
          ? 'The engine has active or queued work.'
          : 'Could not verify the engine stopped safely. Check its status.',
      );
    }
    if (!(await exited)) {
      this.markUnknownStop(entry, definition);
      throw Error('The engine did not exit within 10 seconds. Check its status.');
    }
    return this.finishOwnedStop(entry, definition, id);
  }
  markUnknownStop(entry, definition) {
    if (entry.record) {
      // The launcher may already have exited while the listener is still being
      // checked. Keep a fenced entry so reconciliation can finish safely.
      if (!this.children.has(definition.id)) {
        this.children.set(definition.id, entry);
      }
      entry.stopUnknown = true;
      this.recoveryStates.set(definition.id, 'unresolved');
      this.monitorRecovered(entry, definition);
    }
  }
  async finishOwnedStop(entry, definition, id) {
    if (entry.record) {
      try {
        if (
          !this.recoveryLock?.held ||
          !(await this.recovery.clearIfExited(definition, entry.record))
        ) {
          throw Error('The engine process exit could not be verified. Check Diagnostics.');
        }
        this.recoveryStates.set(id, 'none');
      } catch (error) {
        this.markUnknownStop(entry, definition);
        throw error;
      }
    }
    return { id, stopped: true, message: 'Owned engine stopped. Model files were not removed.' };
  }
  async stopRecoveredEngine(entry, definition, id) {
    if (!this.recoveryLock?.held) {
      throw Error('Engine ownership cannot be verified. Check Diagnostics.');
    }
    const verified = await this.recovery.check(definition, entry.record);
    if (!verified.verified || !this.recoveryLock?.held) {
      throw Error('Engine ownership could not be verified. Check Diagnostics.');
    }
    entry.stopping = true;
    const uncertain = (message) => {
      entry.stopUnknown = true;
      this.recoveryStates.set(id, 'unresolved');
      this.monitorRecovered(entry, definition);
      throw Error(message);
    };
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${definition.port}/api/forge/stop`, {
        method: 'POST',
        headers: { 'X-Forge-Engine-Token': entry.controlToken },
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
    } catch {
      return uncertain('The stop result is unknown. Forge will check the engine before retrying.');
    }
    if (response.status === 409) {
      entry.stopping = false;
      this.monitorRecovered(entry, definition);
      throw Error('The engine has active or queued work.');
    }
    let body;
    try {
      body = await response.json();
    } catch {
      /* Invalid response data remains an unknown stop outcome. */
    }
    if (!response.ok || body?.stopping !== true) {
      return uncertain('The stop result is unknown. Forge will check the engine before retrying.');
    }
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (!this.recoveryLock?.held) {
        return uncertain('Engine ownership lock was lost while stopping.');
      }
      const state = await this.recovery.alive(entry.record);
      if (state === 'exited_or_reused') {
        try {
          await this.recovery.journal.clear(id, entry.record.nonce);
        } catch {
          return uncertain('The engine stopped, but ownership cleanup needs review.');
        }
        clearTimeout(entry.monitorTimer);
        entry.monitorTimer = null;
        if (this.children.get(id) === entry) {
          this.children.delete(id);
        }
        this.recoveryStates.set(id, 'none');
        return {
          id,
          stopped: true,
          message: 'Recovered engine stopped. Model files were not removed.',
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return uncertain('The stop result is unknown. Forge will check the engine before retrying.');
  }
  async offload(id) {
    const entry = this.children.get(id),
      definition = this.definitions.find((item) => item.id === id);
    if (!definition || !this.canOffload(id)) {
      throw Error(
        'Forge cannot safely stop this engine process; manage it in its own application.',
      );
    }
    this.offloading ??= new Set();
    if (this.offloading.has(id)) {
      throw Error('The engine is already stopping.');
    }
    this.offloading.add(id);
    try {
      return await this.offloadOnce(entry, definition, id);
    } finally {
      this.offloading.delete(id);
    }
  }
  async offloadOnce(entry, definition, id) {
    if (
      [
        'images',
        'tts',
        '3d-hunyuan',
        '3d-trellis',
        'segmentation',
        'motion-hy',
        'motion-bricks',
        'asr',
        'game',
      ].includes(id)
    ) {
      return this.stopGuardedEngine(entry, definition, id);
    }
    let safe = false;
    try {
      if (id === 'music') {
        const response = await fetch(`http://127.0.0.1:${definition.port}/api/status`, {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        const status = await response.json();
        safe =
          response.ok &&
          status.model &&
          typeof status.model.loaded === 'boolean' &&
          status.current === null &&
          Array.isArray(status.queue) &&
          status.queue.length === 0;
      } else {
        const status = await inspectService(definition);
        safe = status.status === 'reachable' && status.busy === false;
      }
    } catch {
      /* The idle state could not be verified. */
    }
    if (!safe) {
      throw Error('The engine is busy or its idle state cannot be verified.');
    }
    entry.stopping = true;
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      entry.child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!entry.child.kill()) {
      entry.stopping = false;
      throw Error('Could not stop the owned engine process.');
    }
    if (!(await exited)) {
      throw Error('The engine did not exit within 10 seconds. Check its status.');
    }
    return { id, stopped: true, message: 'Owned engine stopped. Model files were not removed.' };
  }
}
