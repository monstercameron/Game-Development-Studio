import { Worker } from 'node:worker_threads';
import net from 'node:net';
import { configuredServices, inspectService } from './catalog.js';
import { JobQueue, engineUrl } from './jobs.js';
import { QueueMoveError, describeMove } from './queue-order.js';
import { decide } from './game.js';
import { createModelLoader } from './model-load.js';
import { DEFAULT_CHAT_CONTEXT, validateChatContext } from './chat-memory.js';
import { planChatLoad } from './chat-load-plan.js';
import { CHAT_PROJECTOR_MIB, chatProjectorExists } from './chat-vision.js';
import { createAutoMemoryManager } from './auto-memory.js';
import { EngineManager } from './engines.js';
import { EngineClient } from './engine-client.js';
import { stopExternalModel } from './external-model-stop.js';
import { createMusicPreparation } from './music-preparation.js';
import { createServicePreparation, autoStartsService } from './service-preparation.js';
import { createRecoverService } from './recover-service.js';
import { createVideoPreparation } from './video-preparation.js';
import { createImagePreparation } from './image-preparation.js';
import { createSoundLoader, createSoundPreparation } from './sound-preparation.js';
import { createManagedSoundTokenProvider } from './sound-credentials.js';
import { createTtsLoader, createTtsPreparation } from './tts-preparation.js';
import {
  createHunyuanLoader,
  createHunyuanPreparation,
  createHunyuanRenderPreparation,
} from './hunyuan-preparation.js';
import {
  createTrellisLoader,
  createTrellisPreparation,
  createTrellisRenderPreparation,
} from './trellis-preparation.js';
import {
  createSam31Loader,
  createSam31Preparation,
  createSam31RenderPreparation,
} from './sam31-preparation.js';
import {
  createHyMotionLoader,
  createHyMotionPreparation,
  createHyMotionRenderPreparation,
} from './hymotion-preparation.js';
import {
  createMotionBricksLoader,
  createMotionBricksPreparation,
  createMotionBricksRenderPreparation,
} from './motionbricks-preparation.js';
import { createAsrStarter, probeAsr } from './asr-preparation.js';
import {
  ASR_LATENCIES_MS,
  applyAsrLatency,
  readAsrLatency,
  writeAsrLatency,
} from './asr-latency.js';
import { createGameLoader } from './game-preparation.js';
import { transcribeProjectAudio } from './asr-project.js';
import { ModelInventory, managedModels } from './model-inventory.js';
import { buildModelCatalog } from './model-catalog.js';
import { resolveAssetOutputs } from './asset-output.js';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const startedAt = new Date().toISOString();
const engines = process.env.FORGE_ENGINE_BROKER === '1' ? new EngineClient() : new EngineManager();
let gpuThread;
let gpuRequest = 0;
const gpuPending = new Map();
let cachedGpu = null;
let cachedAt = 0;
let gpuInFlight = null;
function startGpuThread() {
  const worker = new Worker(new URL('./gpu-worker.js', import.meta.url));
  gpuThread = worker;
  worker.on('message', ({ id, result }) => {
    const pending = gpuPending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      gpuPending.delete(id);
      pending.resolve(result);
    }
  });
  worker.on('error', (error) => console.error('GPU monitor failed:', error.message));
  worker.on('exit', () => {
    for (const pending of gpuPending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ available: false, devices: [], error: 'GPU monitor restarted.' });
    }
    gpuPending.clear();
    if (gpuThread === worker) {
      gpuThread = null;
    }
  });
}
function hardware(force = false) {
  if (!force && cachedGpu && Date.now() - cachedAt < 3000) {
    return Promise.resolve(cachedGpu);
  }
  if (gpuInFlight) {
    return gpuInFlight;
  }
  if (!gpuThread) {
    startGpuThread();
  }
  gpuInFlight = new Promise((resolve) => {
    const id = ++gpuRequest;
    const timer = setTimeout(() => {
      gpuPending.delete(id);
      resolve({ available: false, devices: [], error: 'GPU monitor timed out.' });
    }, 6500);
    gpuPending.set(id, { resolve, timer });
    try {
      gpuThread.postMessage({ id });
    } catch {
      clearTimeout(timer);
      gpuPending.delete(id);
      resolve({ available: false, devices: [], error: 'GPU monitor unavailable.' });
    }
  })
    .then((result) => {
      if (result.available) {
        cachedGpu = result;
        cachedAt = Date.now();
      }
      return result;
    })
    .finally(() => {
      gpuInFlight = null;
    });
  return gpuInFlight;
}
async function serviceStates() {
  const [states, ownership, activity, gameActivity] = await Promise.all([
    Promise.all(configuredServices().map(inspectService)),
    engines.status(),
    engines.speechActivity().catch(() => null),
    engines.gameActivity().catch(() => null),
  ]);
  return states.map((service) => {
    const managed = !!ownership[service.id]?.managed;
    const busy =
      service.id === 'asr' && activity
        ? activity.active > 0 || activity.closing
        : service.id === 'game' && gameActivity
          ? gameActivity.active > 0 ||
            gameActivity.threads > 0 ||
            gameActivity.loading ||
            gameActivity.closing
          : service.busy;
    const canUnload =
      !!ownership[service.id]?.canUnload &&
      busy !== true &&
      (service.id !== 'asr' || !!activity) &&
      (service.id !== 'game' || !!gameActivity);
    return {
      ...service,
      managed,
      busy,
      canUnload,
      canForceStop: !!ownership[service.id]?.canForceStop,
      // False only when the engine manager says a plain start is allowed; unknown stays true.
      startsOnDemand: ownership[service.id]?.startsOnDemand !== false,
      ...(ownership[service.id]?.ownershipRecovery
        ? { ownershipRecovery: ownership[service.id].ownershipRecovery }
        : {}),
    };
  });
}
// Qwen's server has no atomic idle-and-stop guard. Show it when reachable,
// but never offer it as a safe offload candidate.
async function memoryServiceStates() {
  const [states, ownership, reachable] = await Promise.all([
    serviceStates(),
    engines.status(),
    fetch('http://127.0.0.1:8098/v1/models', {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    })
      .then((r) => r.ok)
      .catch(() => false),
  ]);
  if (reachable) {
    states.push({
      id: 'chat',
      name: 'Qwen chat',
      url: 'http://127.0.0.1:8098',
      status: 'reachable',
      modelLoaded: null,
      managed: !!ownership.chat?.managed,
      busy: null,
      canUnload: false,
    });
  }
  return states;
}
const loadMusic = createModelLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('music'),
});
const soundToken = createManagedSoundTokenProvider({
  ownership: () => engines.status(),
  customEndpoint: !!process.env.FORGE_SFX_URL,
});
const loadSound = createSoundLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('sfx'),
  getToken: soundToken,
});
const loadTts = createTtsLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('tts'),
});
const loadHunyuan = createHunyuanLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('3d'),
});
const loadTrellis = createTrellisLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('trellis'),
});
const loadSam31 = createSam31Loader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('segmentation'),
});
const loadHyMotion = createHyMotionLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('motion'),
});
const loadMotionBricks = createMotionBricksLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  baseUrl: engineUrl('motion-bricks'),
});
const asrBase = process.env.FORGE_ASR_URL || 'http://127.0.0.1:8282';
const asrModel =
  process.env.FORGE_ASR_MODEL ||
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../models/nemotron-speech-streaming-en-0.6b/nemotron-speech-streaming-en-0.6b.q8_0.gguf',
  );
const startAsr = createAsrStarter({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  startEngine: (id) => engines.start(id),
  modelFile: asrModel,
  baseUrl: asrBase,
});
const loadGame = createGameLoader({
  hardware: () => hardware(true),
  services: memoryServiceStates,
  startEngine: (id) => engines.start(id),
  activity: () => engines.gameActivity(),
  requestLoad: () => engines.requestGameLoad(),
});
const prepareMusic =
  process.env.FORGE_AUTO_PREPARE_MUSIC === '0'
    ? null
    : createMusicPreparation({
        startEngine: (id) => engines.start(id),
        loadModel: loadMusic,
        autoStart: !process.env.FORGE_MUSIC_URL || process.env.FORGE_AUTO_START_MUSIC === '1',
      });
const prepareSound =
  process.env.FORGE_AUTO_PREPARE_SOUND === '0'
    ? null
    : createSoundPreparation({
        startEngine: (id) => engines.start(id),
        loadModel: loadSound,
        autoStart: !process.env.FORGE_SFX_URL || process.env.FORGE_AUTO_START_SOUND === '1',
      });
const prepareTts = createTtsPreparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadTts,
  autoStart: !process.env.FORGE_TTS_URL || process.env.FORGE_AUTO_START_TTS === '1',
});
const prepareHunyuan = createHunyuanPreparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadHunyuan,
  autoStart: !process.env.FORGE_HUNYUAN_URL || process.env.FORGE_AUTO_START_HUNYUAN === '1',
});
const prepareHunyuanRender = createHunyuanRenderPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareTrellis = createTrellisPreparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadTrellis,
  services: memoryServiceStates,
  autoStart: !process.env.FORGE_TRELLIS_URL || process.env.FORGE_AUTO_START_TRELLIS === '1',
});
const prepareTrellisRender = createTrellisRenderPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareSam31 = createSam31Preparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadSam31,
  autoStart: !process.env.FORGE_SAM31_URL || process.env.FORGE_AUTO_START_SAM31 === '1',
});
const prepareSam31Render = createSam31RenderPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareHyMotion = createHyMotionPreparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadHyMotion,
  autoStart: !process.env.FORGE_HYMOTION_URL || process.env.FORGE_AUTO_START_HYMOTION === '1',
});
const prepareHyMotionRender = createHyMotionRenderPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareMotionBricks = createMotionBricksPreparation({
  startEngine: (id) => engines.start(id),
  loadModel: loadMotionBricks,
  autoStart:
    !process.env.FORGE_MOTIONBRICKS_URL || process.env.FORGE_AUTO_START_MOTIONBRICKS === '1',
});
const prepareMotionBricksRender = createMotionBricksRenderPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareService = createServicePreparation({
  startEngine: (id) => engines.start(id),
  autoStart: (type) => autoStartsService(type, process.env),
});
const prepareVideo = createVideoPreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const prepareImage = createImagePreparation({
  hardware: () => hardware(true),
  services: memoryServiceStates,
});
const monitoringLoads = new Set();
let chatStartedHere = false;
function chatPortClosed() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: 8098 });
    let finished = false;
    const done = (value) => {
      if (finished) {
        return;
      }
      finished = true;
      s.destroy();
      resolve(value);
    };
    s.once('connect', () => done(false));
    s.once('error', (error) => done(error.code === 'ECONNREFUSED'));
    s.setTimeout(1500, () => done(false));
  });
}
const modelInventory = new ModelInventory();
async function describeModels() {
  // A chat endpoint can respond without proving which model is loaded.
  const [services, chatResponse, ownership] = await Promise.all([
    serviceStates().catch(() => null),
    fetch('http://127.0.0.1:8098/v1/models', {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    })
      .then((response) => response.ok)
      .catch(() => false),
    engines.status().catch(() => null),
  ]);
  const chatService = {
    id: 'chat',
    url: 'http://127.0.0.1:8098',
    status: chatResponse ? 'reachable' : 'unavailable',
    modelLoaded: null,
    managed: ownership?.chat?.managed ?? null,
    contextSize: ownership?.chat?.contextSize ?? null,
    canForceStop: ownership?.chat?.canForceStop ?? false,
  };
  return buildModelCatalog({
    services,
    inventory: modelInventory.snapshot(),
    chatService,
    managedIds: managedModels.map((model) => model.id),
  });
}
const recoverService = createRecoverService({ startEngine: (id) => engines.start(id) });
const autoMemory = createAutoMemoryManager({
  services: serviceStates,
  offload: (id) => engines.offload(id),
});
const queue = new JobQueue({
  prepareMusic,
  prepareSound,
  prepareTts,
  prepareHunyuan,
  prepareHunyuanRender,
  prepareTrellis,
  prepareTrellisRender,
  prepareSam31,
  prepareSam31Render,
  prepareHyMotion,
  prepareHyMotionRender,
  prepareMotionBricks,
  prepareMotionBricksRender,
  prepareService,
  prepareVideo,
  prepareImage,
  recoverService,
  autoMemory,
  refreshHardware: () => hardware(true),
  onQueueLog: (record) => console.log(JSON.stringify({ source: 'queue', ...record })),
  onModelLoadBarrier: (engine) => ensureModelLoadMonitor(engine),
});
async function monitorModelLoad(engine) {
  while (!queue.stopped && queue.modelLoadInProgress && queue.modelLoadEngine === engine) {
    if (engine === 'chat') {
      try {
        const r = await fetch('http://127.0.0.1:8098/health', {
          signal: AbortSignal.timeout(2000),
          redirect: 'error',
        });
        if (r.ok && queue.resumeAfterModelLoad('chat')) {
          return;
        }
      } catch {
        // A failed health probe is inconclusive; verify ownership before clearing.
      }
      // Clear a failed launch only when this worker saw the owned process start,
      // the supervisor confirms it exited, and the listener is closed.
      const state = await engines.status().catch(() => null);
      if (state?.chat?.managed === true) {
        chatStartedHere = true;
      }
      if (
        chatStartedHere &&
        state?.chat?.managed === false &&
        (await chatPortClosed()) &&
        queue.resumeAfterModelLoad('chat')
      ) {
        chatStartedHere = false;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (engine === 'asr') {
      if ((await probeAsr(asrBase)) && queue.resumeAfterModelLoad('asr')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    if (engine === 'game') {
      const state = await engines.gameActivity().catch(() => null);
      if (
        state &&
        !state.loading &&
        (state.loaded || state.load_finished) &&
        queue.resumeAfterModelLoad('game')
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    try {
      const response = await fetch(
        `${engineUrl(engine)}${engine === 'music' ? '/api/v1/health' : '/api/status'}`,
        { signal: AbortSignal.timeout(2500), redirect: 'error' },
      );
      const health = await response.json();
      const finished =
        engine === 'music'
          ? health.api_version === '1' &&
            health.model?.loading !== true &&
            (health.model?.loaded === true || !!health.model?.error)
          : (engine !== 'tts' || health.engine === 'forge-qwen3-tts-v1') &&
            (engine !== '3d-hunyuan' || health.engine === 'forge-hunyuan-shape-v1') &&
            (engine !== '3d-trellis' || health.engine === 'forge-trellis2-512-experimental-v1') &&
            (engine !== 'segmentation' || health.engine === 'forge-sam31-image-experimental-v1') &&
            (engine !== 'motion-hy' || health.engine === 'forge-hy-motion-v1') &&
            (engine !== 'motion-bricks' ||
              health.engine === 'forge-motionbricks-cuda-experimental-v1') &&
            typeof health.loaded === 'boolean' &&
            typeof health.phase === 'string' &&
            ['idle', 'ready', 'error'].includes(health.phase) &&
            (health.loaded === true || health.phase === 'error');
      if (response.ok && finished && queue.resumeAfterModelLoad(engine)) {
        return;
      }
    } catch {
      // Keep the barrier and retry until the worker reports a verified state.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
function ensureModelLoadMonitor(engine) {
  if (
    ![
      'music',
      'sfx',
      'tts',
      'asr',
      '3d-hunyuan',
      '3d-trellis',
      'segmentation',
      'motion-hy',
      'motion-bricks',
      'game',
      'chat',
    ].includes(engine) ||
    monitoringLoads.has(engine) ||
    queue.stopped
  ) {
    return;
  }
  monitoringLoads.add(engine);
  monitorModelLoad(engine)
    .catch((error) => console.error('Model load monitor:', error.message))
    .finally(() => monitoringLoads.delete(engine));
}
async function manualChatLoad({ speculative = true, contextSize = DEFAULT_CHAT_CONTEXT }) {
  if (typeof speculative !== 'boolean') {
    throw Error('Invalid speculative decoding setting.');
  }
  validateChatContext(contextSize);
  const current = await engines.status();
  if (current.chat?.managed) {
    return {
      status: 200,
      body: {
        contextSize: current.chat.contextSize ?? null,
        message:
          'Qwen is already running. Stop and restart it to apply a different context size or speculative decoding setting.',
      },
    };
  }
  queue.suspendForModelLoad('chat');
  let monitoring = false;
  try {
    const plan = await planChatLoad({
      hardware: () => hardware(true),
      services: memoryServiceStates,
      contextSize,
      // The engine passes the projector to the server only when the file exists.
      projectorMiB: chatProjectorExists() ? CHAT_PROJECTOR_MIB : 0,
    });
    if (plan.code !== 'ready') {
      return { status: 409, body: plan };
    }
    if (!queue.markModelLoadRequested('chat')) {
      throw Error('Could not reserve the render queue for model loading.');
    }
    monitoring = true;
    const result = await engines.start('chat', { speculative, contextSize });
    if (!['starting', 'already_managed'].includes(result.status)) {
      monitoring = false;
      throw Error(result.message || `Qwen server could not start: ${result.status}.`);
    }
    chatStartedHere = true;
    const actual =
      result.status === 'already_managed'
        ? ((await engines.status()).chat?.contextSize ?? null)
        : contextSize;
    return {
      status: 200,
      body: {
        contextSize: actual,
        message:
          result.status === 'already_managed'
            ? 'Qwen is already running. Stop and restart it to change its context or speculative decoding.'
            : `Qwen is starting with ${contextSize.toLocaleString()} context tokens and full GPU offload; speculative decoding ${speculative ? 'requested' : 'disabled'}.`,
      },
    };
  } finally {
    if (monitoring) {
      ensureModelLoadMonitor('chat');
    } else {
      queue.resumeAfterModelLoad('chat');
    }
  }
}
async function manualMusicLoad() {
  queue.suspendForModelLoad();
  let monitoring = false;
  try {
    const result = await loadMusic();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('music');
      ensureModelLoadMonitor('music');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad();
    }
  }
}
async function manualSoundLoad({ token = '' }) {
  if (typeof token !== 'string' || token.length > 1000 || /[\r\n]/.test(token)) {
    throw Error('Invalid model access token.');
  }
  queue.suspendForModelLoad('sfx');
  let monitoring = false;
  try {
    const result = await loadSound(token);
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('sfx');
      ensureModelLoadMonitor('sfx');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('sfx');
    }
  }
}
async function manualTtsLoad() {
  queue.suspendForModelLoad('tts');
  let monitoring = false;
  try {
    const result = await loadTts();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('tts');
      ensureModelLoadMonitor('tts');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('tts');
    }
  }
}
async function manualHunyuanLoad() {
  queue.suspendForModelLoad('3d-hunyuan');
  let monitoring = false;
  try {
    const result = await loadHunyuan();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('3d-hunyuan');
      ensureModelLoadMonitor('3d-hunyuan');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('3d-hunyuan');
    }
  }
}
async function manualTrellisLoad() {
  queue.suspendForModelLoad('3d-trellis');
  let monitoring = false;
  try {
    const result = await loadTrellis();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('3d-trellis');
      ensureModelLoadMonitor('3d-trellis');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('3d-trellis');
    }
  }
}
async function manualSam31Load() {
  queue.suspendForModelLoad('segmentation');
  let monitoring = false;
  try {
    const result = await loadSam31();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('segmentation');
      ensureModelLoadMonitor('segmentation');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('segmentation');
    }
  }
}
async function manualHyMotionLoad() {
  queue.suspendForModelLoad('motion-hy');
  let monitoring = false;
  try {
    const result = await loadHyMotion();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('motion-hy');
      ensureModelLoadMonitor('motion-hy');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('motion-hy');
    }
  }
}
async function manualMotionBricksLoad() {
  queue.suspendForModelLoad('motion-bricks');
  let monitoring = false;
  try {
    const result = await loadMotionBricks();
    if (['load_requested', 'loading', 'load_unknown'].includes(result.body?.code)) {
      monitoring = true;
      queue.markModelLoadRequested('motion-bricks');
      ensureModelLoadMonitor('motion-bricks');
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('motion-bricks');
    }
  }
}
async function manualAsrLoad() {
  queue.suspendForModelLoad('asr');
  let monitoring = false;
  try {
    const result = await startAsr(() => {
      if (!queue.markModelLoadRequested('asr')) {
        return false;
      }
      monitoring = true;
      ensureModelLoadMonitor('asr');
      return true;
    });
    if (!result.keepBarrier) {
      monitoring = false;
    }
    return result;
  } finally {
    if (!monitoring) {
      queue.resumeAfterModelLoad('asr');
    }
  }
}
// The latency mode is read when the speech engine starts, so changing it restarts an idle engine.
async function setAsrLatency({ latencyMs }) {
  return applyAsrLatency(latencyMs, {
    write: (value) => writeAsrLatency(value),
    probe: () => probeAsr(asrBase),
    managed: async () => Boolean((await engines.status()).asr?.managed),
    stop: () => handlers.offload({ id: 'asr' }),
    start: () => manualAsrLoad(),
  });
}
async function manualGameLoad() {
  queue.suspendForModelLoad('game');
  let monitoring = false;
  try {
    const result = await loadGame(() => {
      if (!queue.markModelLoadRequested('game')) {
        return false;
      }
      monitoring = true;
      return true;
    });
    if (!result.keepBarrier) {
      monitoring = false;
    }
    return result;
  } finally {
    if (monitoring) {
      ensureModelLoadMonitor('game');
    } else {
      queue.resumeAfterModelLoad('game');
    }
  }
}
async function clearGameLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that Mammoth is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'game') {
    return { cleared: false, message: 'No Mammoth model-load barrier is active.' };
  }
  const state = await engines.gameActivity().catch(() => null);
  if (state?.loading) {
    throw Error('Mammoth reports that it is still loading.');
  }
  if (!state) {
    const ownership = await engines.status();
    const service = (await serviceStates()).find((item) => item.id === 'game');
    if (ownership.game?.managed || service?.status !== 'unavailable') {
      throw Error('Mammoth loading state cannot be verified. Check its process and logs.');
    }
  }
  if (!queue.resumeAfterModelLoad('game')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'Mammoth model-load barrier cleared after confirmation.' };
}
async function clearMusicLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that the YuE2 worker is not loading or waiting to load.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'music') {
    return { cleared: false, message: 'No YuE2 model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('music')}/api/v1/health`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('YuE2 status request failed.');
    }
    const health = await response.json();
    if (
      health.api_version !== '1' ||
      !health.model ||
      typeof health.model.loaded !== 'boolean' ||
      (health.model.loading !== undefined && typeof health.model.loading !== 'boolean')
    ) {
      throw Error('YuE2 status response is incomplete.');
    }
    if (health.model.loading === true) {
      throw Error('YuE2 reports that it is still loading.');
    }
  } catch (error) {
    if (error.message === 'YuE2 reports that it is still loading.') {
      throw error;
    }
    throw Error('YuE2 loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad()) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'Model-load barrier cleared after confirmation.' };
}
async function clearSoundLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that Stable Audio is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'sfx') {
    return { cleared: false, message: 'No Stable Audio model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('sfx')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('Stable Audio status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('Stable Audio status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('Stable Audio reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('Stable Audio status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'Stable Audio reports that it is still loading.') {
      throw error;
    }
    throw Error('Stable Audio loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('sfx')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'Model-load barrier cleared after confirmation.' };
}
async function clearTtsLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that Qwen3-TTS is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'tts') {
    return { cleared: false, message: 'No speech model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('tts')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('Qwen3-TTS status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('Qwen3-TTS status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('Qwen3-TTS reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('Qwen3-TTS status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'Qwen3-TTS reports that it is still loading.') {
      throw error;
    }
    throw Error('Qwen3-TTS loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('tts')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'Model-load barrier cleared after confirmation.' };
}
async function clearAsrLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that Nemotron ASR is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'asr') {
    return { cleared: false, message: 'No ASR model-load barrier is active.' };
  }
  const owned = (await engines.status()).asr?.managed;
  if (owned && !(await probeAsr(asrBase))) {
    throw Error(
      'The Forge-managed ASR service may still be starting. Wait for readiness or check the process.',
    );
  }
  if (!queue.resumeAfterModelLoad('asr')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'ASR model-load barrier cleared after confirmation.' };
}
async function clearHunyuanLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that Hunyuan3D is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== '3d-hunyuan') {
    return { cleared: false, message: 'No Hunyuan model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('3d')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('Hunyuan3D status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('Hunyuan3D status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('Hunyuan3D reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('Hunyuan3D status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'Hunyuan3D reports that it is still loading.') {
      throw error;
    }
    throw Error('Hunyuan3D loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('3d-hunyuan')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'Hunyuan model-load barrier cleared after confirmation.' };
}
async function clearTrellisLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that TRELLIS.2 is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== '3d-trellis') {
    return { cleared: false, message: 'No TRELLIS.2 model-load barrier is active.' };
  }
  let health;
  try {
    const response = await fetch(`${engineUrl('trellis')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (response.ok) {
      health = await response.json();
    }
  } catch {
    // An unavailable status is treated as unknown and cannot clear the barrier.
  }
  if (
    !health ||
    health.engine !== 'forge-trellis2-512-experimental-v1' ||
    !['idle', 'ready', 'error'].includes(health.phase)
  ) {
    throw Error('TRELLIS.2 loading state cannot be verified. Check the worker and logs.');
  }
  if (!queue.resumeAfterModelLoad('3d-trellis')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'TRELLIS.2 model-load barrier cleared after confirmation.' };
}
async function clearSam31LoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that SAM 3.1 is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'segmentation') {
    return { cleared: false, message: 'No SAM model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('segmentation')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('SAM 3.1 status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('SAM 3.1 status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('SAM 3.1 reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('SAM 3.1 status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'SAM 3.1 reports that it is still loading.') {
      throw error;
    }
    throw Error('SAM 3.1 loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('segmentation')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'SAM model-load barrier cleared after confirmation.' };
}
async function clearHyMotionLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that HY-Motion is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'motion-hy') {
    return { cleared: false, message: 'No HY-Motion model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('motion')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('HY-Motion status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('HY-Motion status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('HY-Motion reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('HY-Motion status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'HY-Motion reports that it is still loading.') {
      throw error;
    }
    throw Error('HY-Motion loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('motion-hy')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'HY-Motion model-load barrier cleared after confirmation.' };
}
async function clearMotionBricksLoadBarrier({ confirmNotLoading }) {
  if (confirmNotLoading !== true) {
    throw Error('Confirm that MotionBricks is not loading.');
  }
  if (!queue.lease()) {
    throw Error('Another runtime owns the render queue. Retry shortly.');
  }
  if (!queue.modelLoadInProgress || queue.modelLoadEngine !== 'motion-bricks') {
    return { cleared: false, message: 'No MotionBricks model-load barrier is active.' };
  }
  try {
    const response = await fetch(`${engineUrl('motion-bricks')}/api/status`, {
      signal: AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) {
      throw Error('MotionBricks status request failed.');
    }
    const health = await response.json();
    if (typeof health.phase !== 'string') {
      throw Error('MotionBricks status response is incomplete.');
    }
    if (health.phase === 'loading') {
      throw Error('MotionBricks reports that it is still loading.');
    }
    if (!['idle', 'ready', 'error'].includes(health.phase)) {
      throw Error('MotionBricks status response cannot verify an idle or failed worker.');
    }
  } catch (error) {
    if (error.message === 'MotionBricks reports that it is still loading.') {
      throw error;
    }
    throw Error('MotionBricks loading state cannot be verified. Check its worker and retry.', {
      cause: error,
    });
  }
  if (!queue.resumeAfterModelLoad('motion-bricks')) {
    throw Error('Could not acquire the queue lease. Retry shortly.');
  }
  return { cleared: true, message: 'MotionBricks model-load barrier cleared after confirmation.' };
}
const handlers = {
  health: async () => ({
    state: 'ready',
    pid: process.pid,
    startedAt,
    nodeVersion: process.version,
    gpuMonitor: 'worker thread',
    modelLoadBarrier: queue.modelLoadState,
    modelLoadEngine: queue.modelLoadEngine,
  }),
  services: async () => ({
    services: await serviceStates(),
    observedAt: new Date().toISOString(),
    note: 'Only engines started by this runtime can be stopped by Forge.',
  }),
  modelCatalog: describeModels,
  modelStorage: async () => {
    const ownership = await engines.status();
    return {
      ...modelInventory.snapshot(),
      removals: Object.fromEntries(
        Object.entries(ownership)
          .filter(([, value]) => value.removal)
          .map(([id, value]) => [id, value.removal]),
      ),
    };
  },
  hardware: async () => {
    const gpu = await hardware();
    try {
      const disk = await statfs(process.env.FORGE_PROJECTS_DIR || new URL('../', import.meta.url));
      return {
        ...gpu,
        disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
      };
    } catch {
      return { ...gpu, disk: null };
    }
  },
  jobs: async () => ({ jobs: await resolveAssetOutputs(queue.list()) }),
  job: async ({ id }) => {
    const job = queue.get(id);
    if (!job) {
      throw Error('Job not found.');
    }
    return { job: (await resolveAssetOutputs([job]))[0] };
  },
  enqueue: async (input) => ({ job: queue.enqueue(input) }),
  enqueueChain: async (input) => ({ jobs: queue.enqueueChain(input.steps) }),
  estimate: async (input) => queue.estimate(input),
  cancel: async ({ id }) => ({ job: queue.cancel(id) }),
  clearWaiting: async ({ confirmation }) => queue.clearWaiting(confirmation),
  retry: async ({ id }) => ({ job: queue.retry(id) }),
  // Answers with its own status so a conflict can carry the fresh order back to the client.
  move: async ({ id, ...input }) => {
    try {
      const result = queue.move(id, input);
      return {
        status: 200,
        body: {
          moved: result.moved,
          position: result.to,
          count: result.count,
          order: result.waiting.order,
          ranks: result.waiting.ranks,
          clamped: result.clamped !== null,
          carried: result.carried,
          renumbered: result.renumbered,
          message: describeMove('the render', result),
          job: result.job,
        },
      };
    } catch (error) {
      if (!(error instanceof QueueMoveError)) {
        throw error;
      }
      return {
        status: error.status,
        body: { error: error.message, code: error.code, ...(error.extra || {}) },
      };
    }
  },
  resolve: async ({ id, confirmRemoteNotRunning }) => ({
    job: queue.resolve(id, confirmRemoteNotRunning),
  }),
  decide,
  transcribe: (input) => transcribeProjectAudio(input, { baseUrl: asrBase }),
  loadChat: manualChatLoad,
  loadMusic: manualMusicLoad,
  loadSound: manualSoundLoad,
  loadTts: manualTtsLoad,
  loadHunyuan: manualHunyuanLoad,
  loadTrellis: manualTrellisLoad,
  loadSam31: manualSam31Load,
  loadHyMotion: manualHyMotionLoad,
  loadMotionBricks: manualMotionBricksLoad,
  loadAsr: manualAsrLoad,
  asrLatency: async () => ({ latencyMs: readAsrLatency(), modes: ASR_LATENCIES_MS }),
  setAsrLatency,
  loadGame: manualGameLoad,
  clearMusicLoadBarrier,
  clearSoundLoadBarrier,
  clearTtsLoadBarrier,
  clearAsrLoadBarrier,
  clearGameLoadBarrier,
  clearHunyuanLoadBarrier,
  clearTrellisLoadBarrier,
  clearSam31LoadBarrier,
  clearHyMotionLoadBarrier,
  clearMotionBricksLoadBarrier,
  startEngines: async () => engines.startAll(),
  startEngine: async ({ id }) => {
    if (typeof id !== 'string') {
      throw Error('Unknown engine.');
    }
    return engines.startOne(id);
  },
  offload: async ({ id }) => {
    queue.suspend(id);
    try {
      return await engines.offload(id);
    } finally {
      queue.resume(id);
    }
  },
  closeModel: async ({ id }) => {
    const ownership = await engines.status();
    const service = configuredServices().find((item) => item.id === id);
    if (!service) {
      throw Error('This service does not support idle close.');
    }
    queue.suspend(id);
    try {
      if (ownership[id]?.canUnload) {
        return await engines.offload(id);
      }
      if (ownership[id]?.managed) {
        const health = await inspectService(service);
        if (health.status !== 'reachable' || health.busy !== false) {
          throw Error(
            'The service is busy or its activity cannot be verified. Wait for it to finish, or use Force close.',
          );
        }
        if (!ownership[id]?.canForceStop) {
          throw Error('The service process could not be verified.');
        }
        return await engines.forceStop(id);
      }
      return await stopExternalModel(service);
    } finally {
      queue.resume(id);
    }
  },
  forceStop: async ({ id, confirmation }) => {
    if (confirmation !== 'force-stop-engine') {
      throw Error('Confirm that active work may be interrupted.');
    }
    const ownership = await engines.status();
    const service = configuredServices().find((item) => item.id === id);
    if (ownership[id]?.managed && !ownership[id]?.canForceStop) {
      throw Error('Forge cannot verify ownership of this service.');
    }
    if (!ownership[id]?.managed && !service) {
      throw Error('This external service cannot be identified.');
    }
    const fenced = queue.beginForceStop(id);
    try {
      const result = ownership[id]?.managed
        ? await engines.forceStop(id)
        : await stopExternalModel(service, { force: true });
      // A preparation already in flight must finish before its load barrier can
      // be cleared; otherwise it could re-establish an uncertain load later.
      const deadline = Date.now() + 6000;
      while (queue.polling && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      let barrierCleared = false;
      if (!queue.polling && queue.modelLoadEngine === id) {
        barrierCleared = queue.resumeAfterModelLoad(id);
      }
      return {
        ...result,
        interruptedJobId: fenced.jobId,
        barrierCleared,
        barrierNeedsReview: queue.modelLoadEngine === id,
      };
    } finally {
      queue.resume(id);
    }
  },
  removeModel: async ({ id, confirmation, retry }) => {
    if (confirmation !== 'permanently-delete-model') {
      throw Error('Confirm permanent model-file removal.');
    }
    if (queue.polling) {
      throw Error('Wait for the current queue check, then retry.');
    }
    queue.suspend(id);
    try {
      const result = await engines.removeModel(id, retry === true);
      modelInventory.invalidate();
      return result;
    } finally {
      queue.resume(id);
    }
  },
};
process.on('message', async (message) => {
  if (!message || typeof message.id !== 'number' || !Object.hasOwn(handlers, message.method)) {
    return;
  }
  try {
    const result = await handlers[message.method](message.params || {});
    if (process.connected) {
      process.send({ id: message.id, result });
    }
  } catch (error) {
    if (process.connected) {
      process.send({ id: message.id, error: error.message });
    }
  }
});
process.on('disconnect', () => {
  queue.stop();
  gpuThread?.terminate();
  process.exit(0);
});
process.send?.({ type: 'ready', pid: process.pid });
