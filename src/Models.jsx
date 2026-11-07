import { useSearchParams } from 'react-router';
import { updateSearch } from './useNav';
import useDialogFocus from './useDialogFocus';
import { modelCatalog } from '../runtime/model-catalog';
import ForceStopDialog from './ForceStopDialog';
import { useCallback, useEffect, useState } from 'react';
import ModelRemovalDialog from './ModelRemovalDialog';
import MemoryDialog from './MemoryDialog';
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
const models = modelCatalog
  .filter((model) => !model.role)
  .map((model) => ({ ...model, icon: icons[model.icon] || Cpu }));
const categories = ['All', ...new Set(models.map((model) => model.category))];
const serviceIds = Object.fromEntries(
  models
    .filter((model) => model.id !== 'chat')
    .map((model) => [model.name, model.serviceId || model.id]),
);
const managedIds = new Set([
  '3d-trellis',
  '3d-hunyuan',
  'motion-hy',
  'motion-bricks',
  'tts',
  'asr',
  'segmentation',
]);
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
    } catch {
      // Model storage is refreshed again by the polling effect.
    }
  }, []);
  useEffect(() => {
    let active = true;
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
        }
      } catch {
        if (active) {
          setRuntimeError('Runtime is starting or unavailable. Retrying…');
        }
      }
    }
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    async function checkChat() {
      try {
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
        }
      } catch {
        if (alive) {
          setChatService({
            id: 'chat',
            status: 'unavailable',
            modelLoaded: null,
            url: 'http://127.0.0.1:8098',
          });
        }
      }
    }
    checkChat();
    const timer = setInterval(checkChat, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
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
      } catch {
        // Storage refresh is best-effort while the scan is in progress.
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
  async function loadMusic() {
    setLoadingMusic(true);
    setMemoryError('');
    try {
      const response = await fetch('/api/runtime/models/music/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        setMemoryConflict(result);
        return;
      }
      if (!response.ok && memoryConflict) {
        setMemoryError(result.message || result.error || 'Could not check memory.');
        return;
      }
      setMemoryConflict(null);
      setNotice(result.message || result.error || 'Request completed.');
    } catch {
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
    setStoppingService(id);
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || result.message || 'Could not stop the service.');
      }
      setNotice(`${name} stopped. Memory may take a moment to become available.`);
      await refreshStorage();
    } catch (error) {
      setNotice(error.message);
    } finally {
      setStoppingService(null);
    }
  }
  async function forceStopService() {
    if (!forceTarget) {
      return;
    }
    setForceBusy(true);
    setForceError('');
    try {
      const response = await fetch(`/api/runtime/models/${forceTarget.id}/force-stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmation: 'force-stop-engine' }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not verify that the service stopped.');
      }
      setForceResult(data);
      await refreshStorage();
    } catch (error) {
      setForceError(error.message);
    } finally {
      setForceBusy(false);
    }
  }
  function closeForce() {
    if (forceBusy) {
      return;
    }
    setForceTarget(null);
    setForceResult(null);
    setForceError('');
  }
  async function startAll() {
    setStartingEngines(true);
    try {
      const response = await fetch('/api/runtime/engines/start-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not start engines.');
      }
      setEngineStartResults(result.services);
      setNotice('Engine start requests processed.');
    } catch (error) {
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
      return;
    }
    setLoadingMusic(true);
    try {
      const response = await fetch(`/api/runtime/models/${engine}/clear-load-barrier`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmNotLoading: true }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not clear the barrier.');
      }
      setRuntimeHealth((value) => ({ ...value, modelLoadBarrier: 'idle', modelLoadEngine: null }));
      setNotice(result.message);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setLoadingMusic(false);
    }
  }
  async function loadAsr() {
    setLoadingAsr(true);
    setAsrError('');
    try {
      const response = await fetch('/api/runtime/models/asr/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        setAsrConflict(result);
        return;
      }
      if (!response.ok) {
        throw Error(result.message || result.error || 'Could not start speech recognition.');
      }
      setAsrConflict(null);
      setNotice(result.message);
    } catch (error) {
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
    setLoadingAsr(true);
    setAsrError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      await loadAsr();
    } catch (error) {
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
    setLoadingSound(true);
    setSoundError('');
    try {
      const response = await fetch('/api/runtime/models/sfx/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ token: soundToken }),
      });
      const result = await response.json();
      if (result.code === 'insufficient_gpu_memory') {
        setSoundConflict(result);
        return;
      }
      if (!response.ok) {
        setSoundError(result.message || result.error || 'Could not load Stable Audio.');
        return;
      }
      closeSound();
      setNotice(result.message || 'Stable Audio load requested.');
    } catch {
      setSoundError('Could not reach the model service.');
    } finally {
      setLoadingSound(false);
    }
  }
  async function offloadForSound(id) {
    setLoadingSound(true);
    setSoundError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      await loadSound();
    } catch (error) {
      setSoundError(error.message);
    } finally {
      setLoadingSound(false);
    }
  }
  async function offload(id) {
    setLoadingMusic(true);
    setMemoryError('');
    try {
      const response = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not stop service.');
      }
      await loadMusic();
    } catch (error) {
      setMemoryError(error.message);
    } finally {
      setLoadingMusic(false);
    }
  }
  const statusFor = (model) =>
    model.panel === 'chat'
      ? chatService
      : serviceStates.find((service) => service.id === serviceIds[model.name]);
  const storageFor = (model) =>
    modelStorage?.entries?.find((item) => item.id === serviceIds[model.name]);
  const isAttention = (model) => {
    const status = statusFor(model),
      storage = storageFor(model),
      removal = modelStorage?.removals?.[serviceIds[model.name]];
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
  const measured =
    modelStorage?.entries?.length &&
    !modelStorage.entries.some((item) => item.bytes === null || item.bytes === undefined)
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
    } catch {
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
              {modelStorage?.state === 'scanning' ? 'Measuring files…' : 'measured in models/'}
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
            const id = serviceIds[model.name],
              status = statusFor(model),
              storage = storageFor(model),
              removal = modelStorage?.removals?.[id],
              managed = managedIds.has(id),
              attention = isAttention(model),
              online = status?.status === 'reachable',
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
                        : managed && (!modelStorage || modelStorage.state === 'scanning')
                          ? 'Measuring…'
                          : 'Not measured';
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
                <div className="catalog-details">
                  <div>
                    <span>Model files</span>
                    <strong title={storage?.error || ''}>{size}</strong>
                    <small>{managed ? 'Forge model folder' : 'Outside Forge inventory'}</small>
                  </div>
                  <div>
                    <span>Est. GPU budget</span>
                    <strong>{model.gpu}</strong>
                    <small>Not a live measurement</small>
                  </div>
                </div>
                <div className="catalog-location">
                  <HardDrive size={15} />
                  <span
                    title={
                      storage?.path ||
                      (managed
                        ? 'Checking model folder location'
                        : 'Location is outside the measured model folders')
                    }
                  >
                    {storage?.path ||
                      (managed
                        ? 'Checking model folder location…'
                        : 'Location is outside the measured model folders')}
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
                    Open{' '}
                    {model.panel === '3d'
                      ? '3D studio'
                      : model.panel === 'motion'
                        ? 'motion studio'
                        : model.panel === 'sfx'
                          ? 'sound effects'
                          : model.panel === 'game'
                            ? 'game logic'
                            : model.panel === 'segmentation'
                              ? 'segmentation'
                              : model.panel === 'chat'
                                ? 'chat'
                                : model.panel === 'voices'
                                  ? 'voice studio'
                                  : model.panel === 'images'
                                    ? 'image studio'
                                    : `${model.panel} studio`}{' '}
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
                          : 'Start service'}
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
                        setForceError('');
                        setForceResult(null);
                        setForceTarget({ id: status.id, name: model.name });
                      }}
                    >
                      Force stop…
                    </button>
                  )}
                  {id && (
                    <button
                      className="catalog-action"
                      aria-label={`File details for ${model.name}`}
                      onClick={() => setSelected(model)}
                    >
                      File details
                    </button>
                  )}
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
          id={serviceIds[selected.name]}
          storage={modelStorage?.entries?.find((item) => item.id === serviceIds[selected.name])}
          service={serviceStates.find((item) => item.id === serviceIds[selected.name])}
          removal={modelStorage?.removals?.[serviceIds[selected.name]]}
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
