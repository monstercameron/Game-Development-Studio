// Extra MCP controls share the HTTP routes and safety checks used by Studio.
import { z } from 'zod';
import { CHAT_CONTEXT_SIZES, estimateChatMemory } from './chat-memory.js';
import { MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES } from './chat-image-limits.js';
import { ACTIVE_QUEUE_STATES, estimateFromNearbyHistory, forecastQueue } from './queue-timing.js';
import { createLogger } from './app-log.js';

const log = createLogger('mcp');
const change = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const projectId = z.string().uuid();
const assetPath = z.string().min(1).max(1000);
const engine = z.enum([
  'music',
  'sfx',
  'images',
  'video',
  'world',
  'tts',
  '3d-hunyuan',
  '3d-trellis',
  'segmentation',
  'motion-hy',
  'motion-bricks',
  'asr',
  'game',
]);
const chatContext = z.union(CHAT_CONTEXT_SIZES.map((size) => z.literal(size)));
const connection = {
  provider: z.enum(['compatible', 'openai']).default('compatible'),
  endpoint: z.string().max(1000).default('http://127.0.0.1:8098/v1'),
};

async function readAssetContent(base, id, path, thumbnail = false) {
  const route = thumbnail ? '/api/projects/:id/thumbnail' : '/api/projects/:id/asset';
  try {
    const url = new URL(`/api/projects/${id}/${thumbnail ? 'thumbnail' : 'asset'}`, base);
    url.searchParams.set('path', path);
    const stop = log.time('mcp.asset.request.completed', { route });
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    stop({ status: response.status });
    if (!response.ok) {
      throw Error(`Asset request returned ${response.status}.`);
    }
    const type = response.headers.get('content-type')?.split(';')[0];
    if (thumbnail ? type !== 'image/png' : !['text/plain', 'application/json'].includes(type)) {
      await response.body?.cancel();
      throw Error(
        thumbnail
          ? 'The thumbnail is not a PNG.'
          : 'Only text and JSON assets can be read with this tool.',
      );
    }
    const limit = thumbnail ? 1_500_000 : 400_000;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw Error('Asset exceeds the MCP size limit.');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        size += part.value.byteLength;
        if (size > limit) {
          throw Error('Asset exceeds the MCP size limit.');
        }
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    return {
      content: [
        thumbnail
          ? { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
          : { type: 'text', text: bytes.toString('utf8') },
      ],
    };
  } catch (error) {
    log.warn('mcp.asset.read.failed', {
      route,
      errorClass: error.name,
      errorCode: error.code,
    });
    return {
      isError: true,
      content: [{ type: 'text', text: `Cannot read asset: ${error.message}` }],
    };
  }
}

// Reads one project image through the studio's asset route and returns it as a data URL.
// The chat endpoint sniffs the bytes again, so the content type here is only a first filter.
async function readChatImage(base, projectId, assetPath) {
  const url = new URL(`/api/projects/${projectId}/asset`, base);
  url.searchParams.set('path', assetPath);
  const stop = log.time('mcp.image.request.completed', { route: '/api/projects/:id/asset' });
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  stop({ status: response.status });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Image ${assetPath} could not be read (${response.status}).`);
  }
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    await response.body?.cancel();
    throw Error(`${assetPath} is not a PNG, JPEG or WebP image.`);
  }
  if (Number(response.headers.get('content-length')) > MAX_CHAT_IMAGE_BYTES) {
    await response.body?.cancel();
    throw Error(`${assetPath} is larger than ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MiB.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_CHAT_IMAGE_BYTES) {
    throw Error(`${assetPath} is larger than ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MiB.`);
  }
  return `data:${type};base64,${bytes.toString('base64')}`;
}

// Project images become data URLs on the last user message. Nothing else is read from disk.
async function attachChatImages(base, { projectId, images, ...request }) {
  if (!images?.length) {
    return request;
  }
  if (!projectId) {
    throw Error('projectId is required when images are attached.');
  }
  const messages = [...request.messages];
  const last = messages.length - 1;
  if (messages[last]?.role !== 'user') {
    throw Error('Images are attached to the last message, which must be a user message.');
  }
  const dataUrls = [];
  for (const assetPath of images) {
    dataUrls.push(await readChatImage(base, projectId, assetPath));
  }
  messages[last] = { ...messages[last], images: dataUrls };
  return { ...request, messages };
}

// Chat's HTTP endpoint streams SSE. Bound the entire response and require its
// completion marker so interrupted generations cannot look like finished ones.
async function completeChat(base, input) {
  const started = performance.now();
  try {
    const request = await attachChatImages(base, input);
    const stop = log.time('mcp.chat.request.completed', { route: '/api/chat/completions' });
    const response = await fetch(new URL('/api/chat/completions', base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forge-Request': 'chat',
        Origin: base.origin,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(600000),
      redirect: 'error',
    });
    stop({ status: response.status });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: String(data.error || `Chat returned ${response.status}.`).slice(0, 2000),
          },
        ],
      };
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw Error('Chat returned an invalid stream.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '',
      total = 0,
      output = '',
      done = false,
      usage = null,
      firstTokenMs = null;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) {
          break;
        }
        total += part.value.byteLength;
        if (total > 2_000_000) {
          throw Error('Chat response exceeded the 2 MB MCP limit.');
        }
        buffer += decoder.decode(part.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            done = true;
            continue;
          }
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            throw Error('Chat returned malformed stream data.');
          }
          if (event.error) {
            throw Error('The chat provider reported a streaming error.');
          }
          const delta = event.choices?.[0]?.delta;
          if (
            (typeof delta?.content === 'string' && delta.content) ||
            (typeof delta?.reasoning_content === 'string' && delta.reasoning_content)
          ) {
            firstTokenMs ??= performance.now() - started;
          }
          if (typeof delta?.content === 'string') {
            output += delta.content;
          }
          if (event.usage) {
            usage = event.usage;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!done) {
      throw Error('Chat stream ended before completion; the response may be incomplete.');
    }
    const elapsedMs = performance.now() - started;
    const count = usage?.completion_tokens;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            text: output,
            usage,
            firstTokenMs,
            elapsedMs,
            tokensPerSecond:
              Number.isFinite(count) && firstTokenMs !== null && elapsedMs > firstTokenMs
                ? count / ((elapsedMs - firstTokenMs) / 1000)
                : null,
          }),
        },
      ],
    };
  } catch (error) {
    log.warn('mcp.chat.request.failed', { errorClass: error.name, errorCode: error.code });
    return { isError: true, content: [{ type: 'text', text: `Chat failed: ${error.message}` }] };
  }
}

export function registerExtendedTools(server, { base, read, write, readonly }) {
  server.registerTool(
    'forge_estimate_queue',
    {
      description:
        'Estimate the sequential render queue and per-job wait times using the same history and blocked-state logic as Studio. Returns unknown when timing cannot be inferred; estimates are not reservations.',
      inputSchema: {},
      annotations: readonly,
    },
    async () => {
      const result = await read('/api/runtime/jobs');
      if (result.isError) {
        return result;
      }
      let jobs;
      try {
        jobs = JSON.parse(result.content[0].text).jobs;
        if (!Array.isArray(jobs)) {
          throw Error('Invalid queue response.');
        }
      } catch (error) {
        log.debug('mcp.queue.response.invalid', { errorClass: error.name });
        return {
          isError: true,
          content: [{ type: 'text', text: 'Cannot estimate queue: invalid queue response.' }],
        };
      }
      const candidates = jobs.filter((job) => ACTIVE_QUEUE_STATES.has(job.status)).slice(0, 50);
      const estimates = {};
      for (let index = 0; index < candidates.length; index += 6) {
        const batch = await Promise.all(
          candidates.slice(index, index + 6).map(async (job) => {
            const response = await write('/api/runtime/estimate', {
              type: job.type,
              projectId: job.projectId,
              request: job.request,
            });
            let estimate = null;
            try {
              if (!response.isError) {
                estimate = JSON.parse(response.content[0].text);
              }
            } catch (error) {
              log.debug('mcp.estimate.parse.failed', { errorClass: error.name });
              // Fall back to nearby completed jobs.
            }
            if (!estimate?.available) {
              estimate = estimateFromNearbyHistory(job.type, job.request, jobs) || estimate;
            }
            return [job.id, estimate];
          }),
        );
        Object.assign(estimates, Object.fromEntries(batch));
      }
      return { content: [{ type: 'text', text: JSON.stringify(forecastQueue(jobs, estimates)) }] };
    },
  );

  server.registerTool(
    'forge_read_text_asset',
    {
      description:
        'Read an indexed text or JSON asset from a project, up to 400 KB. Use forge_projects to find project IDs and relative paths.',
      inputSchema: { projectId, path: assetPath },
      annotations: readonly,
    },
    ({ projectId: id, path }) => readAssetContent(base, id, path),
  );

  server.registerTool(
    'forge_view_thumbnail',
    {
      description:
        'Return the stored PNG thumbnail for an indexed image, mask, video, or 3D asset so an agent can inspect its visual preview. Returns an error if no thumbnail has been created yet.',
      inputSchema: { projectId, path: assetPath },
      annotations: readonly,
    },
    ({ projectId: id, path }) => readAssetContent(base, id, path, true),
  );

  server.registerTool(
    'forge_asset_details',
    {
      description:
        'Return the recorded generation details of a project asset: model, prompt, negative prompt, lyrics or voice direction, settings, seed, references, timing and origin. Returns metadata: null when nothing was recorded. Older assets are recovered from render history when possible.',
      inputSchema: { projectId, path: assetPath },
      annotations: readonly,
    },
    ({ projectId: id, path }) =>
      read(`/api/projects/${id}/assets/details?path=${encodeURIComponent(path)}`),
  );

  server.registerTool(
    'forge_search_asset_details',
    {
      description:
        'Find project assets whose prompt, negative prompt, lyrics, title or model name contains the given words. Returns matching asset paths.',
      inputSchema: { projectId, query: z.string().min(1).max(200) },
      annotations: readonly,
    },
    ({ projectId: id, query }) =>
      read(`/api/projects/${id}/assets/search?q=${encodeURIComponent(query)}`),
  );

  server.registerTool(
    'forge_convert_asset',
    {
      description:
        'Convert a project image, audio or video asset into a new file; the original is retained. The response reports the conversion backend. Image: png, jpeg, webp, bmp, tga. Audio: wav, mp3, ogg, opus, flac. Video: mp4 (H.264 + AAC, quality sets the compression) or gif (silent loop, up to 480 px wide); a converted video keeps the generation details of its source. 3D models (glb, gltf, obj, ply, stl) convert to any of those formats except their own; an obj also gets an .mtl file and a PNG texture beside it, and the response lists those extra files. Point clouds and Gaussian splats cannot be converted. Every copy is a new file named forge-<id>-converted.<ext> that keeps the generation details of the original asset.',
      inputSchema: {
        projectId,
        path: assetPath,
        format: z.enum([
          'png',
          'jpeg',
          'webp',
          'bmp',
          'tga',
          'wav',
          'mp3',
          'ogg',
          'opus',
          'flac',
          'mp4',
          'gif',
          'glb',
          'gltf',
          'obj',
          'ply',
          'stl',
        ]),
        quality: z.number().int().min(1).max(100).default(90),
        background: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .default('#ffffff'),
      },
      annotations: change,
    },
    ({ projectId: id, ...input }) => write(`/api/projects/${id}/assets/convert`, input, 310000),
  );

  server.registerTool(
    'forge_save_text_asset',
    {
      description:
        'Save a transcript, chat response, or JSON game decision as a new project text asset. Decision content must be valid JSON. Optionally record the model and prompt that produced it.',
      inputSchema: {
        projectId,
        kind: z.enum(['transcript', 'chat', 'decision']),
        content: z.string().min(1).max(100000),
        model: z.string().max(120).optional(),
        prompt: z.string().max(20000).optional(),
      },
      annotations: change,
    },
    ({ projectId: id, model, prompt, ...input }) =>
      write(`/api/projects/${id}/assets/create-text`, {
        ...input,
        ...(model || prompt ? { provenance: { model, prompt } } : {}),
      }),
  );

  server.registerTool(
    'forge_clear_waiting_jobs',
    {
      description:
        'Cancel queued and waiting renders without remote job IDs. Running and uncertain jobs are preserved. Only call after the user explicitly asks to cancel waiting renders.',
      inputSchema: { confirmation: z.literal('cancel-waiting-renders') },
      annotations: destructive,
    },
    (input) => write('/api/runtime/jobs/clear-waiting', input),
  );

  server.registerTool(
    'forge_resolve_interrupted_job',
    {
      description:
        'Resolve an interrupted render as cancelled only after independently verifying its remote engine job is no longer running. This can unblock the queue.',
      inputSchema: { id: z.string().uuid(), confirmRemoteNotRunning: z.literal(true) },
      annotations: destructive,
    },
    ({ id, ...input }) => write(`/api/runtime/jobs/${id}/resolve`, input),
  );

  server.registerTool(
    'forge_close_model',
    {
      description:
        'Gently close an idle model service, including a verifiable external service, using the same ownership and activity checks as Studio. Does not delete files.',
      inputSchema: { id: engine },
      annotations: destructive,
    },
    ({ id }) => write(`/api/runtime/models/${id}/close`, {}, 70000),
  );

  server.registerTool(
    'forge_force_stop_model',
    {
      description:
        'Force stop a verified model service and release its memory; active work may be interrupted. Only use on explicit user request. Forge retains its process-identity and queue safeguards.',
      inputSchema: {
        id: z.union([engine, z.literal('chat')]),
        confirmation: z.literal('force-stop-engine'),
      },
      annotations: destructive,
    },
    ({ id, ...input }) => write(`/api/runtime/models/${id}/force-stop`, input, 70000),
  );

  server.registerTool(
    'forge_power_status',
    {
      description: 'Check whether Forge is keeping the computer awake.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/power'),
  );
  server.registerTool(
    'forge_set_keep_awake',
    {
      description: 'Enable or disable the Studio keep-awake request.',
      inputSchema: { enabled: z.boolean() },
      annotations: change,
    },
    (input) => write('/api/power', input, 20000, 'power'),
  );

  server.registerTool(
    'forge_estimate_chat_memory',
    {
      description:
        'Estimate GPU and context memory for the installed Qwen model at a supported context size. This is an offline estimate, not a reservation or measured free memory.',
      inputSchema: { contextSize: chatContext.default(4096) },
      annotations: readonly,
    },
    ({ contextSize }) => ({
      content: [{ type: 'text', text: JSON.stringify(estimateChatMemory(contextSize)) }],
    }),
  );

  server.registerTool(
    'forge_load_chat_model',
    {
      description:
        'Start the Forge-managed Qwen chat model with full GPU offload, a selected context size, and optional speculative decoding. Existing running instances keep their current settings.',
      inputSchema: {
        contextSize: chatContext.default(4096),
        speculative: z.boolean().default(true),
      },
      annotations: change,
    },
    (input) => write('/api/runtime/models/chat/load', input, 30000),
  );

  server.registerTool(
    'forge_chat_models',
    {
      description:
        'List models offered by the chosen local-compatible server or OpenAI. OpenAI uses the key configured in Studio; never pass API keys through MCP.',
      inputSchema: connection,
      annotations: { ...readonly, openWorldHint: true },
    },
    (input) => write('/api/chat/models', input, 20000, 'chat'),
  );

  server.registerTool(
    'forge_chat',
    {
      description:
        'Request a complete chat response from the configured local-compatible server or OpenAI, with optional JSON or JSON Schema output and thinking effort. Uses stored credentials; never pass secrets in tool arguments. Returns text, usage when supplied, time to first token and generation rate. The MCP call waits for completion. Optional images (up to 4 project asset paths, PNG, JPEG or WebP, 8 MiB each, with projectId) are attached to the last user message; they work only with the local Qwen engine on port 8098 started with its vision projector, and are refused for OpenAI and other servers.',
      inputSchema: {
        ...connection,
        model: z.string().trim().min(1).max(300),
        messages: z
          .array(
            z.object({
              role: z.enum(['system', 'user', 'assistant']),
              content: z.string().max(100000),
            }),
          )
          .min(1)
          .max(150),
        temperature: z.number().min(0).max(2).default(0.7),
        maxTokens: z.number().int().min(1).max(262144).default(1024),
        effort: z.enum(['auto', 'none', 'low', 'medium', 'high']).default('auto'),
        format: z.enum(['text', 'json', 'schema']).default('text'),
        schema: z.record(z.string(), z.unknown()).optional(),
        topP: z.number().gt(0).max(1).optional(),
        topK: z.number().int().min(1).max(1000).optional(),
        minP: z.number().min(0).max(1).optional(),
        presencePenalty: z.number().min(-2).max(2).optional(),
        frequencyPenalty: z.number().min(-2).max(2).optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        stop: z.array(z.string().min(1).max(100)).max(4).optional(),
        projectId: projectId.optional(),
        images: z.array(assetPath).max(MAX_CHAT_IMAGES).optional(),
      },
      annotations: { ...change, openWorldHint: true },
    },
    (input) => completeChat(base, input),
  );
}
