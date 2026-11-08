import { installedTrellisPipelines } from './trellis-pipelines.js';
import { createLogger } from './app-log.js';

const log = createLogger('catalog');

// Service addresses are deliberately fixed to loopback. An open TCP port alone
// is not enough to claim that an engine is ready or its model is loaded.
export const services = [
  {
    id: 'images',
    name: 'Qwen Image 2.1',
    category: 'Images',
    port: 8189,
    endpoint: '/api/status',
    kind: 'qwen',
  },
  {
    id: 'music',
    name: 'YuE2',
    category: 'Music',
    port: 8765,
    endpoint: '/api/v1/health',
    kind: 'yue',
  },
  {
    id: 'sfx',
    name: 'Stable Audio 3',
    category: 'Sound effects',
    port: 7863,
    endpoint: '/api/status',
    kind: 'stable-audio',
  },
  {
    id: 'video',
    name: 'MiniMax H3 Ref2VA',
    category: 'Video',
    port: 8274,
    endpoint: '/api/status',
    kind: 'h3',
  },
  {
    id: 'world',
    name: 'World generation',
    category: 'Worlds',
    port: 8288,
    endpoint: '/api/status',
    kind: 'world',
  },
  {
    id: 'game',
    name: 'Mammoth-1',
    category: 'Game logic',
    port: 8791,
    endpoint: '/health',
    kind: 'mammoth',
  },
  {
    id: '3d-trellis',
    name: 'TRELLIS.2',
    category: '3D models',
    port: 8285,
    endpoint: '/api/status',
    kind: 'trellis',
  },
  {
    id: '3d-hunyuan',
    name: 'Hunyuan3D 2.1',
    category: '3D models',
    port: 8283,
    endpoint: '/api/status',
    kind: 'hunyuan',
  },
  {
    id: 'motion-hy',
    name: 'HY-Motion 1.0',
    category: 'Character motion',
    port: 8286,
    endpoint: '/api/status',
    kind: 'hymotion',
  },
  {
    id: 'motion-bricks',
    name: 'NVIDIA MotionBricks',
    category: 'Character motion',
    port: 8287,
    endpoint: '/api/status',
    kind: 'motionbricks',
  },
  {
    id: 'tts',
    name: 'Qwen3-TTS',
    category: 'Voices',
    port: 8281,
    endpoint: '/api/status',
    kind: 'tts',
  },
  {
    id: 'asr',
    name: 'Nemotron ASR',
    category: 'Speech to text',
    port: 8282,
    endpoint: '/v1/models',
    kind: 'nemotron-asr',
  },
  {
    id: 'segmentation',
    name: 'SAM 3.1',
    category: 'Segmentation',
    port: 8284,
    endpoint: '/api/status',
    kind: 'sam31',
  },
];

const configuredOrigins = {
  images: 'FORGE_IMAGE_URL',
  music: 'FORGE_MUSIC_URL',
  sfx: 'FORGE_SFX_URL',
  video: 'FORGE_VIDEO_URL',
  world: 'FORGE_WORLD_URL',
  tts: 'FORGE_TTS_URL',
  '3d-hunyuan': 'FORGE_HUNYUAN_URL',
  '3d-trellis': 'FORGE_TRELLIS_URL',
  'motion-hy': 'FORGE_HYMOTION_URL',
  'motion-bricks': 'FORGE_MOTIONBRICKS_URL',
  asr: 'FORGE_ASR_URL',
  segmentation: 'FORGE_SAM31_URL',
};
/**
 * Applies the FORGE_*_URL overrides from `env`. A rejected override keeps the service listed with
 * `port: null` and a `configurationError` instead of silently using the default loopback port.
 */
export function configuredServices(env = process.env) {
  return services.map((service) => {
    const key = configuredOrigins[service.id];
    if (!key) {
      return service;
    }
    const value = env[key];
    if (!value) {
      return service;
    }
    try {
      const url = new URL(value);
      const allowed =
        service.id === 'asr' ? ['127.0.0.1', 'localhost', '[::1]'] : ['127.0.0.1', 'localhost'];
      if (
        url.protocol !== 'http:' ||
        !allowed.includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw Error('Invalid origin');
      }
      return { ...service, host: url.hostname, port: Number(url.port || 80) };
    } catch (error) {
      log.warn('catalog.origin.rejected', {
        serviceId: service.id,
        settingKey: key,
        reason: 'invalid_origin',
        errorClass: error?.name,
      });
      return {
        ...service,
        port: null,
        configurationError: 'The configured service URL must be a local HTTP origin.',
      };
    }
  });
}

// Order matters: a load in progress is reported before an earlier error, and an error before a
// loaded model.
function yueModelState(model) {
  if (model.loading) {
    return 'loading';
  }
  if (model.error) {
    return 'error';
  }
  return model.loaded ? 'ready' : 'not loaded';
}

/**
 * Maps one engine's status body to `{ modelLoaded, state, busy }`. Returns null when the body does
 * not carry the engine's identity and expected fields, so an unknown response is never reported
 * as ready. `modelLoaded` and `busy` may be null when the engine does not report them.
 */
export function interpretStatus(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  switch (kind) {
    case 'world':
      if (
        body.engine !== 'forge-world-v1' ||
        typeof body.ready !== 'boolean' ||
        typeof body.busy !== 'boolean'
      ) {
        return null;
      }
      return { modelLoaded: body.busy, state: body.busy ? 'generating' : 'ready', busy: body.busy };
    case 'qwen':
      if (typeof body.status !== 'string' || typeof body.model_downloaded !== 'boolean') {
        return null;
      }
      return {
        modelLoaded: body.status === 'ready' ? true : body.status === 'not loaded' ? false : null,
        state: body.status,
        busy: !!body.busy,
      };
    case 'stable-audio':
      if (typeof body.phase !== 'string' || typeof body.loaded !== 'boolean') {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: body.phase === 'generating' || body.phase === 'loading',
      };
    case 'h3':
      if (typeof body.ready !== 'boolean' || !Array.isArray(body.files)) {
        return null;
      }
      return {
        modelLoaded: null,
        state:
          body.job?.state === 'running'
            ? 'generating'
            : body.ready
              ? 'files ready'
              : 'files missing',
        busy: body.job?.state === 'running',
      };
    case 'mammoth':
      if (body.api !== 'ok' || typeof body.model_ready !== 'boolean') {
        return null;
      }
      return { modelLoaded: body.model_ready, state: body.state, busy: null };
    case 'yue':
      if (body.api_version !== '1' || !body.model || typeof body.model.loaded !== 'boolean') {
        return null;
      }
      return {
        modelLoaded: body.model.loaded,
        state: yueModelState(body.model),
        busy: !!body.model.loading,
      };
    case 'tts':
      if (
        body.engine !== 'forge-qwen3-tts-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: body.phase === 'loading' || body.phase === 'generating',
      };
    case 'hunyuan':
      if (
        body.engine !== 'forge-hunyuan-shape-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: body.phase === 'loading' || body.phase === 'generating',
      };
    case 'trellis':
      if (
        body.engine !== 'forge-trellis2-512-experimental-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: body.phase === 'loading' || body.phase === 'generating',
      };
    case 'sam31':
      if (
        body.engine !== 'forge-sam31-image-experimental-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: ['loading', 'preparing', 'generating'].includes(body.phase),
      };
    case 'hymotion':
      if (
        body.engine !== 'forge-hy-motion-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: ['loading', 'generating'].includes(body.phase),
      };
    case 'motionbricks':
      if (
        body.engine !== 'forge-motionbricks-cuda-experimental-v1' ||
        typeof body.phase !== 'string' ||
        typeof body.loaded !== 'boolean' ||
        typeof body.model_downloaded !== 'boolean'
      ) {
        return null;
      }
      return {
        modelLoaded: body.loaded,
        state: body.phase,
        busy: ['loading', 'generating'].includes(body.phase),
      };
    case 'nemotron-asr': {
      const matching =
        Array.isArray(body.data) &&
        body.data.some(
          (item) =>
            item?.capability === 'transcription' &&
            item?.streaming === true &&
            typeof item.id === 'string' &&
            item.id.includes('nemotron-speech-streaming-en-0.6b'),
        );
      return matching ? { modelLoaded: true, state: 'ready', busy: null } : null;
    }
    default:
      return null;
  }
}

export async function inspectService(service) {
  const state = await inspectServiceStatus(service);
  // TRELLIS.2 pipelines are read from disk so they are known while the worker is stopped.
  return service.kind === 'trellis' ? { ...state, pipelines: installedTrellisPipelines() } : state;
}

async function inspectServiceStatus(service) {
  const { kind, endpoint, ...visible } = service;
  if (!service.port) {
    return { ...visible, status: 'not_configured', modelLoaded: null, canUnload: false };
  }
  const url = `http://${service.host || '127.0.0.1'}:${service.port}`;
  // Each path below stops this timer exactly once (every return or the catch).
  // A status poll probes up to a dozen services, so the result is debug rather than info.
  const probeStartedMs = performance.now();
  const stopProbe = (extra) => {
    log.debug('catalog.service.probed', {
      serviceId: service.id,
      ...extra,
      durationMs: Math.round(performance.now() - probeStartedMs),
    });
  };
  try {
    const response = await fetch(url + endpoint, {
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    if (!response.ok) {
      stopProbe({ httpStatus: response.status, outcome: 'unverified' });
      return { ...visible, url, status: 'unverified', modelLoaded: null, canUnload: false };
    }
    const raw = await response.text();
    if (raw.length > 1_000_000) {
      throw new Error('Status response too large');
    }
    const details = interpretStatus(kind, JSON.parse(raw));
    stopProbe({ httpStatus: response.status, outcome: details ? 'reachable' : 'unverified' });
    return details
      ? { ...visible, url, status: 'reachable', ...details, canUnload: false }
      : { ...visible, url, status: 'unverified', modelLoaded: null, canUnload: false };
  } catch (error) {
    // A refused connection means nothing is listening (stopped or crashed). A timeout means a
    // process accepted the connection but did not answer, which is a hang: the two need
    // different recovery, so the reason is kept.
    const reason =
      error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'refused';
    stopProbe({ outcome: 'unavailable', reason });
    // A refused probe is expected while a service is stopped, so it is debug; a hang is warn.
    if (reason === 'timeout') {
      log.warn('catalog.service.probe.failed', { serviceId: service.id, reason });
    } else {
      log.debug('catalog.service.probe.failed', {
        serviceId: service.id,
        reason,
        errorClass: error?.name,
        errorCode: error?.code,
      });
    }
    return {
      ...visible,
      url,
      status: 'unavailable',
      reason,
      modelLoaded: null,
      canUnload: false,
    };
  }
}
