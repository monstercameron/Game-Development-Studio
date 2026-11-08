import { useSearchParams } from 'react-router';
import { updateSearch } from './useNav';
import useDialogFocus from './useDialogFocus';
import { modelCatalog } from '../runtime/model-catalog';
import ForceStopDialog from './ForceStopDialog';
import { useCallback, useEffect, useState } from 'react';
import ModelRemovalDialog from './ModelRemovalDialog';
import MemoryDialog from './MemoryDialog';
import { createLog } from './app-log.js';
import './model-catalog.css';
import {
  ArrowUpRight,
  AudioLines,
  Box,
  Check,
  Clapperboard,
  Copy,
  Cpu,
  FileImage,
  FolderOpen,
  Gamepad2,
  HardDrive,
  LoaderCircle,
  MessageSquare,
  Mic2,
  Music2,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

const log = createLog('model');

const icons = {
  image: FileImage,
  box: Box,
  game: Gamepad2,
  video: Clapperboard,
  music: Music2,
  audio: AudioLines,
  mic: Mic2,
  sparkles: Sparkles,
  cpu: Cpu,
  chat: MessageSquare,
};
// Catalog copy that is misleading in the UI. The shared catalog text should be
// corrected at its source as well.
const purposeOverrides = {
  game: 'Structured decisions for game characters from game state and a choice, score or yes/no question.',
};
const models = modelCatalog
  .filter((model) => !model.role)
  .map((model) => ({
    ...model,
    icon: icons[model.icon] || Cpu,
    purpose: purposeOverrides[model.id] || model.purpose,
  }));
const categories = ['All', ...new Set(models.map((model) => model.category))];
const serviceIds = Object.fromEntries(
  models
    .filter((model) => model.id !== 'chat')
    .map((model) => [model.name, model.serviceId || model.id]),
);
// Lowercase "studio" labels used in the card action: "Open <label>".
const panelLabels = {
  world: 'world studio',
  images: 'image studio',
  '3d': '3D studio',
  motion: 'motion studio',
  video: 'video studio',
  music: 'music studio',
  sfx: 'sound effects',
  voices: 'voice studio',
  game: 'game logic',
  segmentation: 'segmentation',
  chat: 'chat',
};
// Status notes that the catalog records but its card text does not show. Keyed by
// catalog id; sourced from docs/STUDIO_GUIDE.md and docs/MODEL_SOURCES.md.
const modelNotes = {
  worldgen: [
    {
      label: 'Access terms',
      note: 'FLUX terms and a Hugging Face token may be required.',
    },
  ],
  'hy-world': [
    {
      label: 'Partial',
      note: 'Image reconstruction only; larger WorldStereo and HY-Pano pipelines are not connected.',
    },
  ],
  '3d-trellis': [
    {
      label: 'Experimental',
      note: 'Preview; a complete render has not been verified. Needs approved DINOv3 access.',
    },
  ],
  'motion-hy': [
    {
      label: 'Experimental',
      note: 'Text to BVH only; rigging and retargeting are not connected.',
    },
  ],
  'motion-bricks': [
    {
      label: 'Experimental',
      note: 'SOMA BVH transitions only; does not rig or retarget characters.',
    },
  ],
  sfx: [
    {
      label: 'Gated',
      note: 'Requires accepting Hugging Face model terms before loading.',
    },
  ],
  segmentation: [
    {
      label: 'Gated',
      note: 'Requires approved SAM 3.1 access on Hugging Face.',
    },
  ],
};
function serviceLabel(service) {
  if (!service) {
    return 'Checking…';
  }
  if (service.canForceStop && !service.managed) {
    return 'Stop needs review';
  }
  if (service.ownershipRecovery === 'unresolved') {
    return 'Recovery needs review';
  }
  if (service.ownershipRecovery === 'checking') {
    return 'Checking recovery…';
  }
  if (service.status === 'not_configured') {
    return 'Not configured';
  }
  if (service.status === 'unverified') {
    return service.managed ? 'Unverified response' : 'Unverified service';
  }
  if (service.status === 'unavailable') {
    return service.id === 'chat'
      ? 'Not connected'
      : service.managed
        ? 'Not responding'
        : 'Not running';
  }
  if (service.modelLoaded === true) {
    return service.busy ? 'Working' : 'Model loaded';
  }
  if (service.modelLoaded === false) {
    return service.busy ? 'Loading or busy' : 'Service ready · model unloaded';
  }
  return 'Service reachable · model status unknown';
}
// What the single-service start route answered, in plain words.
function startNotice(result, name) {
  if (result.status === 'starting') {
    return `${name} is starting. It can take a minute to respond; its model loads when a render needs it.`;
  }
  if (['already_managed', 'already_running'].includes(result.status)) {
    return `${name} is already running.`;
  }
  return result.message || `${name}: ${String(result.status).replaceAll('_', ' ')}.`;
}
function memory(value) {
  return value === null || value === undefined ? '—' : `${(value / 1024).toFixed(1)} GiB`;
}
function fileSize(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MiB`
      : `${value} B`;
}
// Only the error class is logged: messages thrown by this view can carry server text.
function failureFields(error) {
  return { errorClass: typeof error?.name === 'string' ? error.name : 'Error' };
}
// Numbers from a memory conflict only; the estimate sentence and candidate names stay out.
function memoryConflictFields(modelId, conflict) {
  return {
    modelId,
    reason: conflict.code,
    requiredMiB: conflict.requiredMiB ?? undefined,
    freeMiB: conflict.device?.freeMiB ?? undefined,
    shortfallMiB: conflict.shortfallMiB ?? undefined,
    candidateCount: conflict.candidates?.length,
  };
}
function SoundAccessDialog({ token, setToken, onClose, onLoad, working, error }) {
  const dialog = useDialogFocus({
    onClose: () => {
      if (!working) {
        onClose();
      }
    },
    initialFocus: '#sound-access-token',
  });
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape' && !working) {
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, working]);
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!working) {
          onClose();
        }
      }}
    >
      <section
        ref={dialog}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Load Stable Audio"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">MODEL ACCESS</span>
            <h2>Load Stable Audio</h2>
            <p>
              Stable Audio is a gated model. Accept its terms with your Hugging Face account before
              loading.
            </p>
          </div>
          <button className="icon-btn" aria-label="Close" disabled={working} onClick={onClose}>
            <X size={20} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onLoad();
          }}
        >
          <label className="field-label" htmlFor="sound-access-token">
            Hugging Face read token <span>OPTIONAL IF ALREADY CONFIGURED</span>
          </label>
          <input
            id="sound-access-token"
            type="password"
            autoComplete="off"
            value={token}
            maxLength={1000}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Use configured access or enter a token"
          />
          <p className="helper">
            For a Forge-started worker, leaving this blank uses the key saved in Studio settings, or
            a Hugging Face token from a shared credentials Markdown file on your Desktop when
            available. Forge passes it to the local worker for Hugging Face access; it is not saved
            in Forge, and the worker may keep it in memory until it stops.
          </p>
          <p className="helper">
            <a
              href="https://huggingface.co/stabilityai/stable-audio-3-medium"
              target="_blank"
              rel="noreferrer"
            >
              Review model access and terms
            </a>
          </p>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="project-dialog-actions">
            <button type="button" className="ghost-button" disabled={working} onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={working}>
              {working ? 'Checking memory…' : 'Check memory & load'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default function Models({ onNavigate = () => {} }) {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') || '';
  const category = categories.includes(params.get('category')) ? params.get('category') : 'All';
  const statusFilter = ['all', 'connected', 'loaded', 'installed', 'attention'].includes(
    params.get('status'),
  )
    ? params.get('status')
    : 'all';
  const change = (values, options) => updateSearch(setParams, values, options);
  const setSearch = (value) => change({ q: value || null }, { replace: true });
  const setCategory = (value) => change({ category: value === 'All' ? null : value });
  const setStatusFilter = (value) => change({ status: value === 'all' ? null : value });
  const selected = models.find((model) => model.id === params.get('details')) || null;
  const setSelected = (model) => change({ details: model?.id || null });
  const [notice, setNotice] = useState('');
  const [copiedPath, setCopiedPath] = useState('');
  const [chatService, setChatService] = useState(null);
  const [modelStorage, setModelStorage] = useState(null);
  const [hardware, setHardware] = useState(null);
  const [serviceStates, setServiceStates] = useState([]);
  const [runtimeHealth, setRuntimeHealth] = useState(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [memoryConflict, setMemoryConflict] = useState(null);
  const [memoryError, setMemoryError] = useState('');
  const [loadingMusic, setLoadingMusic] = useState(false);
  const [startingEngines, setStartingEngines] = useState(false);
  const [engineStartResults, setEngineStartResults] = useState([]);
  const soundOpen = params.get('soundAccess') === '1';
  const setSoundOpen = (value) => change({ soundAccess: value ? '1' : null });
  const [soundToken, setSoundToken] = useState('');
  const [soundConflict, setSoundConflict] = useState(null);
  const [soundError, setSoundError] = useState('');
  const [loadingSound, setLoadingSound] = useState(false);
  const [stoppingService, setStoppingService] = useState(null);
  const [startingService, setStartingService] = useState(null);
  const forceModel = models.find((model) => model.id === params.get('force'));
  const forceTarget = forceModel ? { id: forceModel.id, name: forceModel.name } : null;
  const setForceTarget = (value) => change({ force: value?.id || null });
  const [forceBusy, setForceBusy] = useState(false),
    [forceResult, setForceResult] = useState(null),
    [forceError, setForceError] = useState('');
  const [asrConflict, setAsrConflict] = useState(null);
  const [asrError, setAsrError] = useState('');
  const [loadingAsr, setLoadingAsr] = useState(false);
  const refreshStorage = useCallback(async () => {
    try {
      const [storage, services] = await Promise.all([
        fetch('/api/runtime/model-storage'),
        fetch('/api/runtime/services'),
      ]);
      const [storageData, serviceData] = await Promise.all([
        storage.ok ? storage.json() : null,
        services.ok ? services.json() : null,
      ]);
      if (storageData) {
        setModelStorage(storageData);
      }
      if (serviceData) {
        setServiceStates(serviceData.services);
      }
    } catch (error) {
      // Model storage is refreshed again by the polling effect.
      log.debug('model.storage.refresh.failed', failureFields(error));
    }
  }, []);
  useEffect(() => {
    let active = true;
    let isRuntimeUnavailable = false;
    async function refresh() {
      try {
        const [gpu, engines, health, storage] = await Promise.all([
          fetch('/api/runtime/hardware'),
          fetch('/api/runtime/services'),
          fetch('/api/runtime/health'),
          fetch('/api/runtime/model-storage'),
        ]);
        if (!gpu.ok || !engines.ok || !health.ok) {
          throw Error('Runtime unavailable');
        }
        const [hardwareData, serviceData, healthData, storageData] = await Promise.all([
          gpu.json(),
          engines.json(),
          health.json(),
          storage.ok ? storage.json() : null,
        ]);
        if (active) {
          setHardware(hardwareData);
          setServiceStates(serviceData.services);
          setRuntimeHealth(healthData);
          setModelStorage(storageData);
          setRuntimeError('');
          if (isRuntimeUnavailable) {
            isRuntimeUnavailable = false;
            log.info('model.runtime.poll.recovered');
          }
        }
      } catch (error) {
        if (active) {
          setRuntimeError('Runtime is starting or unavailable. Retrying…');
          // Logged once per outage, not on every retry.
          if (!isRuntimeUnavailable) {
            isRuntimeUnavailable = true;
            log.warn('model.runtime.poll.failed', failureFields(error));
          }
        }
      }
    }
    log.debug('model.runtime.poll.started', { intervalMs: 10000 });
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
      log.debug('model.runtime.poll.stopped');
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let lastChatStatus;
    // The probe runs every 15 s, so only a change of status is logged.
    function noteChatStatus(status, fields) {
      if (status !== lastChatStatus) {
        log.info('model.chat.status.changed', { from: lastChatStatus, to: status, ...fields });
        lastChatStatus = status;
      }
    }
    async function checkChat() {
      try {
        // log-coverage: ignore -- the http logger records failed calls; status changes are logged below
        const response = await fetch('/api/chat/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'chat' },
          body: JSON.stringify({ provider: 'compatible', endpoint: 'http://127.0.0.1:8098/v1' }),
        });
        if (alive) {
          setChatService({
            id: 'chat',
            status: response.ok ? 'reachable' : 'unavailable',
            modelLoaded: null,
            url: 'http://127.0.0.1:8098',
          });
          noteChatStatus(response.ok ? 'reachable' : 'unavailable', {
            httpStatus: response.status,
          });
        }
      } catch (error) {
        // Expected whenever the chat service is not running, so debug.
        log.debug('model.chat.probe.failed', failureFields(error));
        if (alive) {
          setChatService({
            id: 'chat',
            status: 'unavailable',
            modelLoaded: null,
            url: 'http://127.0.0.1:8098',
          });
          noteChatStatus('unavailable', failureFields(error));
        }
      }
    }
    log.debug('model.chat.poll.started', { intervalMs: 15000 });
    checkChat();
    const timer = setInterval(checkChat, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
      log.debug('model.chat.poll.stopped');
    };
  }, []);
  useEffect(() => {
    if (modelStorage?.state !== 'scanning') {
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/runtime/model-storage');
        if (response.ok && active) {
          setModelStorage(await response.json());
        }
      } catch (error) {
        // Storage refresh is best-effort while the scan is in progress.
        log.debug('model.storage.scan.poll.failed', failureFields(error));
      }
    }, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [modelStorage]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 3000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const modelLoadBarrierState = runtimeHealth?.modelLoadBarrier;
  const modelLoadBarrierEngine = runtimeHealth?.modelLoadEngine;
  useEffect(() => {
    if (modelLoadBarrierState && modelLoadBarrierState !== 'idle') {
      log.info('model.barrier.displayed', {
        modelId: modelLoadBarrierEngine ?? undefined,
        state: modelLoadBarrierState,
      });
    }
  }, [modelLoadBarrierState, modelLoadBarrierEngine]);
  const isGpuReportUnavailable = hardware ? hardware.available === false : false;
  useEffect(() => {
    if (isGpuReportUnavailable) {
      log.warn('model.gpu.report.unavailable');
    }
  }, [isGpuReportUnavailable]);
  async function loadMusic() {
    let httpStatus;
    setLoadingMusic(true);
    setMemoryError('');
    try {
      const response = await fetch('/api/runtime/models/music/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        log.warn('model.load.blocked', memoryConflictFields('music', result));
        setMemoryConflict(result);
        return;
      }
      if (response.ok) {
        log.info('model.load.requested', { modelId: 'music', httpStatus });
      } else {
        log.warn('model.load.rejected', { modelId: 'music', httpStatus, reason: result.code });
      }
      if (!response.ok && memoryConflict) {
        setMemoryError(result.message || result.error || 'Could not check memory.');
        return;
      }
      setMemoryConflict(null);
      setNotice(result.message || result.error || 'Request completed.');
    } catch (error) {
      log.warn('model.load.failed', { modelId: 'music', httpStatus, ...failureFields(error) });
      if (memoryConflict) {
        setMemoryError('Could not reach the model service.');
      } else {
        setNotice('Could not reach the model service.');
      }
    } finally {
      setLoadingMusic(false);
    }
  }
  async function stopService(id, name) {
    let httpStatus;
    setStoppingService(id);
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || result.message || 'Could not stop the service.');
      }
      log.info('model.unload.completed', { modelId: id, trigger: 'stop_button', httpStatus });
      setNotice(`${name} stopped. Memory may take a moment to become available.`);
      await refreshStorage();
    } catch (error) {
      log.warn('model.unload.failed', {
        modelId: id,
        trigger: 'stop_button',
        httpStatus,
        ...failureFields(error),
      });
      setNotice(error.message);
    } finally {
      setStoppingService(null);
    }
  }
  // Starts the service process only. The model loads later, when a render needs it.
  async function startService(id, name) {
    let httpStatus;
    setStartingService(id);
    try {
      const response = await fetch(`/api/runtime/engines/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || `Could not start ${name}.`);
      }
      log.info('engine.start.requested', { engineId: id, outcome: result.status, httpStatus });
      setNotice(startNotice(result, name));
      await refreshStorage();
    } catch (error) {
      log.warn('engine.start.failed', { engineId: id, httpStatus, ...failureFields(error) });
      setNotice(error.message);
    } finally {
      setStartingService(null);
    }
  }
  async function forceStopService() {
    if (!forceTarget) {
      return;
    }
    log.info('engine.force_stop.confirmed', { engineId: forceTarget.id });
    let httpStatus;
    setForceBusy(true);
    setForceError('');
    try {
      const response = await fetch(`/api/runtime/models/${forceTarget.id}/force-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmation: 'force-stop-engine' }),
      });
      httpStatus = response.status;
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not verify that the service stopped.');
      }
      log.info('engine.force_stop.completed', { engineId: forceTarget.id, httpStatus });
      setForceResult(data);
      await refreshStorage();
    } catch (error) {
      log.warn('engine.force_stop.failed', {
        engineId: forceTarget.id,
        httpStatus,
        ...failureFields(error),
      });
      setForceError(error.message);
    } finally {
      setForceBusy(false);
    }
  }
  function closeForce() {
    if (forceBusy) {
      return;
    }
    log.info('engine.force_stop.dialog.closed', {
      engineId: forceTarget?.id,
      outcome: forceResult ? 'after_result' : 'cancelled',
    });
    setForceTarget(null);
    setForceResult(null);
    setForceError('');
  }
  async function startAll() {
    let httpStatus;
    setStartingEngines(true);
    try {
      const response = await fetch('/api/runtime/engines/start-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not start engines.');
      }
      log.info('engine.start_all.completed', {
        serviceCount: Array.isArray(result.services) ? result.services.length : undefined,
        httpStatus,
      });
      setEngineStartResults(result.services);
      setNotice('Engine start requests processed.');
    } catch (error) {
      log.warn('engine.start_all.failed', { httpStatus, ...failureFields(error) });
      setNotice(error.message);
    } finally {
      setStartingEngines(false);
    }
  }
  async function clearBarrier() {
    const engine = [
        'sfx',
        'tts',
        'asr',
        'game',
        '3d-hunyuan',
        '3d-trellis',
        'segmentation',
        'motion-hy',
        'motion-bricks',
      ].includes(runtimeHealth?.modelLoadEngine)
        ? runtimeHealth.modelLoadEngine
        : 'music',
      name =
        engine === 'sfx'
          ? 'Stable Audio'
          : engine === 'tts'
            ? 'Qwen3-TTS'
            : engine === 'asr'
              ? 'Nemotron ASR'
              : engine === 'game'
                ? 'Mammoth'
                : engine === '3d-hunyuan'
                  ? 'Hunyuan3D'
                  : engine === '3d-trellis'
                    ? 'TRELLIS.2'
                    : engine === 'segmentation'
                      ? 'SAM 3.1'
                      : engine === 'motion-hy'
                        ? 'HY-Motion'
                        : engine === 'motion-bricks'
                          ? 'MotionBricks'
                          : 'YuE2';
    if (
      !window.confirm(
        `Only continue after verifying ${name} is neither loading nor waiting to load. Clear the queue barrier?`,
      )
    ) {
      log.info('model.barrier.clear.cancelled', { modelId: engine });
      return;
    }
    log.info('model.barrier.clear.confirmed', { modelId: engine });
    let httpStatus;
    setLoadingMusic(true);
    try {
      const response = await fetch(`/api/runtime/models/${engine}/clear-load-barrier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmNotLoading: true }),
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not clear the barrier.');
      }
      log.info('model.barrier.clear.completed', { modelId: engine, httpStatus });
      setRuntimeHealth((value) => ({ ...value, modelLoadBarrier: 'idle', modelLoadEngine: null }));
      setNotice(result.message);
    } catch (error) {
      log.warn('model.barrier.clear.failed', {
        modelId: engine,
        httpStatus,
        ...failureFields(error),
      });
      setNotice(error.message);
    } finally {
      setLoadingMusic(false);
    }
  }
  async function loadAsr() {
    let httpStatus;
    setLoadingAsr(true);
    setAsrError('');
    try {
      const response = await fetch('/api/runtime/models/asr/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        log.warn('model.load.blocked', memoryConflictFields('asr', result));
        setAsrConflict(result);
        return;
      }
      if (!response.ok) {
        throw Error(result.message || result.error || 'Could not start speech recognition.');
      }
      log.info('model.load.requested', { modelId: 'asr', httpStatus });
      setAsrConflict(null);
      setNotice(result.message);
    } catch (error) {
      log.warn('model.load.failed', { modelId: 'asr', httpStatus, ...failureFields(error) });
      if (asrConflict) {
        setAsrError(error.message);
      } else {
        setNotice(error.message);
      }
    } finally {
      setLoadingAsr(false);
    }
  }
  async function offloadForAsr(id) {
    let httpStatus;
    setLoadingAsr(true);
    setAsrError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      log.info('model.unload.completed', { modelId: id, trigger: 'memory_dialog', httpStatus });
      await loadAsr();
    } catch (error) {
      log.warn('model.unload.failed', {
        modelId: id,
        trigger: 'memory_dialog',
        httpStatus,
        ...failureFields(error),
      });
      setAsrError(error.message);
    } finally {
      setLoadingAsr(false);
    }
  }
  function closeSound() {
    setSoundOpen(false);
    setSoundConflict(null);
    setSoundToken('');
    setSoundError('');
  }
  async function loadSound() {
    let httpStatus;
    setLoadingSound(true);
    setSoundError('');
    try {
      const response = await fetch('/api/runtime/models/sfx/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ token: soundToken }),
      });
      httpStatus = response.status;
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        log.warn('model.load.blocked', memoryConflictFields('sfx', result));
        setSoundConflict(result);
        return;
      }
      if (!response.ok) {
        log.warn('model.load.rejected', { modelId: 'sfx', httpStatus, reason: result.code });
        setSoundError(result.message || result.error || 'Could not load Stable Audio.');
        return;
      }
      log.info('model.load.requested', { modelId: 'sfx', httpStatus });
      closeSound();
      setNotice(result.message || 'Stable Audio load requested.');
    } catch (error) {
      log.warn('model.load.failed', { modelId: 'sfx', httpStatus, ...failureFields(error) });
      setSoundError('Could not reach the model service.');
    } finally {
      setLoadingSound(false);
    }
  }
  async function offloadForSound(id) {
    let httpStatus;
    setLoadingSound(true);
    setSoundError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      log.info('model.unload.completed', { modelId: id, trigger: 'memory_dialog', httpStatus });
      await loadSound();
    } catch (error) {
      log.warn('model.unload.failed', {
        modelId: id,
        trigger: 'memory_dialog',
        httpStatus,
        ...failureFields(error),
      });
      setSoundError(error.message);
    } finally {
      setLoadingSound(false);
    }
  }
  async function offload(id) {
    let httpStatus;
    setLoadingMusic(true);
    setMemoryError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      httpStatus = response.status;
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      log.info('model.unload.completed', { modelId: id, trigger: 'memory_dialog', httpStatus });
      await loadMusic();
    } catch (error) {
      log.warn('model.unload.failed', {
        modelId: id,
        trigger: 'memory_dialog',
        httpStatus,
        ...failureFields(error),
      });
      setMemoryError(error.message);
    } finally {
      setLoadingMusic(false);
    }
  }
  const statusFor = (model) =>
    model.panel === 'chat'
      ? chatService
      : serviceStates.find((service) => service.id === serviceIds[model.name]);
  // Storage ids are catalog ids. Service ids differ (WorldGen and HY-World share "world"),
  // so they must not be used to find a model's folder.
  const storageFor = (model) => modelStorage?.entries?.find((item) => item.id === model.id);
  const removalFor = (model) => modelStorage?.removals?.[model.id];
  const isAttention = (model) => {
    const status = statusFor(model),
      storage = storageFor(model),
      removal = removalFor(model);
    return !!(
      status?.ownershipRecovery === 'unresolved' ||
      status?.status === 'unverified' ||
      storage?.error ||
      removal?.state === 'failed'
    );
  };
  const loadedCount = models.filter((model) => statusFor(model)?.modelLoaded === true).length;
  const onlineCount = models.filter((model) => statusFor(model)?.status === 'reachable').length;
  const installedCount = models.filter((model) => storageFor(model)?.installed === true).length;
  const attentionCount = models.filter(isAttention).length;
  const filtered = models.filter((model) => {
    const status = statusFor(model),
      storage = storageFor(model);
    return (
      (category === 'All' || model.category === category) &&
      `${model.name} ${model.category} ${model.purpose}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()) &&
      (statusFilter === 'all' ||
        (statusFilter === 'connected' && status?.status === 'reachable') ||
        (statusFilter === 'loaded' && status?.modelLoaded === true) ||
        (statusFilter === 'installed' && storage?.installed === true) ||
        (statusFilter === 'attention' && isAttention(model)))
    );
  });
  const device = hardware?.devices?.find(
    (item) => item.freeMiB !== null && item.freeMiB !== undefined,
  );
  const unmeasuredFolders =
    modelStorage?.entries?.filter((item) => item.bytes === null || item.bytes === undefined)
      .length || 0;
  const measured =
    modelStorage?.entries?.length && unmeasuredFolders === 0
      ? fileSize(modelStorage.entries.reduce((sum, item) => sum + item.bytes, 0))
      : '—';
  const barrierNames = {
    sfx: 'Stable Audio',
    tts: 'Qwen3-TTS',
    asr: 'Nemotron ASR',
    game: 'Mammoth-1',
    '3d-hunyuan': 'Hunyuan3D',
    '3d-trellis': 'TRELLIS.2',
    segmentation: 'SAM 3.1',
    'motion-hy': 'HY-Motion',
    'motion-bricks': 'MotionBricks',
    chat: 'Qwen Chat',
    music: 'YuE2',
  };
  async function copyPath(value, name) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPath(name);
      setTimeout(() => setCopiedPath(''), 2200);
    } catch (error) {
      // Clipboard access can be denied by the browser; the toast tells the person.
      log.debug('model.path.copy.failed', failureFields(error));
      setNotice('Could not copy the folder path.');
    }
  }
  return (
    <div className="page catalog-page">
      <header className="catalog-header">
        <div>
          <div className="catalog-kicker">
            <span /> Your studio infrastructure
          </div>
          <h1>Models &amp; services</h1>
          <p>See what’s available, where it lives, and what it needs to run.</p>
        </div>
        <button className="catalog-start" onClick={startAll} disabled={startingEngines}>
          {startingEngines ? (
            <LoaderCircle size={17} className="motion-spinner" />
          ) : (
            <Zap size={17} />
          )}{' '}
          {startingEngines ? 'Starting services…' : 'Start connected services'}
        </button>
      </header>
      <div className="catalog-overview">
        <section className="catalog-memory" aria-label="GPU memory">
          <div className="catalog-summary-heading">
            <div className="catalog-summary-icon">
              <Cpu size={20} />
            </div>
            <div>
              <span>GPU memory</span>
              <strong>{device?.name || 'GPU status'}</strong>
            </div>
            <span className="catalog-live">Live snapshot</span>
          </div>
          <div className="catalog-memory-values">
            <div>
              <strong>{memory(device?.freeMiB)}</strong>
              <span>free</span>
            </div>
            <div>
              <strong>{memory(device?.usedMiB)}</strong>
              <span>used</span>
            </div>
            <div>
              <strong>{memory(device?.totalMiB)}</strong>
              <span>total</span>
            </div>
          </div>
          {device?.totalMiB > 0 && (
            <div className="catalog-memory-track" aria-hidden="true">
              <span
                style={{
                  width: `${Math.max(0, Math.min(100, (device.usedMiB / device.totalMiB) * 100))}%`,
                }}
              />
            </div>
          )}
          <p>
            {runtimeError ||
              (!hardware
                ? 'Checking GPU memory…'
                : !hardware.available
                  ? 'GPU memory information is unavailable.'
                  : 'GPU memory changes as other applications use it.')}
          </p>
        </section>
        <section className="catalog-storage">
          <div className="catalog-summary-heading">
            <div className="catalog-summary-icon storage">
              <FolderOpen size={20} />
            </div>
            <div>
              <span>Model storage</span>
              <strong>Forge-managed files</strong>
            </div>
          </div>
          <div className="catalog-storage-value">
            <strong>{measured}</strong>
            <span>
              {modelStorage?.state === 'scanning'
                ? 'Measuring files…'
                : unmeasuredFolders > 0
                  ? `${unmeasuredFolders} folder${unmeasuredFolders === 1 ? '' : 's'} could not be measured`
                  : 'measured in models/'}
            </span>
          </div>
          <p>
            {hardware?.disk
              ? `${fileSize(hardware.disk.freeBytes)} free on the project drive. `
              : ''}
            Models in other apps are not included.
          </p>
          {modelStorage?.root && (
            <button
              className="catalog-path-copy"
              onClick={() => copyPath(modelStorage.root, 'root')}
            >
              {copiedPath === 'root' ? <Check size={14} /> : <Copy size={14} />}{' '}
              {copiedPath === 'root' ? 'Folder path copied' : 'Copy model folder path'}
            </button>
          )}
        </section>
      </div>
      {runtimeHealth?.modelLoadBarrier && runtimeHealth.modelLoadBarrier !== 'idle' && (
        <div className="catalog-alert" role="status">
          <ShieldCheck size={19} />
          <div>
            <strong>
              {barrierNames[runtimeHealth.modelLoadEngine] || 'A model'} is being checked
            </strong>
            <span>The render queue waits while this model load is resolved.</span>
          </div>
          {runtimeHealth.modelLoadEngine !== 'chat' && (
            <button disabled={loadingMusic} onClick={clearBarrier}>
              Clear after checking…
            </button>
          )}
        </div>
      )}
      {engineStartResults.length > 0 && (
        <details className="catalog-start-results">
          <summary>Service start results</summary>
          <div>
            {engineStartResults.map((result) => (
              <span key={result.id}>
                <strong>{result.id}</strong> · {result.status.replaceAll('_', ' ')}
                {result.message ? ` — ${result.message}` : ''}
              </span>
            ))}
          </div>
        </details>
      )}
      <div className="catalog-intro">
        <div>
          <h2>Model catalog</h2>
          <p>
            Services start separately from model loading. The queue loads supported models as
            needed.
          </p>
        </div>
        <span className="catalog-result-count" aria-live="polite" aria-atomic="true">
          {filtered.length} of {models.length} models
        </span>
      </div>
      <section className="catalog-filter-panel" aria-label="Find models">
        <div className="catalog-filter-heading">
          <strong>Find a model</strong>
          <span>Search by name, category, or use</span>
        </div>
        <div className="catalog-filters">
          <div className="catalog-search-field">
            <label htmlFor="catalog-search-input">Search</label>
            <div className="catalog-search">
              <Search size={18} />
              <input
                id="catalog-search-input"
                aria-label="Search models"
                placeholder="Search by model or use…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button aria-label="Clear model search" onClick={() => setSearch('')}>
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="catalog-category-field">
            <label htmlFor="catalog-category">Category</label>
            <select
              id="catalog-category"
              aria-label="Filter model category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <button
            className="catalog-refresh"
            aria-label="Refresh model services"
            title="Refresh model services"
            onClick={refreshStorage}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <div className="catalog-status-filters">
          <span className="catalog-status-filter-label">Availability</span>
          <div className="catalog-filter-pills" role="group" aria-label="Filter models by status">
            {[
              ['all', 'All', models.length],
              ['connected', 'Services online', serviceStates.length ? onlineCount : '—'],
              ['loaded', 'Loaded', serviceStates.length ? loadedCount : '—'],
              [
                'installed',
                'In models folder',
                modelStorage?.entries?.length ? installedCount : '—',
              ],
              ['attention', 'Needs attention', serviceStates.length ? attentionCount : '—'],
            ].map(([id, label, count]) => (
              <button
                key={id}
                aria-label={`${label}, ${count} models`}
                aria-pressed={statusFilter === id}
                data-zero-count={count === 0}
                onClick={() => setStatusFilter(id)}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="catalog-grid" aria-label="Model library">
        {filtered.length ? (
          filtered.map((model) => {
            const status = statusFor(model),
              storage = storageFor(model),
              removal = removalFor(model),
              attention = isAttention(model),
              online = status?.status === 'reachable',
              notes = modelNotes[model.id] || [],
              size = ['prepared', 'deleting'].includes(removal?.state)
                ? 'Removing…'
                : removal?.state === 'failed'
                  ? 'Cleanup needed'
                  : storage?.error
                    ? 'Scan failed'
                    : storage?.installed
                      ? fileSize(storage.bytes)
                      : storage?.installed === false
                        ? 'Not installed'
                        : !modelStorage || modelStorage.state === 'scanning'
                          ? 'Measuring…'
                          : 'Not measured',
              locationFallback = modelStorage
                ? 'Not found in the Forge model folder'
                : 'Checking model folder location…';
            return (
              <article className="catalog-card" key={model.name}>
                <div className="catalog-card-top">
                  <div className="catalog-model-icon">
                    <model.icon size={21} />
                  </div>
                  <div className="catalog-model-heading">
                    <span>{model.category}</span>
                    <h3>{model.name}</h3>
                  </div>
                  <span
                    className={
                      'catalog-status ' +
                      (attention
                        ? 'attention'
                        : status?.modelLoaded === true
                          ? 'loaded'
                          : online
                            ? 'online'
                            : 'offline')
                    }
                  >
                    <i />
                    {serviceLabel(status)}
                  </span>
                </div>
                <p className="catalog-purpose">{model.purpose}</p>
                {notes.length > 0 && (
                  <ul className="catalog-notes" aria-label={`${model.name} status`}>
                    {notes.map((item) => (
                      <li key={item.label}>
                        <span className="catalog-badge">{item.label}</span>
                        <span>{item.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="catalog-details">
                  <div>
                    <span>Model files</span>
                    <strong title={storage?.error || ''}>{size}</strong>
                    <small>
                      {storage ? 'Forge model folder' : 'Not in measured model folders'}
                    </small>
                  </div>
                  <div>
                    <span>Est. GPU budget</span>
                    <strong>{model.gpu}</strong>
                    <small>Not a live measurement</small>
                  </div>
                </div>
                <div className="catalog-location">
                  <HardDrive size={15} />
                  <span title={storage?.path || locationFallback}>
                    {storage?.path || locationFallback}
                  </span>
                  {storage?.path && (
                    <button
                      title="Copy model path"
                      aria-label={`Copy ${model.name} model path`}
                      onClick={() => copyPath(storage.path, model.name)}
                    >
                      {copiedPath === model.name ? <Check size={15} /> : <Copy size={15} />}
                    </button>
                  )}
                </div>
                <div className="catalog-card-actions">
                  <button
                    className="catalog-open"
                    onClick={() => onNavigate(model.panel, model.name)}
                  >
                    Open {panelLabels[model.panel] || `${model.panel} studio`}{' '}
                    <ArrowUpRight size={15} />
                  </button>
                  {model.name === 'YuE2' &&
                    status?.status === 'reachable' &&
                    status.modelLoaded === false && (
                      <button
                        className="catalog-action"
                        onClick={loadMusic}
                        disabled={loadingMusic || status.busy}
                      >
                        {loadingMusic ? 'Checking…' : status.busy ? 'Loading…' : 'Load model'}
                      </button>
                    )}
                  {model.name === 'Stable Audio 3' &&
                    status?.status === 'reachable' &&
                    status.modelLoaded === false && (
                      <button
                        className="catalog-action"
                        onClick={() => {
                          log.info('model.access.dialog.opened', { modelId: 'sfx' });
                          setSoundError('');
                          setSoundOpen(true);
                        }}
                        disabled={loadingSound || status.busy}
                      >
                        {status.busy ? 'Loading…' : 'Load model'}
                      </button>
                    )}
                  {model.name === 'Nemotron ASR' && status?.modelLoaded !== true && (
                    <button
                      className="catalog-action"
                      disabled={loadingAsr || runtimeHealth?.modelLoadEngine === 'asr'}
                      onClick={loadAsr}
                    >
                      {loadingAsr
                        ? 'Checking…'
                        : runtimeHealth?.modelLoadEngine === 'asr'
                          ? 'Starting…'
                          : 'Start & load model'}
                    </button>
                  )}
                  {status?.startsOnDemand === false &&
                    status.status === 'unavailable' &&
                    !status.managed &&
                    !status.canForceStop &&
                    !['unresolved', 'checking'].includes(status.ownershipRecovery) && (
                      <button
                        className="catalog-action"
                        aria-label={`Start ${model.name} service`}
                        disabled={!!startingService}
                        onClick={() => startService(status.id, model.name)}
                      >
                        {startingService === status.id ? 'Starting…' : 'Start service'}
                      </button>
                    )}
                  {status?.canUnload && (
                    <button
                      className="catalog-action"
                      aria-label={`Stop ${model.name} service`}
                      disabled={!!stoppingService}
                      onClick={() => stopService(status.id, model.name)}
                    >
                      {stoppingService === status.id ? 'Stopping…' : 'Stop service'}
                    </button>
                  )}
                  {status?.canForceStop && (
                    <button
                      className="catalog-action danger"
                      aria-label={`Force stop ${model.name}`}
                      disabled={!!stoppingService}
                      onClick={() => {
                        log.info('engine.force_stop.dialog.opened', { engineId: status.id });
                        setForceError('');
                        setForceResult(null);
                        setForceTarget({ id: status.id, name: model.name });
                      }}
                    >
                      Force stop…
                    </button>
                  )}
                  <button
                    className="catalog-action"
                    aria-label={`File details for ${model.name}`}
                    onClick={() => setSelected(model)}
                  >
                    File details
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <div className="catalog-empty">
            <Search size={22} />
            <strong>No models match these filters</strong>
            <span>Try a different search or show all models.</span>
            <button onClick={() => change({ q: null, category: null, status: null })}>
              Clear filters
            </button>
          </div>
        )}
      </section>
      <p className="catalog-footnote">
        GPU figures are configured estimates, not current usage; some loads also reserve additional
        memory. Measured file sizes exclude links and may differ from disk space recovered. External
        services are managed by their own apps.
      </p>
      {selected && (
        <ModelRemovalDialog
          model={selected}
          id={selected.id}
          storage={storageFor(selected)}
          service={statusFor(selected)}
          removal={removalFor(selected)}
          inventoryState={modelStorage?.state}
          onRefresh={refreshStorage}
          onClose={() => setSelected(null)}
        />
      )}{' '}
      {forceTarget && (
        <ForceStopDialog
          name={forceTarget.name}
          working={forceBusy}
          result={forceResult}
          error={forceError}
          onClose={closeForce}
          onForceStop={forceStopService}
        />
      )}{' '}
      {memoryConflict && (
        <MemoryDialog
          conflict={memoryConflict}
          onClose={() => setMemoryConflict(null)}
          onRetry={loadMusic}
          onOffload={offload}
          working={loadingMusic}
          error={memoryError}
        />
      )}{' '}
      {soundOpen && !soundConflict && (
        <SoundAccessDialog
          token={soundToken}
          setToken={setSoundToken}
          onClose={closeSound}
          onLoad={loadSound}
          working={loadingSound}
          error={soundError}
        />
      )}{' '}
      {soundOpen && soundConflict && (
        <MemoryDialog
          target="Stable Audio"
          conflict={soundConflict}
          onClose={() => {
            setSoundConflict(null);
            setSoundError('');
          }}
          onRetry={loadSound}
          onOffload={offloadForSound}
          working={loadingSound}
          error={soundError}
        />
      )}{' '}
      {asrConflict && (
        <MemoryDialog
          target="Nemotron ASR"
          conflict={asrConflict}
          onClose={() => setAsrConflict(null)}
          onRetry={loadAsr}
          onOffload={offloadForAsr}
          working={loadingAsr}
          error={asrError}
        />
      )}{' '}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}
