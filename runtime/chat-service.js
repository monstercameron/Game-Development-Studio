import { credentialStore } from './credentials.js';
import { Readable } from 'node:stream';
import os from 'node:os';
import { parseChatSampling } from './chat-sampling.js';
import { buildImageMessages } from './chat-images.js';
import { MAX_CHAT_IMAGE_REQUEST_CHARS } from './chat-image-limits.js';
import { chatProjectorExists, readServerVision } from './chat-vision.js';
import { createLogger } from './app-log.js';

const log = createLogger('chat');

// A text-only request stays small; a request that carries pictures may be much larger.
const MAX_CHAT_TEXT_REQUEST_CHARS = 1000000;

const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
function destination(input) {
  if (input.provider === 'openai') {
    return new URL('https://api.openai.com/v1/');
  }
  if (input.provider === 'lmstudio') {
    return new URL('http://127.0.0.1:1234/v1/');
  }
  if (input.provider !== 'compatible') {
    throw Error('Choose a supported connection.');
  }
  let u;
  try {
    u = new URL(input.endpoint);
  } catch {
    throw Error('Enter a valid compatible server URL.');
  }
  const h = u.hostname.toLowerCase(),
    parts = h.split('.').map(Number);
  const privateV4 =
    parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 127 ||
      parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(h === 'localhost' || privateV4)
  ) {
    throw Error('Use localhost or a private IPv4 address for compatible servers.');
  }
  u.pathname = u.pathname.replace(/\/+$/, '') + '/';
  return u;
}
// The studio's own llama.cpp server. Only it receives pictures and llama.cpp-only fields.
function isStudioEngine(input, target) {
  return (
    input.provider === 'compatible' && target.hostname === '127.0.0.1' && target.port === '8098'
  );
}
function hasImages(input) {
  return (
    Array.isArray(input.messages) &&
    input.messages.some((m) => m !== null && typeof m === 'object' && m.images !== undefined)
  );
}
function sanitize(message, key) {
  return String(message || 'Request failed.')
    .slice(0, 1600)
    .split(key || '\u0000')
    .join('[redacted]');
}
// Picture input exists only on the studio's own server, and only when that running server
// reports a vision projector through llama.cpp's /props.
export function chatService({
  store = credentialStore,
  fetchImpl = fetch,
  projectorExists = chatProjectorExists,
} = {}) {
  // Reports whether pictures can be sent now, with a reason the page can show verbatim.
  async function describeVision(input, target) {
    if (!isStudioEngine(input, target)) {
      return {
        available: false,
        state: 'unsupported_connection',
        message: 'Image input is available only with the local Qwen engine on port 8098.',
      };
    }
    const props = await readServerVision(new URL('/props', target), fetchImpl);
    if (props.reachable && props.vision === true) {
      return { available: true, state: 'ready', message: 'The running server accepts images.' };
    }
    if (props.reachable) {
      return {
        available: false,
        state: 'server_without_vision',
        message: projectorExists()
          ? 'The running Qwen server was started without the vision projector. Force stop it and start it again to enable images.'
          : 'The running Qwen server has no vision projector, and the projector file is missing.',
      };
    }
    if (!projectorExists()) {
      return {
        available: false,
        state: 'files_missing',
        message:
          'Vision files missing: models/Qwen3.8-27B-GGUF/mmproj-Qwen3.8-27B-BF16.gguf was not found, so Qwen starts without image input.',
      };
    }
    return {
      available: true,
      state: 'starts_with_vision',
      message:
        'Qwen is not running. It will start with the vision projector (about 0.93 GB more GPU memory) when you send.',
    };
  }
  function attach(server) {
    server.middlewares.use('/api/chat', async (req, res) => {
      const host = req.headers.host;
      if (
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
        req.headers.origin !== `http://${host}` ||
        req.headers['x-forge-request'] !== 'chat' ||
        req.method !== 'POST'
      ) {
        log.warn('chat.request.rejected', {
          route: '/api/chat/:action',
          reason: 'forbidden_request',
        });
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      let input;
      try {
        // Decode once at the end: a multi-byte character can straddle two chunks.
        const chunks = [];
        let received = 0;
        for await (const chunk of req) {
          received += chunk.length;
          if (received > MAX_CHAT_IMAGE_REQUEST_CHARS) {
            log.warn('chat.request.rejected', {
              route: '/api/chat/:action',
              reason: 'too_large',
            });
            return json(res, 413, { error: 'Chat request is too large.' });
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        input = JSON.parse(raw);
        if (raw.length > MAX_CHAT_TEXT_REQUEST_CHARS && !hasImages(input)) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'too_large',
          });
          return json(res, 413, { error: 'Chat request is too large.' });
        }
      } catch (error) {
        log.warn('chat.request.rejected', {
          route: '/api/chat/:action',
          reason: 'invalid_json',
          errorClass: error?.name,
        });
        return json(res, 400, { error: 'Invalid request.' });
      }
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      if (route === '/status') {
        return json(res, 200, {
          freeMemoryGiB: Math.round(os.freemem() / 107374182.4) / 10,
          estimatedModelGiB: 18.75,
        });
      }
      let target;
      try {
        target = destination(input);
      } catch (e) {
        log.warn('chat.request.rejected', {
          route: '/api/chat/:action',
          reason: 'invalid_connection',
          errorClass: e?.name,
        });
        return json(res, 400, { error: e.message });
      }
      if (route === '/vision') {
        return json(res, 200, await describeVision(input, target));
      }
      let key = '';
      if (input.provider === 'openai') {
        key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
        if (!key) {
          try {
            key = await store.get('openai');
          } catch (error) {
            log.warn('chat.credential.read.failed', {
              provider: input.provider,
              errorClass: error?.name,
              errorCode: error?.code,
            });
            return json(res, 500, {
              error: 'Could not unlock the saved OpenAI key. Check the studio Windows account.',
            });
          }
        }
        key = key || process.env.OPENAI_API_KEY || '';
        if (!key) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'missing_key',
            provider: input.provider,
          });
          return json(res, 400, {
            error:
              'Save an OpenAI API key in studio settings, enter one here, or set OPENAI_API_KEY.',
          });
        }
      }
      const headers = {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      };
      const startedAt = Date.now();
      let requestFields = {};
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), route === '/models' ? 15000 : 600000);
      res.on('close', () => {
        clearTimeout(timer);
        abort.abort();
      });
      try {
        if (route === '/models') {
          const stopModelsUpstream = log.time('chat.models.request.completed', {
            provider: input.provider,
          });
          const upstream = await fetchImpl(new URL('models', target), {
            headers,
            redirect: 'error',
            signal: abort.signal,
          });
          stopModelsUpstream({ status: upstream.status });
          const data = await upstream.json().catch((error) => {
            log.debug('chat.upstream.body.unreadable', { errorClass: error?.name });
            return {};
          });
          if (!upstream.ok) {
            log.warn('chat.request.failed', {
              route: '/api/chat/:action',
              reason: 'upstream_status',
              status: upstream.status,
              provider: input.provider,
              ...requestFields,
              durationMs: Date.now() - startedAt,
            });
            return json(res, upstream.status, {
              error: sanitize(data?.error?.message || `Server returned ${upstream.status}.`, key),
            });
          }
          const models = Array.isArray(data.data)
            ? data.data
                .filter((x) => x !== null && typeof x === 'object' && typeof x.id === 'string')
                .map((x) => x.id)
                .slice(0, 1000)
            : [];
          return json(res, 200, { models });
        }
        if (route !== '/completions') {
          return json(res, 404, { error: 'Not found.' });
        }
        if (
          typeof input.model !== 'string' ||
          !input.model.trim() ||
          input.model.length > 300 ||
          !Array.isArray(input.messages) ||
          !input.messages.length ||
          input.messages.length > 150
        ) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_model',
          });
          return json(res, 400, { error: 'Choose a model and provide a conversation.' });
        }
        if (
          !input.messages.every(
            (m) =>
              m !== null &&
              typeof m === 'object' &&
              !Array.isArray(m) &&
              ['system', 'user', 'assistant'].includes(m.role) &&
              typeof m.content === 'string' &&
              m.content.length <= 100000,
          )
        ) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_conversation',
          });
          return json(res, 400, { error: 'Invalid conversation.' });
        }
        let built;
        try {
          built = buildImageMessages(input.messages);
        } catch (error) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_image',
          });
          return json(res, 400, { error: error.message, code: 'invalid_image' });
        }
        const messages = built.messages;
        requestFields = {
          modelId: input.model,
          provider: input.provider,
          messageCount: input.messages.length,
          imageCount: built.imageCount,
        };
        log.debug('chat.request.started', requestFields);
        if (built.imageCount) {
          if (!isStudioEngine(input, target)) {
            log.warn('chat.request.rejected', {
              route: '/api/chat/:action',
              reason: 'vision_unsupported',
            });
            return json(res, 400, {
              error: 'Image input is available only with the local Qwen engine.',
              code: 'vision_unsupported_provider',
            });
          }
          const vision = await describeVision(input, target);
          if (vision.state === 'starts_with_vision') {
            return json(res, 502, {
              error: 'Could not connect to the model server: connection refused.',
              code: 'server_unreachable',
            });
          }
          if (!vision.available) {
            log.warn('chat.request.rejected', {
              route: '/api/chat/:action',
              reason: 'vision_unavailable',
            });
            return json(res, 409, { error: vision.message, code: 'vision_unavailable' });
          }
        }
        // An absent temperature uses the same 0.7 default as the Studio form and MCP tool.
        const temperature = input.temperature === undefined ? 0.7 : input.temperature;
        if (
          typeof temperature !== 'number' ||
          !Number.isFinite(temperature) ||
          temperature < 0 ||
          temperature > 2
        ) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_temperature',
          });
          return json(res, 400, { error: 'Temperature must be a number from 0 to 2.' });
        }
        let sampling;
        try {
          sampling = parseChatSampling(input, { provider: input.provider });
        } catch (error) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_sampling',
          });
          return json(res, 400, { error: error.message });
        }
        const payload = {
          model: input.model,
          messages,
          stream: true,
          temperature,
          ...sampling,
        };
        // Request real completion-token counts on providers known to support this
        // OpenAI streaming option. Other compatible servers may reject it.
        if (
          input.provider === 'openai' ||
          (input.provider === 'compatible' &&
            ['127.0.0.1', 'localhost'].includes(target.hostname) &&
            target.port === '8098')
        ) {
          payload.stream_options = { include_usage: true };
        }
        const maxTokens = input.maxTokens === undefined ? 1024 : Number(input.maxTokens);
        if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 262144) {
          log.warn('chat.request.rejected', {
            route: '/api/chat/:action',
            reason: 'invalid_max_tokens',
          });
          return json(res, 400, {
            error: 'Maximum output tokens must be a whole number from 1 to 262,144.',
          });
        }
        if (input.provider === 'openai') {
          payload.max_completion_tokens = maxTokens;
        } else {
          payload.max_tokens = maxTokens;
        }
        if (input.effort !== undefined && input.effort !== 'auto') {
          if (!['none', 'low', 'medium', 'high'].includes(input.effort)) {
            log.warn('chat.request.rejected', {
              route: '/api/chat/:action',
              reason: 'invalid_effort',
            });
            return json(res, 400, { error: 'Choose a valid thinking effort.' });
          }
          payload.reasoning_effort = input.effort;
          // llama.cpp supports a per-request thinking budget; other compatible
          // servers may not understand that extension, so do not send it to them.
          const isLocalEngine = isStudioEngine(input, target);
          // Off must switch thinking off in the chat template itself; the effort field alone does not.
          if (isLocalEngine && input.effort === 'none') {
            payload.chat_template_kwargs = { enable_thinking: false };
          } else if (isLocalEngine) {
            // The Qwen3.8 chat template accepts low, medium and xhigh; plain "high" is a 500 error.
            // Checked against llama.cpp b12180 on 2026-11-08.
            if (input.effort === 'high') {
              payload.reasoning_effort = 'xhigh';
            }
            payload.chat_template_kwargs = { enable_thinking: true };
            payload.reasoning_budget_tokens = { low: 256, medium: 768, high: 1536 }[input.effort];
          }
        }
        if (input.format === 'json') {
          payload.response_format = { type: 'json_object' };
        }
        if (input.format === 'schema') {
          if (!input.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) {
            log.warn('chat.request.rejected', {
              route: '/api/chat/:action',
              reason: 'invalid_schema',
            });
            return json(res, 400, { error: 'Enter a valid JSON schema object.' });
          }
          payload.response_format = {
            type: 'json_schema',
            json_schema: { name: 'studio_output', strict: true, schema: input.schema },
          };
        }
        const stopCompletionUpstream = log.time('chat.completion.request.completed', {
          provider: input.provider,
        });
        const upstream = await fetchImpl(new URL('chat/completions', target), {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          redirect: 'error',
          signal: abort.signal,
        });
        stopCompletionUpstream({ status: upstream.status });
        if (!upstream.ok) {
          const data = await upstream.json().catch((error) => {
            log.debug('chat.upstream.body.unreadable', { errorClass: error?.name });
            return {};
          });
          log.warn('chat.request.failed', {
            route: '/api/chat/:action',
            reason: 'upstream_status',
            status: upstream.status,
            provider: input.provider,
            ...requestFields,
            durationMs: Date.now() - startedAt,
          });
          return json(res, upstream.status, {
            error: sanitize(data?.error?.message || `Server returned ${upstream.status}.`, key),
          });
        }
        if (!upstream.body) {
          return json(res, 502, { error: 'The model server returned an empty response.' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        Readable.fromWeb(upstream.body)
          .on('end', () => {
            log.info('chat.request.completed', {
              ...requestFields,
              durationMs: Date.now() - startedAt,
            });
          })
          .on('error', (error) => {
            if (abort.signal.aborted) {
              log.info('chat.request.cancelled', {
                ...requestFields,
                durationMs: Date.now() - startedAt,
                reason: 'aborted',
              });
            } else {
              log.warn('chat.request.failed', {
                ...requestFields,
                durationMs: Date.now() - startedAt,
                reason: 'stream_error',
                errorClass: error?.name,
                errorCode: error?.code,
              });
            }
            res.destroy();
          })
          .pipe(res);
      } catch (error) {
        if (abort.signal.aborted && error?.name === 'AbortError') {
          log.info('chat.request.cancelled', {
            ...requestFields,
            durationMs: Date.now() - startedAt,
            reason: 'aborted',
          });
        } else {
          log.warn('chat.request.failed', {
            route: '/api/chat/:action',
            ...requestFields,
            durationMs: Date.now() - startedAt,
            reason: 'request_error',
            errorClass: error?.name,
            errorCode: error?.cause?.code || error?.code,
          });
        }
        if (!res.headersSent && !res.destroyed) {
          json(res, 502, {
            error: sanitize(
              error.name === 'AbortError'
                ? 'The model server timed out or the request was stopped.'
                : `Could not connect to the model server: ${error.message}`,
              key,
            ),
            ...(error.cause?.code === 'ECONNREFUSED' ? { code: 'server_unreachable' } : {}),
          });
        } else if (!res.destroyed) {
          res.destroy();
        }
      } finally {
        if (!res.headersSent) {
          clearTimeout(timer);
        }
      }
    });
  }
  return { name: 'forge-chat', configureServer: attach, configurePreviewServer: attach };
}
