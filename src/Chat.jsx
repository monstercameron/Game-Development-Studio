import MemoryDialog from './MemoryDialog';
import ConfirmDialog from './ConfirmDialog';
import { ensureChatReady, isStudioQwen } from './chat-autostart';
import {
  CHAT_CONTEXT_SIZES,
  DEFAULT_CHAT_CONTEXT,
  estimateChatMemory,
} from '../runtime/chat-memory.js';
import { saveProjectText } from './save-project-text';
import { EMPTY_SAMPLING, SAMPLING_FIELDS, samplingFromForm } from './chat-sampling-form';
import {
  chatStorageKey,
  chatsForStorage,
  normalizeSavedChats,
  readChatDraft,
  sanitizeSavedChatList,
  writeChatDraft,
} from './chat-project';
import { ChatImageButtons, ChatImageTray } from './ChatImageInput';
import { useChatImages, useChatVision } from './use-chat-images';
import { imageInputBlock, savedImageRecord } from './chat-images';
import { CHAT_PROJECTOR_MIB } from '../runtime/chat-image-limits.js';
import { checkJsonSyntax, isStructuredJsonFormat } from './chat-output';
import { createResponseMetrics } from './chat-metrics';
import { createLog } from './app-log.js';
import ChatMarkdown from './ChatMarkdown';
import { useSearchParams } from 'react-router';
import { updateSearch, useRouteToggle, routeDetails } from './useNav';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Braces,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Pencil,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  X,
  Zap,
  RotateCcw,
} from 'lucide-react';
import './chat.css';
import './chat-desktop.css';
import './chat-history-rename.css';

const exampleSchema = JSON.stringify(
  {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'description', 'tags'],
    additionalProperties: false,
  },
  null,
  2,
);
const makeChat = () => ({
  id: crypto.randomUUID(),
  title: 'New conversation',
  messages: [],
  createdAt: Date.now(),
});
const headers = { 'Content-Type': 'application/json', 'X-Forge-Request': 'chat' };
const log = createLog('chat');
// Error text can echo prompts or server output, so only the class and codes are logged.
function errorFields(error) {
  return {
    errorClass: typeof error?.name === 'string' ? error.name : 'Error',
    ...(typeof error?.code === 'string' ? { errorCode: error.code } : {}),
    ...(Number.isFinite(error?.status) ? { httpStatus: error.status } : {}),
  };
}
async function readRuntimeResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    log.warn('chat.runtime.response.unreadable', {
      ...errorFields(error),
      httpStatus: response.status,
    });
    throw Error(
      `The studio returned an unreadable response (${response.status}). Try again or check Diagnostics.`,
      { cause: error },
    );
  }
}
async function call(route, body, signal) {
  // log-coverage: ignore -- failed /api calls are already logged by app-log-install (http.request.failed)
  const r = await fetch('/api/chat/' + route, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const error = Error(data.error || `Request failed (${r.status}).`);
    error.code = data.code;
    error.status = r.status;
    throw error;
  }
  return r;
}
function readSaved(key) {
  try {
    const savedList = sanitizeSavedChatList(JSON.parse(localStorage.getItem(key)));
    log.debug('chat.conversations.loaded', { conversationCount: savedList.length });
    return savedList.length ? normalizeSavedChats(savedList) : [makeChat()];
  } catch (error) {
    log.warn('chat.conversations.load.failed', { ...errorFields(error), reason: 'using_empty' });
    return [makeChat()];
  }
}
function savedNumber(key, fallback, valid) {
  try {
    const value = Number(localStorage.getItem(key));
    return valid(value) ? value : fallback;
  } catch (error) {
    log.debug('chat.setting.read.failed', { ...errorFields(error), reason: 'using_default' });
    return fallback;
  }
}
// One exchange is one user message; assistant replies are not counted separately.
function exchangeCountLabel(messages) {
  const exchangeCount = messages.filter((message) => message.role === 'user').length;
  return `${exchangeCount} ${exchangeCount === 1 ? 'exchange' : 'exchanges'}`;
}
// Status text for the model selector. Only the local Qwen server reports reachability.
function describeModelStatus({ provider, isLocalQwen, isOnline, runtimeStatus }) {
  if (provider === 'openai') {
    return 'OpenAI API · not checked';
  }
  if (!isLocalQwen) {
    return 'Compatible endpoint · not checked';
  }
  if (isOnline) {
    return 'Studio server online';
  }
  return runtimeStatus === 'starting' ? 'Starting' : 'Starts on send';
}
// Schema replies also get a note that the schema itself is not checked.
function structuredSyntaxLabel(syntax, format) {
  const isSchema = format === 'schema';
  if (syntax === 'valid') {
    return isSchema ? 'Valid JSON syntax · schema conformance not checked.' : 'Valid JSON syntax.';
  }
  if (syntax === 'invalid') {
    return isSchema
      ? 'Invalid JSON syntax · schema conformance not checked.'
      : 'Invalid JSON syntax.';
  }
  if (syntax === 'empty') {
    return 'No JSON content to check.';
  }
  return 'JSON syntax not checked · response incomplete.';
}
function ResponseMetrics({ metrics }) {
  const ttft = Number.isFinite(metrics?.ttftMs) ? `${(metrics.ttftMs / 1000).toFixed(2)}s` : '—';
  const rate =
    Number.isFinite(metrics?.tokensPerSecond) && metrics.tokensPerSecond > 0
      ? `${metrics.rateSource === 'client' ? '~' : ''}${metrics.tokensPerSecond.toFixed(1)} tok/s`
      : '— tok/s';
  return (
    <div
      className="chat-response-metrics"
      aria-label={`Response metrics: time to first token ${ttft}, generation speed ${rate}`}
    >
      <span title="Time from sending the request to the first text or thinking token. Model startup is excluded.">
        <strong>TTFT</strong> {ttft}
      </span>
      <span
        title={
          metrics?.rateSource === 'client'
            ? 'Estimated from the provider’s token count and stream duration; may include thinking tokens.'
            : 'Generation speed reported by the model server; may include thinking tokens.'
        }
      >
        {rate}
      </span>
    </div>
  );
}
export default function Chat({ project }) {
  const [qwenStopPrompt, setQwenStopPrompt] = useState(false);
  const key = chatStorageKey(project?.id);
  const [chats, setChats] = useState(() => readSaved(key));
  const [params, setParams] = useSearchParams();
  const active = params.get('conversation') || chats[0]?.id;
  const setActive = (id) => updateSearch(setParams, { conversation: id });
  // Unsent text survives this page being mounted again (the project resolving late)
  // and a reload.
  const [prompt, setPrompt] = useState(() => {
    const draft = readChatDraft();
    log.debug('chat.draft.restored', { hasDraft: draft.length > 0 });
    return draft;
  });
  useEffect(() => {
    writeChatDraft(prompt);
  }, [prompt]);
  const [provider, setProvider] = useState('compatible');
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8098/v1');
  const [model, setModel] = useState('qwen3.8-27b');
  const [models, setModels] = useState([]);
  const [apiKey, setApiKey] = useState('');
  const [format, setFormat] = useState('text');
  const [schema, setSchema] = useState(exampleSchema);
  const [system, setSystem] = useState(
    'You are a creative game development assistant. Be clear, practical, and concise.',
  );
  const [temperature, setTemperature] = useState(0.7);
  const [sampling, setSampling] = useState(EMPTY_SAMPLING);
  const samplingState = samplingFromForm(sampling, provider);
  const samplingSet = Object.values(sampling).some((value) => value.trim() !== '');
  const [maxTokens, setMaxTokens] = useState(() =>
    savedNumber(
      'forge-chat-max-output-v1',
      2048,
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 262144,
    ),
  );
  const [contextSize, setContextSize] = useState(() =>
    savedNumber('forge-chat-context-v1', DEFAULT_CHAT_CONTEXT, (n) =>
      CHAT_CONTEXT_SIZES.includes(n),
    ),
  );
  const [chatRuntime, setChatRuntime] = useState(null);
  const images = useChatImages();
  const [isDropping, setIsDropping] = useState(false);
  const [effort, setEffort] = useState('auto');
  const DEFAULT_SYSTEM =
    'You are a creative game development assistant. Be clear, practical, and concise.';
  const [resetArmed, setResetArmed] = useState(false);
  // Gated reset: disabled while every option is at its default; an enabled click only arms
  // a confirmation.
  const optionsDirty =
    format !== 'text' ||
    effort !== 'auto' ||
    Number(maxTokens) !== 2048 ||
    Number(temperature) !== 0.7 ||
    system !== DEFAULT_SYSTEM ||
    schema !== exampleSchema ||
    samplingSet;
  const optionSummary =
    [
      format !== 'text' ? (format === 'json' ? 'JSON' : 'Schema') : '',
      effort !== 'auto' ? `Thinking ${effort}` : '',
      Number(maxTokens) !== 2048 ? `${Number(maxTokens).toLocaleString()} max tokens` : '',
      Number(temperature) !== 0.7 ? `Temperature ${temperature}` : '',
      system !== DEFAULT_SYSTEM ? 'Custom instructions' : '',
      samplingSet ? 'Sampling set' : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Defaults';
  // Reset covers only the per-message Options and advanced fields. Context size belongs to
  // the local engine panel.
  const resetOptions = () => {
    setFormat('text');
    setEffort('auto');
    setMaxTokens(2048);
    setTemperature(0.7);
    setSystem(DEFAULT_SYSTEM);
    setSchema(exampleSchema);
    setSampling(EMPTY_SAMPLING);
    setResetArmed(false);
    log.info('chat.options.reset');
    // The confirmation buttons unmount; keep keyboard focus inside the composer options.
    setTimeout(() => document.querySelector('.chat-options > summary')?.focus(), 0);
  };
  const [speculative, setSpeculative] = useState(true);
  const [schemaOpen, setSchemaOpen] = useRouteToggle('schema');
  const [memoryConflict, setMemoryConflict] = useState(null);
  const [memoryError, setMemoryError] = useState('');
  const [memoryWorking, setMemoryWorking] = useState(false);
  const [settings, setSettings] = useRouteToggle('config');
  const [compactSettings, setCompactSettings] = useState(
    () => window.matchMedia('(min-width: 851px) and (max-width: 1599px)').matches,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const configRef = useRef(null),
    closeSettingsRef = useRef(null);
  closeSettingsRef.current = () => setSettings(false);
  const [advancedOpen, setAdvancedOpen] = useRouteToggle('chatAdvanced');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [memory, setMemory] = useState(null);
  const [savingMessage, setSavingMessage] = useState(null);
  const controller = useRef(null);
  const renameCancelled = useRef(false);
  const pendingMemory = useRef(null);
  const messageViewport = useRef(null),
    followMessages = useRef(true),
    composerRef = useRef(null);
  const chat = chats.find((c) => c.id === active) || chats[0];
  useEffect(() => {
    try {
      // Pictures are never saved here: only thumbnails and asset references (see chatsForStorage).
      localStorage.setItem(key, JSON.stringify(chatsForStorage(chats)));
    } catch (error) {
      log.warn('chat.conversations.save.failed', {
        ...errorFields(error),
        conversationCount: chats.length,
      });
      setError(
        'Could not save this conversation in your browser. Export important text before closing.',
      );
    }
  }, [chats, key]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 851px) and (max-width: 1599px)');
    const changed = (event) => setCompactSettings(event.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!settings) {
      return;
    }
    const previous = document.activeElement,
      panel = configRef.current;
    panel?.querySelector('button:not(:disabled)')?.focus();
    const handleKey = (event) => {
      if (document.querySelector('.modal-backdrop')) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSettingsRef.current?.();
        return;
      }
      if (!compactSettings || event.key !== 'Tab' || !panel) {
        return;
      }
      const nodes = [
        ...panel.querySelectorAll(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])',
        ),
      ].filter((node) => node.getClientRects().length);
      if (!nodes.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !panel.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      if (previous?.isConnected) {
        previous.focus();
      }
    };
  }, [settings, compactSettings]);

  useEffect(() => {
    const viewport = messageViewport.current;
    if (viewport && followMessages.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [chat?.messages]);
  useEffect(() => {
    let active = true;
    async function refreshMemory() {
      try {
        const response = await call('status', {});
        const memoryStatus = await response.json();
        if (active) {
          setMemory(memoryStatus);
        }
      } catch (error) {
        log.debug('chat.memory.status.failed', errorFields(error));
        if (active) {
          setMemory(null);
        }
      }
    }
    refreshMemory();
    const timer = setInterval(refreshMemory, 15000);
    log.debug('chat.memory.poll.started', { intervalMs: 15000 });
    return () => {
      active = false;
      clearInterval(timer);
      log.debug('chat.memory.poll.stopped');
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('forge-chat-context-v1', String(contextSize));
      const n = Number(maxTokens);
      if (Number.isSafeInteger(n) && n >= 1 && n <= 262144) {
        localStorage.setItem('forge-chat-max-output-v1', String(n));
      }
    } catch (error) {
      log.debug('chat.settings.save.failed', errorFields(error));
      // Browser storage is optional; in-memory settings remain usable.
    }
  }, [contextSize, maxTokens]);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const r = await fetch('/api/models');
        if (!r.ok) {
          return;
        }
        const data = await r.json();
        if (alive) {
          setChatRuntime(data.models?.find((item) => item.id === 'chat')?.service || null);
        }
      } catch (error) {
        log.debug('chat.runtime.status.failed', errorFields(error));
        // Runtime status is refreshed on the next interval.
      }
    }
    refresh();
    const timer = setInterval(refresh, 10000);
    log.debug('chat.runtime.poll.started', { intervalMs: 10000 });
    return () => {
      alive = false;
      clearInterval(timer);
      log.debug('chat.runtime.poll.stopped');
    };
  }, []);
  const actualContext =
    chatRuntime?.managed &&
    chatRuntime?.status === 'reachable' &&
    Number.isSafeInteger(chatRuntime.contextSize)
      ? chatRuntime.contextSize
      : null;
  const contextLimit = actualContext ?? (chatRuntime?.status === 'reachable' ? null : contextSize);

  function updateChat(id, fn) {
    setChats((current) => current.map((c) => (c.id === id ? fn(c) : c)));
  }
  function newChat() {
    if (busy) {
      return;
    }
    followMessages.current = true;
    const c = makeChat();
    setChats((x) => [c, ...x]);
    setActive(c.id);
    setError('');
    log.info('chat.conversation.created', { conversationCount: chats.length + 1 });
  }
  function cancelRename(id) {
    renameCancelled.current = true;
    setRenaming(null);
    setTimeout(() => document.querySelector(`[data-rename-for="${id}"]`)?.focus(), 0);
  }
  function commitRename() {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    const title = renaming?.value.trim().slice(0, 80);
    const id = renaming?.id;
    setRenaming(null);
    if (title && id) {
      updateChat(id, (c) => ({ ...c, title, titleLocked: true }));
      log.debug('chat.conversation.renamed');
    }
    setTimeout(() => document.querySelector(`[data-rename-for="${id}"]`)?.focus(), 0);
  }
  function deleteChat(id) {
    if (busy) {
      return;
    }
    let remaining = chats.filter((c) => c.id !== id);
    if (!remaining.length) {
      remaining = [makeChat()];
    }
    setChats(remaining);
    if (active === id) {
      setActive(remaining[0].id);
    }
    log.info('chat.conversation.deleted', { conversationCount: remaining.length });
  }
  async function copy(value, id) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied(''), 1800);
      log.debug('chat.copy.succeeded', { kind: id === 'error' ? 'error' : 'message' });
    } catch (error) {
      log.warn('chat.copy.failed', {
        ...errorFields(error),
        kind: id === 'error' ? 'error' : 'message',
      });
      setError('Clipboard unavailable. Select and copy the text manually.');
    }
  }
  const connection = { provider, endpoint, apiKey };
  const localQwen = isStudioQwen({ ...connection, model });
  const modelOnline = localQwen && chatRuntime?.status === 'reachable';
  const vision = useChatVision({ provider, endpoint, serverStatus: chatRuntime?.status });
  const imageBlock = imageInputBlock({ isLocalQwen: localQwen, vision });
  // The projector is loaded with the model whenever the server will start with it.
  const projectorMiB = ['ready', 'starts_with_vision'].includes(vision?.state)
    ? CHAT_PROJECTOR_MIB
    : 0;
  const contextEstimate = estimateChatMemory(contextSize, { projectorMiB });
  async function attachImageFiles(files) {
    if (busy) {
      log.debug('chat.attachment.rejected', { reason: 'busy', fileCount: files.length });
      return;
    }
    if (imageBlock) {
      log.info('chat.attachment.rejected', {
        reason: 'vision_unavailable',
        fileCount: files.length,
      });
      setError(imageBlock);
      return;
    }
    setError('');
    const problem = await images.addFiles(files);
    if (problem) {
      log.warn('chat.attachment.rejected', { reason: 'add_failed', fileCount: files.length });
      setError(problem);
    } else {
      log.info('chat.attachment.accepted', { fileCount: files.length });
    }
  }
  function imageFilesFromTransfer(transfer) {
    return [...(transfer?.files || [])].filter((file) => file.type.startsWith('image/'));
  }
  const modelStatus = describeModelStatus({
    provider,
    isLocalQwen: localQwen,
    isOnline: modelOnline,
    runtimeStatus: chatRuntime?.status,
  });
  async function saveResponse(content, id, question = '') {
    setSavingMessage(id);
    setError('');
    try {
      const saved = await saveProjectText(project?.id, 'chat', content, {
        model: { name: model, id: provider },
        prompt: question,
        secondary: system,
        settings: {
          provider,
          temperature,
          max_tokens: maxTokens,
          context_size: contextSize,
        },
      });
      setStatus(`Saved to ${saved.path}`);
      log.info('chat.response.saved');
    } catch (reason) {
      log.warn('chat.response.save.failed', errorFields(reason));
      setError(reason.message);
    } finally {
      setSavingMessage(null);
    }
  }
  async function checkLocal(signal) {
    log.info('chat.model.load.requested', { contextSize, isSpeculative: speculative });
    const r = await fetch('/api/runtime/models/chat/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
      body: JSON.stringify({ speculative, contextSize }),
      signal,
    });
    const data = await readRuntimeResponse(r);
    if (['insufficient_host_memory', 'insufficient_gpu_memory'].includes(data.code)) {
      setMemoryConflict(data);
      log.info('chat.model.load.waiting', { reason: data.code });
      setStatus('Waiting for memory to start Qwen.');
      return false;
    }
    if (!r.ok) {
      throw Error(data.error || data.message || 'Could not start Qwen.');
    }
    setMemoryConflict(null);
    if (Number.isSafeInteger(data.contextSize)) {
      setChatRuntime({ managed: true, contextSize: data.contextSize, status: 'reachable' });
    }
    setStatus(data.message || 'Qwen is starting.');
    const pending = pendingMemory.current;
    if (pending) {
      pendingMemory.current = null;
      pending.resolve();
    }
    return true;
  }
  async function waitForMemory(signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        pendingMemory.current = null;
        setMemoryConflict(null);
        reject(new DOMException('Message cancelled.', 'AbortError'));
      };
      if (signal.aborted) {
        return cancel();
      }
      pendingMemory.current = {
        signal,
        resolve: () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        },
        reject: () => {
          signal.removeEventListener('abort', cancel);
          cancel();
        },
      };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  function closeMemory() {
    const pending = pendingMemory.current;
    if (pending) {
      pending.reject();
    } else {
      setMemoryConflict(null);
    }
    setStatus('');
    setMemoryError('');
  }
  async function startLocal() {
    setError('');
    setMemoryError('');
    setMemoryWorking(true);
    setStatus('Checking GPU and system memory...');
    try {
      await checkLocal(pendingMemory.current?.signal);
    } catch (e) {
      if (e.name === 'AbortError') {
        log.debug('chat.model.load.aborted');
        return;
      }
      log.warn('chat.model.load.failed', errorFields(e));
      setStatus('');
      if (memoryConflict) {
        setMemoryError(e.message);
      } else {
        setError(e.message);
      }
    } finally {
      setMemoryWorking(false);
    }
  }
  async function offloadForChat(id) {
    const signal = pendingMemory.current?.signal;
    log.info('chat.model.offload.requested', { modelId: id });
    setMemoryWorking(true);
    setMemoryError('');
    try {
      const r = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const data = await readRuntimeResponse(r);
      if (!r.ok) {
        throw Error(data.error || data.message || 'Could not stop the service.');
      }
      if (signal?.aborted) {
        return;
      }
      await checkLocal(signal);
    } catch (e) {
      if (e.name !== 'AbortError') {
        log.warn('chat.model.offload.failed', { ...errorFields(e), modelId: id });
        setMemoryError(e.message);
      } else {
        log.debug('chat.model.offload.aborted', { modelId: id });
      }
    } finally {
      setMemoryWorking(false);
    }
  }
  async function chatLoading(signal) {
    // log-coverage: ignore -- failed /api calls are already logged by app-log-install (http.request.failed)
    const r = await fetch('/api/runtime/health', { signal });
    if (!r.ok) {
      throw Error('Could not check the studio runtime.');
    }
    const data = await r.json();
    return data.modelLoadEngine === 'chat' && data.modelLoadBarrier !== 'idle';
  }
  function stopLocal() {
    setQwenStopPrompt(true);
  }
  async function forceStopLocal() {
    setQwenStopPrompt(false);
    setError('');
    log.info('chat.model.stop.requested');
    try {
      const r = await fetch('/api/runtime/models/chat/force-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmation: 'force-stop-engine' }),
      });
      const data = await readRuntimeResponse(r);
      if (!r.ok) {
        throw Error(data.error || 'Could not stop Qwen.');
      }
      setChatRuntime((current) => ({ ...current, status: 'stopped' }));
      setMemory(null);
      setStatus('');
      log.info('chat.model.stop.completed');
    } catch (e) {
      log.warn('chat.model.stop.failed', errorFields(e));
      setError(e.message);
    }
  }
  async function refreshModels() {
    setStatus('Connecting…');
    setError('');
    try {
      const data = await (await call('models', connection)).json();
      setModels(data.models);
      log.debug('chat.models.listed', { modelCount: data.models.length });
      if (data.models.length && !data.models.includes(model)) {
        setModel(data.models[0]);
      }
      setStatus(
        data.models.length
          ? `${data.models.length} models available`
          : 'Connected; no models returned',
      );
    } catch (e) {
      log.warn('chat.models.list.failed', errorFields(e));
      setStatus('');
      setError(e.message);
    }
  }
  async function send(e) {
    e.preventDefault();
    if (busy || controller.current || !prompt.trim() || !chat) {
      return;
    }
    let parsed;
    if (format === 'schema') {
      try {
        parsed = JSON.parse(schema);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw Error();
        }
      } catch {
        // The parse error would quote the schema text, so only a reason code is logged.
        log.warn('chat.send.rejected', { reason: 'invalid_schema' });
        setError('Enter a valid JSON schema object.');
        setSchemaOpen(true);
        return;
      }
    }
    const outputTokens = Number(maxTokens);
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 262144) {
      log.warn('chat.send.rejected', { reason: 'invalid_max_tokens' });
      setError('Maximum output tokens must be a whole number from 1 to 262,144.');
      return;
    }
    const temperatureValue = Number(temperature);
    if (
      temperature === '' ||
      !Number.isFinite(temperatureValue) ||
      temperatureValue < 0 ||
      temperatureValue > 2
    ) {
      log.warn('chat.send.rejected', { reason: 'invalid_temperature' });
      setError('Temperature must be a number from 0 to 2.');
      return;
    }
    if (Object.keys(samplingState.errors).length) {
      log.warn('chat.send.rejected', { reason: 'invalid_sampling' });
      setError(`Check Advanced sampling: ${Object.values(samplingState.errors)[0]}`);
      setOptionsOpen(true);
      setAdvancedOpen(true);
      return;
    }
    if (
      isStudioQwen({ ...connection, model }) &&
      contextLimit !== null &&
      outputTokens > contextLimit
    ) {
      log.warn('chat.send.rejected', { reason: 'exceeds_context', contextSize: contextLimit });
      setError(
        `Maximum output cannot exceed the ${contextLimit.toLocaleString()}-token context window. Leave room for your prompt and conversation too.`,
      );
      return;
    }

    const attached = images.attachments;
    if (attached.length && imageBlock) {
      log.warn('chat.send.rejected', {
        reason: 'vision_unavailable',
        imageCount: attached.length,
      });
      setError(imageBlock);
      return;
    }
    const content = prompt.trim(),
      id = chat.id,
      user = {
        role: 'user',
        content,
        ...(attached.length ? { images: attached.map(savedImageRecord) } : {}),
      },
      assistant = {
        role: 'assistant',
        content: '',
        reasoning: '',
        format,
        streamStatus: 'streaming',
      };
    const prior = chat.messages
      .filter((m) => m.content)
      .map(({ role, content }) => ({ role, content }));
    // Mirrors the server limits (150 messages including system, 100,000 characters each) so long
    // chats fail with a clear next step.
    if (
      prior.length + (system.trim() ? 1 : 0) + 1 > 150 ||
      [user, ...prior].some((m) => m.content.length > 100000)
    ) {
      log.warn('chat.send.rejected', { reason: 'too_long', messageCount: prior.length + 1 });
      setError(
        'This message or conversation is too long to send: up to 150 messages and 100,000 characters per message. Shorten the message or start a new conversation.',
      );
      return;
    }
    setError('');
    setStatus('');
    setAnnouncement('Preparing your response.');
    setBusy(true);
    followMessages.current = true;
    const ac = new AbortController();
    controller.current = ac;
    let submitted = false,
      metrics = null,
      malformedEventCount = 0;
    const startedAt = performance.now();
    const hasImages = attached.length > 0;
    const messageCount = prior.length + 1;
    log.info('chat.stream.started', {
      messageCount,
      hasImages,
      imageCount: attached.length,
      format,
      provider,
      isLocalModel: localQwen,
    });
    try {
      await ensureChatReady({
        connection,
        model,
        signal: ac.signal,
        onStatus: setStatus,
        probe: (signal) => call('models', connection, signal),
        isLoading: chatLoading,
        start: async (signal) => {
          if (!(await checkLocal(signal))) {
            await waitForMemory(signal);
          }
        },
      });
      if (ac.signal.aborted) {
        throw new DOMException('Message cancelled.', 'AbortError');
      }
      setStatus('');
      setPrompt((value) => (value.trim() === content ? '' : value));
      images.clear();
      updateChat(id, (c) => ({
        ...c,
        title: c.messages.length || c.titleLocked ? c.title : content.slice(0, 52),
        messages: [...c.messages, user, assistant],
      }));
      submitted = true;
      setAnnouncement('Generating response.');
      metrics = createResponseMetrics(performance.now());
      const r = await call(
        'completions',
        {
          ...connection,
          model,
          format,
          schema: parsed,
          effort,
          temperature: Number(temperature),
          maxTokens: outputTokens,
          ...samplingState.options,
          messages: [
            ...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
            ...prior,
            {
              role: 'user',
              content,
              ...(attached.length ? { images: attached.map((image) => image.dataUrl) } : {}),
            },
          ],
        },
        ac.signal,
      );
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '',
        doneEvent = false;
      const processEvent = (event) => {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            doneEvent = true;
            continue;
          }
          if (!data) {
            continue;
          }
          let part;
          try {
            part = JSON.parse(data);
          } catch {
            // Counted for the finish record; trace keeps a per-event line off by default.
            malformedEventCount += 1;
            log.trace('chat.stream.event.malformed', { count: malformedEventCount });
            continue;
          }
          if (part.error) {
            throw Error(part.error.message || 'The server stopped the response.');
          }
          metrics.observe(part, performance.now());
          const delta = part.choices?.[0]?.delta || {},
            text = typeof delta.content === 'string' ? delta.content : '',
            reason =
              typeof delta.reasoning_content === 'string'
                ? delta.reasoning_content
                : typeof delta.reasoning === 'string'
                  ? delta.reasoning
                  : '';
          if (text || reason) {
            updateChat(id, (c) => {
              const m = [...c.messages],
                last = m.length - 1;
              m[last] = {
                ...m[last],
                content: m[last].content + text,
                reasoning: (m[last].reasoning || '') + reason,
              };
              return { ...c, messages: m };
            });
          }
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        for (const event of parts) {
          processEvent(event);
        }
        if (done) {
          if (buffer.trim()) {
            processEvent(buffer);
          }
          break;
        }
      }
      if (!doneEvent) {
        throw Error('The connection ended before the response finished.');
      }
      updateChat(id, (c) => {
        const messages = [...c.messages],
          last = messages.length - 1;
        if (messages[last]?.role === 'assistant') {
          messages[last] = {
            ...messages[last],
            streamStatus: 'complete',
            metrics: metrics.finish(),
          };
        }
        return { ...c, messages };
      });
      setAnnouncement('Response complete.');
      log.info('chat.stream.completed', {
        durationMs: Math.round(performance.now() - startedAt),
        messageCount,
        hasImages,
        malformedEventCount,
      });
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (err.name === 'AbortError') {
        log.info('chat.stream.aborted', {
          durationMs,
          messageCount,
          hasImages,
          malformedEventCount,
          reason: submitted ? 'stopped_while_streaming' : 'cancelled_before_send',
        });
      } else {
        log.error('chat.stream.failed', {
          ...errorFields(err),
          durationMs,
          messageCount,
          hasImages,
          malformedEventCount,
          phase: submitted ? 'streaming' : 'preparing',
        });
      }
      if (submitted) {
        updateChat(id, (c) => {
          const messages = [...c.messages],
            last = messages.length - 1;
          if (messages[last]?.role === 'assistant') {
            messages[last] = {
              ...messages[last],
              streamStatus: err.name === 'AbortError' ? 'stopped' : 'failed',
              metrics: metrics?.finish(),
            };
          }
          return { ...c, messages };
        });
      }
      if (err.name === 'AbortError') {
        setStatus(
          submitted
            ? 'Generation stopped.'
            : 'Message not sent; your draft is still in the composer.',
        );
        setAnnouncement(submitted ? 'Generation stopped.' : 'Message not sent.');
      } else {
        setStatus('');
        setError(err.message || 'Could not generate a response.');
        setAnnouncement(submitted ? 'Response failed.' : 'Message failed to send.');
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }
  return (
    <div className="chat-page">
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      <div className="chat-titlebar">
        <div>
          <div className="overline">
            <span className="overline-line" /> GAME WRITING
          </div>
          <h1>
            Chat<em>.</em>
          </h1>
          <p className="lead">
            Develop ideas, write dialogue, and shape game data
            {project?.name ? ` for ${project.name}` : ''}.
          </p>
        </div>
      </div>
      <div className={'chat-workspace ' + (settings ? 'settings-open' : '')}>
        <aside
          id="chat-history-body"
          className={'chat-history' + (historyOpen ? ' is-open' : '')}
          aria-label="Conversations"
        >
          <div className="chat-history-title">
            <div>
              <strong>Conversations</strong>
              <span>{project?.name || 'No project selected'}</span>
            </div>
            <button
              type="button"
              className="chat-history-toggle"
              aria-expanded={historyOpen}
              aria-controls="chat-history-body"
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {historyOpen ? 'Hide' : 'Show'}
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          <button className="chat-new" onClick={newChat} disabled={busy}>
            <MessageSquarePlus size={18} /> <span>New conversation</span>
          </button>
          <div className="chat-history-list">
            {chats.map((c) => (
              <div
                className={'chat-history-item ' + (c.id === chat?.id ? 'selected' : '')}
                key={c.id}
              >
                {renaming?.id === c.id ? (
                  <form
                    className="chat-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      commitRename();
                    }}
                  >
                    <input
                      aria-label={`Conversation name for ${c.title}`}
                      value={renaming.value}
                      maxLength={80}
                      autoFocus
                      onChange={(event) => setRenaming({ id: c.id, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelRename(c.id);
                        }
                      }}
                      onBlur={commitRename}
                    />
                  </form>
                ) : (
                  <button
                    className="chat-history-select"
                    onClick={() => {
                      followMessages.current = true;
                      setActive(c.id);
                      setHistoryOpen(false);
                    }}
                    disabled={busy}
                  >
                    <span>{c.title}</span>
                    <small>{c.messages.length ? exchangeCountLabel(c.messages) : 'Draft'}</small>
                  </button>
                )}
                <button
                  className="chat-delete"
                  data-rename-for={c.id}
                  title="Rename conversation"
                  aria-label={`Rename ${c.title}`}
                  onClick={() => {
                    renameCancelled.current = false;
                    setRenaming({ id: c.id, value: c.title });
                  }}
                  disabled={busy}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="chat-delete"
                  title="Delete conversation"
                  aria-label={`Delete ${c.title}`}
                  onClick={() => {
                    if (window.confirm('Delete this conversation from this browser?')) {
                      deleteChat(c.id);
                    }
                  }}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <p className="chat-history-note">Saved in this browser for the selected project.</p>
        </aside>
        <section className="chat-main">
          <div className="chat-bar">
            <div className="chat-conversation-heading">
              <span>Conversation</span>
              <strong>{chat?.title || 'New conversation'}</strong>
            </div>
            <button
              className="chat-model-selector"
              type="button"
              onClick={() => setSettings(true)}
              aria-expanded={settings}
              aria-controls="chat-configuration"
              title="Change model or connection settings"
              aria-label={`Model and connection settings: ${model || 'choose a model'}, ${modelStatus}`}
            >
              <span className="chat-model-icon">
                <Cpu size={18} />
              </span>
              <span className="chat-model-label">
                <strong>{model || 'Choose a model'}</strong>
                <small>
                  <i className={'chat-model-state ' + (modelOnline ? 'online' : '')} />
                  {modelStatus}
                </small>
              </span>
              <Settings2 size={17} />
            </button>
          </div>
          <div
            ref={messageViewport}
            className="chat-messages"
            onScroll={(e) => {
              const node = e.currentTarget;
              followMessages.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
            }}
          >
            {!chat?.messages.length ? (
              <div className="chat-welcome">
                <div className="chat-welcome-mark">
                  <Bot size={25} />
                </div>
                <h2>Start with an idea.</h2>
                <p>Ask about your game, develop a character, or create structured data.</p>
                <div className="chat-suggestions">
                  {[
                    'Brainstorm a game mechanic',
                    'Build a character backstory',
                    'Create item data as JSON',
                  ].map((t) => (
                    <button
                      type="button"
                      key={t}
                      onClick={() => {
                        setPrompt(t);
                        composerRef.current?.focus();
                      }}
                    >
                      {t}
                      <span>↗</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chat-message-list">
                {chat.messages.map((m, i) => {
                  const structured = m.role === 'assistant' && isStructuredJsonFormat(m.format),
                    syntax = structured ? checkJsonSyntax(m.content, m.streamStatus) : null,
                    markdownReady =
                      m.role === 'assistant' &&
                      !structured &&
                      m.content &&
                      m.streamStatus !== 'streaming' &&
                      m.streamStatus !== 'failed' &&
                      m.streamStatus !== 'stopped';
                  const syntaxLabel = structuredSyntaxLabel(syntax, m.format);
                  const canRetry =
                    m.role === 'assistant' &&
                    !busy &&
                    chat.messages[i - 1]?.role === 'user' &&
                    (m.streamStatus === 'failed' ||
                      m.streamStatus === 'stopped' ||
                      m.streamStatus === 'interrupted' ||
                      !m.content);
                  return (
                    <article className={'chat-message ' + m.role} key={i}>
                      <div className="chat-message-avatar">
                        {m.role === 'user' ? 'Y' : <Bot size={17} />}
                      </div>
                      <div className="chat-message-body">
                        <div className="chat-message-heading">
                          <strong>{m.role === 'user' ? 'You' : 'Assistant'}</strong>
                          {m.content && (
                            <div className="chat-message-actions">
                              {m.role === 'assistant' && (
                                <button
                                  onClick={() =>
                                    saveResponse(
                                      m.content,
                                      `${chat.id}:${i}`,
                                      chat.messages[i - 1]?.role === 'user'
                                        ? chat.messages[i - 1].content
                                        : '',
                                    )
                                  }
                                  disabled={!project || !!savingMessage}
                                  title={
                                    !project
                                      ? 'Choose a project to save this response'
                                      : 'Save response to project'
                                  }
                                >
                                  {savingMessage === `${chat.id}:${i}`
                                    ? 'Saving…'
                                    : 'Save to project'}
                                </button>
                              )}
                              <button
                                onClick={() => copy(m.content, `m${i}`)}
                                aria-label="Copy message"
                                title="Copy message"
                              >
                                {copied === `m${i}` ? <Check size={15} /> : <Copy size={15} />}
                              </button>
                            </div>
                          )}
                        </div>
                        {m.reasoning && (
                          <details className="chat-reasoning">
                            <summary>Thinking</summary>
                            <pre>{m.reasoning}</pre>
                          </details>
                        )}
                        {structured && (
                          <p
                            className={
                              'chat-structured-status ' +
                              (syntax === 'valid' ? 'valid' : syntax === 'invalid' ? 'invalid' : '')
                            }
                          >
                            {syntaxLabel}
                          </p>
                        )}
                        {m.role === 'assistant' && m.streamStatus === 'interrupted' && (
                          <p className="chat-structured-status">
                            Response interrupted when this conversation was closed. Reuse the prompt
                            to try again.
                          </p>
                        )}
                        {m.role === 'user' && m.images?.length > 0 && (
                          <ul
                            className="chat-message-images"
                            aria-label={`${m.images.length} attached ${m.images.length === 1 ? 'picture' : 'pictures'}`}
                          >
                            {m.images.map((image, n) => (
                              <li key={n}>
                                <figure>
                                  {image.thumb ? (
                                    <img
                                      src={image.thumb}
                                      alt={`Attached picture ${n + 1}: ${image.name}`}
                                    />
                                  ) : (
                                    <div className="chat-message-images-missing">No preview</div>
                                  )}
                                  <figcaption title={image.name}>{image.name}</figcaption>
                                </figure>
                              </li>
                            ))}
                          </ul>
                        )}
                        <div className="chat-message-content">
                          {markdownReady ? (
                            <ChatMarkdown content={m.content} />
                          ) : structured && m.content ? (
                            <pre
                              className="chat-structured-output"
                              tabIndex={0}
                              aria-label="JSON response. Scroll to read the full output."
                            >
                              <code>{m.content}</code>
                            </pre>
                          ) : (
                            m.content ||
                            (busy && i === chat.messages.length - 1
                              ? 'Thinking…'
                              : 'No response was generated.')
                          )}
                        </div>
                        {m.role === 'assistant' && m.streamStatus !== 'streaming' && (
                          <ResponseMetrics metrics={m.metrics} />
                        )}
                        {canRetry && (
                          <button
                            type="button"
                            className="chat-retry-draft"
                            onClick={() => {
                              setPrompt(chat.messages[i - 1].content);
                              composerRef.current?.focus();
                            }}
                          >
                            {m.streamStatus === 'failed' ||
                            m.streamStatus === 'stopped' ||
                            m.streamStatus === 'interrupted'
                              ? 'Reuse prompt'
                              : 'Use previous message'}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
          {error && (
            <div className="chat-error" role="alert">
              <span>{error}</span>
              <button onClick={() => copy(error, 'error')}>
                {copied === 'error' ? 'Copied' : 'Copy error'}
              </button>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          <div className="chat-composer-wrap">
            {schemaOpen && format === 'schema' && (
              <div className="chat-schema-editor">
                <div>
                  <strong>JSON schema</strong>
                  <span>Used to constrain the next response.</span>
                </div>
                <textarea
                  aria-label="JSON schema"
                  value={schema}
                  onChange={(e) => setSchema(e.target.value)}
                  spellCheck="false"
                />
                <p>Strict schema support varies by model and server. Errors are shown above.</p>
              </div>
            )}
            <form
              className={'chat-composer' + (isDropping ? ' is-dropping' : '')}
              onSubmit={send}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes('Files')) {
                  e.preventDefault();
                  setIsDropping(true);
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                  setIsDropping(false);
                }
              }}
              onDrop={(e) => {
                setIsDropping(false);
                const files = imageFilesFromTransfer(e.dataTransfer);
                if (files.length) {
                  e.preventDefault();
                  attachImageFiles(files);
                }
              }}
            >
              <ChatImageTray
                attachments={images.attachments}
                onRemove={images.remove}
                disabled={busy}
              />
              <textarea
                ref={composerRef}
                aria-label="Message"
                placeholder="Ask about your game…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onPaste={(e) => {
                  const files = imageFilesFromTransfer(e.clipboardData);
                  if (files.length) {
                    e.preventDefault();
                    attachImageFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && busy && controller.current) {
                    e.preventDefault();
                    controller.current.abort();
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <ChatImageButtons
                attachments={images.attachments}
                preparing={images.preparing}
                blockedReason={imageBlock}
                busy={busy}
                project={project}
                onFiles={attachImageFiles}
                onProblem={setError}
              />
              <div className="chat-composer-footer">
                <details
                  className="chat-options"
                  open={optionsOpen}
                  onToggle={(e) => setOptionsOpen(e.currentTarget.open)}
                >
                  <summary>
                    <span>Options</span>
                    <small title={optionSummary}>{optionSummary}</small>
                    <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div
                    className="chat-quick-controls"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <label>
                      Response
                      <select
                        value={format}
                        onChange={(e) => {
                          setFormat(e.target.value);
                          if (e.target.value === 'schema') {
                            setSchemaOpen(true);
                          }
                        }}
                      >
                        <option value="text">Text</option>
                        <option value="json">JSON object</option>
                        <option value="schema">JSON schema</option>
                      </select>
                    </label>
                    {format === 'json' && (
                      <p className="chat-option-hint">
                        Also ask for JSON in your message. OpenAI requires the word “JSON” in the
                        prompt.
                      </p>
                    )}
                    <label>
                      Thinking
                      <select
                        value={effort}
                        onChange={(e) => {
                          setEffort(e.target.value);
                          log.info('chat.options.changed', {
                            settingKey: 'thinking',
                            mode: e.target.value,
                          });
                        }}
                      >
                        <option value="auto">Model default</option>
                        <option value="none">Off</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                    <label>
                      Max output tokens
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max="262144"
                        step="1"
                        value={maxTokens}
                        onChange={(e) => setMaxTokens(e.target.value)}
                        title="Whole number from 1 to 262,144"
                      />
                    </label>
                    {format === 'schema' && (
                      <button
                        type="button"
                        className="chat-schema-toggle"
                        onClick={() => setSchemaOpen(!schemaOpen)}
                        aria-expanded={schemaOpen}
                      >
                        <Braces size={15} /> {schemaOpen ? 'Hide schema' : 'Edit schema'}
                      </button>
                    )}
                    {resetArmed ? (
                      <span className="reset-confirm" role="group" aria-label="Confirm reset">
                        <span>Reset chat options?</span>
                        <button
                          type="button"
                          className="text-action danger"
                          onClick={resetOptions}
                          autoFocus
                        >
                          Yes, reset
                        </button>
                        <button
                          type="button"
                          className="text-action"
                          onClick={() => setResetArmed(false)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="text-action reset-defaults"
                        disabled={!optionsDirty}
                        title={
                          optionsDirty
                            ? 'Restore every chat option to its default'
                            : 'Nothing to reset: chat options are at their defaults'
                        }
                        onClick={() => setResetArmed(true)}
                      >
                        <RotateCcw size={14} aria-hidden="true" /> Reset to defaults
                      </button>
                    )}
                  </div>
                </details>
                {busy ? (
                  <button
                    type="button"
                    className="chat-send"
                    onClick={() => controller.current?.abort()}
                    aria-label="Stop generation"
                  >
                    <Square size={16} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="chat-send"
                    disabled={!prompt.trim() || !model}
                    aria-label="Send message"
                    title={
                      !prompt.trim()
                        ? 'Enter a message to send'
                        : !model
                          ? 'Choose a model to send'
                          : 'Send message'
                    }
                  >
                    <ArrowUp size={18} />
                    <span>Send</span>
                  </button>
                )}
              </div>
            </form>
            <div className="chat-footnote">
              <span role="status" aria-live="polite" aria-atomic="true">
                {busy
                  ? status || 'Generating response. Press Stop or Esc to cancel.'
                  : status || 'Enter to send · Shift + Enter for a new line'}
              </span>
              {localQwen && !modelOnline && !busy && chatRuntime?.status !== 'starting' && (
                <span className="chat-start-note">
                  Qwen is not running. Sending starts it on the GPU after a memory check, which can
                  take a few minutes; it stays loaded until you stop it.
                </span>
              )}
              {memory && provider === 'compatible' && modelOnline && (
                <span>{memory.freeMemoryGiB} GiB system memory free</span>
              )}
            </div>
          </div>
        </section>
        {memoryConflict && (
          <MemoryDialog
            target="Qwen"
            conflict={memoryConflict}
            onClose={closeMemory}
            onRetry={startLocal}
            onOffload={offloadForChat}
            working={memoryWorking}
            error={memoryError}
          />
        )}
        {settings && (
          <>
            <button
              type="button"
              className="chat-config-backdrop"
              tabIndex={-1}
              aria-hidden="true"
              onClick={() => setSettings(false)}
            />
            <aside
              id="chat-configuration"
              ref={configRef}
              className="chat-config"
              role={compactSettings ? 'dialog' : undefined}
              aria-modal={compactSettings ? true : undefined}
              aria-label="Connection and model settings"
              tabIndex={-1}
            >
              <div className="chat-config-heading">
                <div>
                  <h2>Connection &amp; model</h2>
                  <p>Choose where your assistant runs.</p>
                </div>
                <button aria-label="Close settings" onClick={() => setSettings(false)}>
                  <X size={19} />
                </button>
              </div>
              <label>
                Provider
                <select
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setModels([]);
                    setModel(e.target.value === 'openai' ? 'gpt-4.1-mini' : 'qwen3.8-27b');
                    setStatus('');
                  }}
                >
                  <option value="compatible">Local / compatible server</option>
                  <option value="openai">OpenAI API</option>
                </select>
              </label>
              {provider === 'compatible' ? (
                <>
                  <label>
                    Server address
                    <input
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      spellCheck="false"
                    />
                  </label>
                  <p className="chat-help">
                    Use localhost or a private IPv4 address, such as http://127.0.0.1:8098/v1.
                  </p>
                  <div className="chat-local-engine">
                    <div className="chat-engine-title">
                      <Zap size={17} />
                      <strong>Local Qwen GPU engine</strong>
                    </div>
                    <label>
                      Context size
                      <select
                        value={contextSize}
                        disabled={busy || memoryWorking}
                        onChange={(e) => setContextSize(Number(e.target.value))}
                      >
                        {CHAT_CONTEXT_SIZES.map((size) => (
                          <option value={size} key={size}>
                            {size.toLocaleString()} tokens
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="chat-context-estimate" aria-live="polite">
                      <span>Estimated GPU memory</span>
                      <strong>
                        ~{(contextEstimate.estimatedGpuMiB / 1024).toFixed(1)} GiB total
                      </strong>
                      <small>
                        ~{(contextEstimate.contextMiB / 1024).toFixed(1)} GiB for the context cache
                        {projectorMiB
                          ? ` and ~${(projectorMiB / 1024).toFixed(1)} GiB for the vision projector`
                          : ''}
                        . Rough estimate; actual usage varies.
                      </small>
                    </div>
                    <p className="chat-help">
                      {actualContext
                        ? `Currently running with ${actualContext.toLocaleString()} tokens. ${actualContext !== contextSize ? 'Stop and restart Qwen to use the selected size.' : 'Matches the selected size.'}`
                        : chatRuntime?.status === 'reachable'
                          ? 'An externally managed server controls its own context size.'
                          : 'Applied when the local Qwen server starts.'}{' '}
                      Prompt, conversation, thinking, and output share the context window.
                    </p>
                    <label className="chat-spec-toggle">
                      <span>
                        <strong>Speculative decoding</strong>
                        <small>Use the model’s MTP head.</small>
                      </span>
                      <input
                        type="checkbox"
                        checked={speculative}
                        onChange={(e) => setSpeculative(e.target.checked)}
                      />
                    </label>
                    <p>
                      Requested when Qwen starts. Stop and restart Qwen to change it. Whether the
                      MTP head is active has not been verified yet.
                    </p>
                    <div className="chat-engine-actions">
                      <button className="chat-start" disabled={memoryWorking} onClick={startLocal}>
                        Start Qwen on GPU
                      </button>
                      <button className="chat-stop" onClick={stopLocal}>
                        Force stop
                      </button>
                    </div>
                  </div>
                  <p className="chat-help">
                    The local engine uses port 8098. Other compatible servers manage their own GPU
                    and decoding settings.
                  </p>
                </>
              ) : (
                <>
                  <label>
                    OpenAI API key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoComplete="off"
                      placeholder="API key or server environment"
                    />
                  </label>
                  <p className="chat-help">
                    Use a saved key from Studio settings, enter a temporary key here, or set
                    OPENAI_API_KEY on the server. Temporary keys stay in this page’s memory.
                  </p>
                </>
              )}
              <div className="chat-field">
                <label htmlFor="chat-model-id">Model ID</label>
                <div className="chat-model-input">
                  <input
                    id="chat-model-id"
                    list="chat-models"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="Model ID"
                  />
                  <datalist id="chat-models">
                    {models.map((m) => (
                      <option value={m} key={m} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={refreshModels}
                    title="Find available models"
                    aria-label="Find available models"
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </div>
              <p className="chat-help">Refresh to discover models or enter a model ID.</p>
              <details className="chat-advanced" {...routeDetails(advancedOpen, setAdvancedOpen)}>
                <summary>
                  Advanced settings <ChevronDown size={16} />
                </summary>
                <label>
                  System instructions
                  <textarea value={system} onChange={(e) => setSystem(e.target.value)} />
                </label>
                <p className="chat-help">
                  Sent as a system message with each request. Leave blank for none.
                </p>
                <label>
                  Temperature
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="2"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                  />
                </label>
                <p className="chat-help">
                  From 0 to 2. Lower is more predictable; higher is more varied.
                </p>
                <fieldset className="chat-sampling">
                  <legend>Advanced sampling</legend>
                  <p className="chat-help">
                    Leave a field blank to use the server default. Top-k and min-p are sent only to
                    local and compatible servers.
                  </p>
                  {SAMPLING_FIELDS.map((field) => {
                    const inputId = `chat-sampling-${field.key}`;
                    const helpId = `${inputId}-help`;
                    const errorId = `${inputId}-error`;
                    const fieldError = samplingState.errors[field.key];
                    const describedBy = fieldError ? `${helpId} ${errorId}` : helpId;
                    const onChange = (event) =>
                      setSampling((previous) => ({
                        ...previous,
                        [field.key]: event.target.value,
                      }));
                    return (
                      <div className="chat-sampling-field" key={field.key}>
                        <label htmlFor={inputId}>{field.label}</label>
                        {field.key === 'stop' ? (
                          <textarea
                            id={inputId}
                            rows={2}
                            value={sampling.stop}
                            onChange={onChange}
                            aria-invalid={fieldError ? 'true' : undefined}
                            aria-describedby={describedBy}
                            spellCheck="false"
                          />
                        ) : (
                          <input
                            id={inputId}
                            type="number"
                            inputMode="decimal"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={sampling[field.key]}
                            onChange={onChange}
                            aria-invalid={fieldError ? 'true' : undefined}
                            aria-describedby={describedBy}
                          />
                        )}
                        <small id={helpId} className="chat-help">
                          {field.help}
                        </small>
                        {fieldError && (
                          <p id={errorId} className="settings-error">
                            {fieldError}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              </details>
              <p className="chat-help">
                For local Qwen, Low, Medium and High set thinking budgets of 256, 768 and 1,536
                tokens. Other servers and models may ignore or reject these settings.
              </p>
              <div className="chat-memory-note">
                <Cpu size={17} />
                <span>
                  Qwen3.8-27B · Q4
                  <br />
                  <small>Estimates use the installed model and bundled CUDA engine.</small>
                </span>
              </div>
            </aside>
          </>
        )}
        {qwenStopPrompt && (
          <ConfirmDialog
            title="Force stop Qwen?"
            kicker="Local chat engine"
            confirmLabel="Force stop Qwen"
            busyLabel="Stopping Qwen…"
            tone="danger"
            onConfirm={forceStopLocal}
            onClose={() => {
              log.debug('chat.model.stop.declined');
              setQwenStopPrompt(false);
            }}
          >
            <p>
              Any active chat response will be interrupted. Forge stops the verified Qwen process.
            </p>
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}
