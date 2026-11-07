import MemoryDialog from './MemoryDialog';
import { ensureChatReady, isStudioQwen } from './chat-autostart';
import {
  CHAT_CONTEXT_SIZES,
  DEFAULT_CHAT_CONTEXT,
  estimateChatMemory,
} from '../runtime/chat-memory.js';
import { saveProjectText } from './save-project-text';
import { chatStorageKey } from './chat-project';
import { checkJsonSyntax, isStructuredJsonFormat } from './chat-output';
import { createResponseMetrics } from './chat-metrics';
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
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import './chat.css';
import './chat-desktop.css';

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
async function call(route, body, signal) {
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
    const x = JSON.parse(localStorage.getItem(key));
    return Array.isArray(x) && x.length ? x : [makeChat()];
  } catch {
    return [makeChat()];
  }
}
function savedNumber(key, fallback, valid) {
  try {
    const value = Number(localStorage.getItem(key));
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
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
  const key = chatStorageKey(project?.id);
  const [chats, setChats] = useState(() => readSaved(key));
  const [params, setParams] = useSearchParams();
  const active = params.get('conversation') || chats[0]?.id;
  const setActive = (id) => updateSearch(setParams, { conversation: id });
  const [prompt, setPrompt] = useState('');
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
  const [effort, setEffort] = useState('auto');
  const [speculative, setSpeculative] = useState(true);
  const [schemaOpen, setSchemaOpen] = useRouteToggle('schema');
  const [memoryConflict, setMemoryConflict] = useState(null);
  const [memoryError, setMemoryError] = useState('');
  const [memoryWorking, setMemoryWorking] = useState(false);
  const [settings, setSettings] = useRouteToggle('config');
  const [compactSettings, setCompactSettings] = useState(
    () => window.matchMedia('(min-width: 851px) and (max-width: 1599px)').matches,
  );
  const configRef = useRef(null),
    closeSettingsRef = useRef(null);
  closeSettingsRef.current = () => setSettings(false);
  const [advancedOpen, setAdvancedOpen] = useRouteToggle('chatAdvanced');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [memory, setMemory] = useState(null);
  const [savingMessage, setSavingMessage] = useState(null);
  const controller = useRef(null);
  const pendingMemory = useRef(null);
  const messageViewport = useRef(null),
    followMessages = useRef(true),
    composerRef = useRef(null);
  const chat = chats.find((c) => c.id === active) || chats[0];
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(chats));
    } catch {
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
    call('status', {})
      .then((r) => r.json())
      .then(setMemory)
      .catch(() => {});
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('forge-chat-context-v1', String(contextSize));
      const n = Number(maxTokens);
      if (Number.isSafeInteger(n) && n >= 1 && n <= 262144) {
        localStorage.setItem('forge-chat-max-output-v1', String(n));
      }
    } catch {
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
      } catch {
        // Runtime status is refreshed on the next interval.
      }
    }
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const contextEstimate = estimateChatMemory(contextSize);
  const actualContext =
    chatRuntime?.managed && Number.isSafeInteger(chatRuntime.contextSize)
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
  }
  async function copy(value, id) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      setError('Clipboard unavailable. Select and copy the text manually.');
    }
  }
  const connection = { provider, endpoint, apiKey };
  const localQwen = isStudioQwen({ ...connection, model });
  const modelOnline = localQwen && chatRuntime?.status === 'reachable';
  const modelStatus =
    provider === 'openai'
      ? 'OpenAI API · not checked'
      : localQwen
        ? modelOnline
          ? 'Studio server online'
          : chatRuntime?.managed
            ? 'Starting'
            : 'Starts on send'
        : 'Compatible endpoint · not checked';
  async function saveResponse(content, id) {
    setSavingMessage(id);
    setError('');
    try {
      const saved = await saveProjectText(project?.id, 'chat', content);
      setStatus(`Saved to ${saved.path}`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setSavingMessage(null);
    }
  }
  async function checkLocal(signal) {
    const r = await fetch('/api/runtime/models/chat/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
      body: JSON.stringify({ speculative, contextSize }),
      signal,
    });
    const data = await r.json();
    if (['insufficient_host_memory', 'insufficient_gpu_memory'].includes(data.code)) {
      setMemoryConflict(data);
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
        return;
      }
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
    setMemoryWorking(true);
    setMemoryError('');
    try {
      const r = await fetch(`/api/runtime/models/${id}/offload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: '{}',
      });
      const data = await r.json();
      if (!r.ok) {
        throw Error(data.error || data.message || 'Could not stop the service.');
      }
      if (signal?.aborted) {
        return;
      }
      await checkLocal(signal);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMemoryError(e.message);
      }
    } finally {
      setMemoryWorking(false);
    }
  }
  async function chatLoading(signal) {
    const r = await fetch('/api/runtime/health', { signal });
    if (!r.ok) {
      throw Error('Could not check the studio runtime.');
    }
    const data = await r.json();
    return data.modelLoadEngine === 'chat' && data.modelLoadBarrier !== 'idle';
  }
  async function stopLocal() {
    if (
      !window.confirm('Force stop the Qwen server? Any active chat response will be interrupted.')
    ) {
      return;
    }
    setError('');
    try {
      const r = await fetch('/api/runtime/models/chat/force-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
        body: JSON.stringify({ confirmation: 'force-stop-engine' }),
      });
      const data = await r.json();
      if (!r.ok) {
        throw Error(data.error || 'Could not stop Qwen.');
      }
      setStatus('Qwen server stopped.');
    } catch (e) {
      setError(e.message);
    }
  }
  async function refreshModels() {
    setStatus('Connecting…');
    setError('');
    try {
      const data = await (await call('models', connection)).json();
      setModels(data.models);
      if (data.models.length && !data.models.includes(model)) {
        setModel(data.models[0]);
      }
      setStatus(
        data.models.length
          ? `${data.models.length} models available`
          : 'Connected; no models returned',
      );
    } catch (e) {
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
        setError('Enter a valid JSON schema object.');
        setSchemaOpen(true);
        return;
      }
    }
    const outputTokens = Number(maxTokens);
    if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 262144) {
      setError('Maximum output tokens must be a whole number from 1 to 262,144.');
      return;
    }
    if (
      isStudioQwen({ ...connection, model }) &&
      contextLimit !== null &&
      outputTokens > contextLimit
    ) {
      setError(
        `Maximum output cannot exceed the ${contextLimit.toLocaleString()}-token context window. Leave room for your prompt and conversation too.`,
      );
      return;
    }

    const content = prompt.trim(),
      id = chat.id,
      user = { role: 'user', content },
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
    setError('');
    setStatus('');
    setAnnouncement('Preparing your response.');
    setBusy(true);
    followMessages.current = true;
    const ac = new AbortController();
    controller.current = ac;
    let submitted = false,
      metrics = null;
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
      updateChat(id, (c) => ({
        ...c,
        title: c.messages.length ? c.title : content.slice(0, 52),
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
          messages: [
            ...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
            ...prior,
            user,
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
    } catch (err) {
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
          <h1>Chat</h1>
          <p>
            Develop ideas, write dialogue, and shape game data
            {project?.name ? ` for ${project.name}` : ''}.
          </p>
        </div>
      </div>
      <div className={'chat-workspace ' + (settings ? 'settings-open' : '')}>
        <aside className="chat-history" aria-label="Conversations">
          <div className="chat-history-title">
            <div>
              <strong>Conversations</strong>
              <span>{project?.name || 'No project selected'}</span>
            </div>
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
                <button
                  className="chat-history-select"
                  onClick={() => {
                    followMessages.current = true;
                    setActive(c.id);
                  }}
                  disabled={busy}
                >
                  <span>{c.title}</span>
                  <small>
                    {c.messages.length
                      ? `${c.messages.filter((message) => message.role === 'user').length} ${c.messages.filter((message) => message.role === 'user').length === 1 ? 'exchange' : 'exchanges'}`
                      : 'Draft'}
                  </small>
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
                    <button type="button" key={t} onClick={() => setPrompt(t)}>
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
                  const syntaxLabel =
                    syntax === 'valid'
                      ? m.format === 'schema'
                        ? 'Valid JSON syntax · schema conformance not checked.'
                        : 'Valid JSON syntax.'
                      : syntax === 'invalid'
                        ? m.format === 'schema'
                          ? 'Invalid JSON syntax · schema conformance not checked.'
                          : 'Invalid JSON syntax.'
                        : syntax === 'empty'
                          ? 'No JSON content to check.'
                          : 'JSON syntax not checked · response incomplete.';
                  const canRetry =
                    m.role === 'assistant' &&
                    !busy &&
                    chat.messages[i - 1]?.role === 'user' &&
                    (m.streamStatus === 'failed' || m.streamStatus === 'stopped' || !m.content);
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
                                  onClick={() => saveResponse(m.content, `${chat.id}:${i}`)}
                                  disabled={!project || !!savingMessage}
                                  title={
                                    !project
                                      ? 'Choose a project to save this response'
                                      : 'Save response to project'
                                  }
                                >
                                  {savingMessage === `${chat.id}:${i}` ? 'Saving…' : 'Save'}
                                </button>
                              )}
                              <button
                                onClick={() => copy(m.content, `m${i}`)}
                                aria-label="Copy message"
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
                            {m.streamStatus === 'failed' || m.streamStatus === 'stopped'
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
            <form className="chat-composer" onSubmit={send}>
              <textarea
                ref={composerRef}
                aria-label="Message"
                placeholder="Ask about your game…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form.requestSubmit();
                  }
                }}
              />
              <div className="chat-composer-footer">
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
                  <label>
                    Thinking
                    <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                      <option value="auto">Model default</option>
                      <option value="none">Off</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                  <label>
                    Max output
                    <input
                      type="number"
                      min="1"
                      max="262144"
                      step="1"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(e.target.value)}
                      aria-label="Max output tokens"
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
                </div>
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
                  >
                    <ArrowUp size={18} />
                    <span>Send</span>
                  </button>
                )}
              </div>
            </form>
            <div className="chat-footnote">
              <span role="status">{status || 'Enter to send · Shift + Enter for a new line'}</span>
              {memory && provider === 'compatible' && (
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
                        ~{(contextEstimate.contextMiB / 1024).toFixed(1)} GiB for the context cache.
                        Rough estimate; actual usage varies.
                      </small>
                    </div>
                    <p className="chat-help">
                      {actualContext
                        ? `Currently running with ${actualContext.toLocaleString()} tokens. ${actualContext !== contextSize ? 'Stop and restart Qwen to apply the selected size.' : 'Changes apply on restart.'}`
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
                      Applied when Qwen starts. Stop and restart to change it. Activation has not
                      been verified yet.
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
              <label>
                Model ID
                <div className="chat-model-input">
                  <input
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
                    onClick={refreshModels}
                    title="Find available models"
                    aria-label="Find available models"
                  >
                    <RefreshCw size={16} />
                  </button>
                </div>
              </label>
              <p className="chat-help">
                {status || 'Refresh to discover models or enter a model ID.'}
              </p>
              <details className="chat-advanced" {...routeDetails(advancedOpen, setAdvancedOpen)}>
                <summary>
                  Advanced settings <ChevronDown size={16} />
                </summary>
                <label>
                  System instructions
                  <textarea value={system} onChange={(e) => setSystem(e.target.value)} />
                </label>
                <label>
                  Temperature
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                  />
                </label>
              </details>
              <p className="chat-help">
                For local Qwen, thinking levels set token budgets. Other models may support
                different effort levels.
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
      </div>
    </div>
  );
}
