// "Suggest a fix" support: builds the exact redacted request shown in the preview, reads a few
// lines of repository source around stack frames, and calls the OpenAI Responses API from the
// Node host. The API key is passed in by the caller and is never returned, logged or stored here.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './error-redaction.js';
import { sourceLabel } from './error-format.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1/';
export const SOURCE_CONTEXT_LINES = 6;
export const MAX_SOURCE_FRAMES = 3;
export const MAX_OUTPUT_TOKENS = 4000;
export const FIX_TIMEOUT_MS = 120000;
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.py',
  '.ps1',
  '.css',
]);
// Local state, weights, dependencies and anything credential-related is never read.
const DENIED_TOP_LEVEL = new Set([
  'models',
  'projects',
  'node_modules',
  'dist',
  'engines',
  'build',
  'coverage',
]);
const MAX_SOURCE_BYTES = 1024 * 1024;

function isDeniedRelative(relative) {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.includes('..')) {
    return true;
  }
  if (DENIED_TOP_LEVEL.has(parts[0].toLowerCase())) {
    return true;
  }
  return parts.some(
    (part) => part.startsWith('.') || /credential|secret|token|password|keys?\.sqlite/i.test(part),
  );
}

/**
 * Resolves a repository-relative path to a readable source file, or null when it is outside
 * the repository, in a denied folder, not a source file, or reached through a link that leaves
 * the repository.
 */
export function resolveRepoSource(repoRoot, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative)
  ) {
    return null;
  }
  if (isDeniedRelative(relative) || !SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    return null;
  }
  try {
    const realRoot = fs.realpathSync(repoRoot);
    const real = fs.realpathSync(path.resolve(realRoot, relative));
    const inside = path.relative(realRoot, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || isDeniedRelative(inside)) {
      return null;
    }
    const info = fs.statSync(real);
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
      return null;
    }
    return { file: real, relative: inside.split(path.sep).join('/') };
  } catch {
    return null;
  }
}

const PYTHON_FRAME = /File "<repo>[\\/]+([^"]+)", line (\d+)/;
const JS_FRAME = /(?:<repo>|<studio>)[\\/]+([^\s:()?'"]+)(?:\?[^\s:()]*)?:(\d+)(?::\d+)?/;

/** Repository frames in the redacted stack, innermost first. */
export function repoFrames(stack) {
  const python = [],
    javascript = [];
  for (const line of String(stack || '').split(/\r?\n/)) {
    const py = PYTHON_FRAME.exec(line);
    if (py) {
      python.push({ relative: py[1], line: Number(py[2]) });
      continue;
    }
    const js = JS_FRAME.exec(line);
    if (js) {
      javascript.push({ relative: js[1], line: Number(js[2]) });
    }
  }
  return python.length ? python.reverse() : javascript;
}

/** Reads up to MAX_SOURCE_FRAMES excerpts of SOURCE_CONTEXT_LINES lines around each frame. */
export function extractSourceContext(stack, { repoRoot, roots = {} }) {
  const excerpts = [];
  const seen = new Set();
  for (const frame of repoFrames(stack)) {
    if (excerpts.length >= MAX_SOURCE_FRAMES) {
      break;
    }
    const resolved = resolveRepoSource(repoRoot, frame.relative);
    if (!resolved || !Number.isSafeInteger(frame.line) || frame.line < 1) {
      continue;
    }
    const key = `${resolved.relative}:${frame.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const lines = fs.readFileSync(resolved.file, 'utf8').split(/\r?\n/);
    if (frame.line > lines.length) {
      continue;
    }
    const startLine = Math.max(1, frame.line - SOURCE_CONTEXT_LINES);
    const endLine = Math.min(lines.length, frame.line + SOURCE_CONTEXT_LINES);
    const text = lines
      .slice(startLine - 1, endLine)
      .map((line, index) => {
        const number = startLine + index;
        const marker = number === frame.line ? '>' : ' ';
        return `${marker}${String(number).padStart(5)} | ${redactText(line.slice(0, 240), roots)}`;
      })
      .join('\n');
    excerpts.push({ path: resolved.relative, startLine, endLine, line: frame.line, text });
  }
  return excerpts;
}

const INSTRUCTIONS =
  'You help a developer debug Forge, a local game asset studio (React 19 + Vite frontend, Node 24 ' +
  'backend with node:sqlite, Python model workers on Windows ARM64 with NVIDIA CUDA). Paths are ' +
  'redacted placeholders: <repo> is the repository root, <projects> the projects folder, <runtime> ' +
  'the runtime state folder, <home> the user folder. Never ask for secrets. The developer applies ' +
  'changes themselves. Answer in Markdown with these sections: Explanation, Likely root cause, ' +
  'Suggested patch (a unified diff or code block), Confidence (low, medium or high, with a reason), ' +
  'What to check.';

/**
 * Builds the exact Responses API body for one redacted error. The preview shows this object and
 * the send step posts JSON.stringify of the same object.
 */
export function buildFixRequest(error, { model, environment, sourceContext }) {
  const context = error.context || {};
  const details = [
    `Forge version: ${environment.appVersion} (Node ${environment.nodeVersion}, ${environment.platform} ${environment.arch})`,
    `Source: ${sourceLabel(error.source)} (${error.source})`,
    error.page ? `Page: ${error.page}` : null,
    context.jobType ? `Job type: ${context.jobType}` : null,
    context.jobStatus ? `Job status: ${context.jobStatus}` : null,
    context.kind ? `Browser report kind: ${context.kind}` : null,
    context.path
      ? `Request: ${context.method || 'GET'} ${context.path} -> ${context.status ?? 'network error'}`
      : null,
    `Occurrences: ${error.count}`,
  ].filter(Boolean);
  const sections = [
    ...details,
    '',
    'Error message:',
    error.message,
    '',
    'Stack trace (redacted):',
    error.stack || '(none)',
  ];
  if (sourceContext.length) {
    sections.push(
      '',
      'Source context from the repository (read-only excerpts, ">" marks the frame line):',
    );
    for (const excerpt of sourceContext) {
      sections.push(
        `--- ${excerpt.path} lines ${excerpt.startLine}-${excerpt.endLine} ---`,
        excerpt.text,
      );
    }
  }
  sections.push(
    '',
    'Question: What does this error mean, what is the likely root cause, and how should the code be fixed?',
  );
  return {
    model,
    instructions: INSTRUCTIONS,
    input: sections.join('\n'),
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
}

export function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Removes the key and any key-like strings from text that came back from the provider. */
export function sanitizeProviderText(text, key) {
  let value = String(text || '').slice(0, 1200);
  if (key) {
    value = value.split(key).join('[redacted-key]');
  }
  return redactText(value, {}, { keepPaths: true });
}

export class ProviderError extends Error {
  constructor(status, message, providerMessage = '') {
    super(message);
    this.status = status;
    this.providerMessage = providerMessage;
  }
}

function explainStatus(status, model, providerMessage) {
  const detail = providerMessage ? ` OpenAI said: ${providerMessage}` : '';
  if (status === 401) {
    return `OpenAI rejected the saved API key (401). Replace the OpenAI key in Settings.${detail}`;
  }
  if (status === 403) {
    return `This OpenAI key or project cannot use ${model} (403). Check the project's model access or choose another model.${detail}`;
  }
  if (status === 404) {
    return `OpenAI could not find the model ${model} (404). Choose another model id.${detail}`;
  }
  if (status === 429) {
    return `OpenAI rate limit or quota reached (429). Wait and try again, or check billing.${detail}`;
  }
  if (status >= 500) {
    return `OpenAI had a server problem (${status}). Try again later.${detail}`;
  }
  return `OpenAI returned ${status}.${detail}`;
}

async function readProviderMessage(response, key) {
  const data = await response.json().catch(() => ({}));
  return sanitizeProviderText(data?.error?.message || '', key);
}

function linkedSignal(external, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function connectionError(error, key) {
  if (error.name === 'AbortError') {
    return new ProviderError(504, 'The OpenAI request timed out or was cancelled.');
  }
  return new ProviderError(
    502,
    sanitizeProviderText(`Could not reach OpenAI: ${error.message}`, key),
  );
}

function responseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text) {
    return data.output_text;
  }
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  return parts.join('\n\n');
}

/** Posts the previewed body to the Responses API and returns the suggestion text. */
export async function requestFixSuggestion({
  body,
  key,
  fetchImpl = fetch,
  baseUrl = OPENAI_BASE_URL,
  signal,
  timeoutMs = FIX_TIMEOUT_MS,
}) {
  const linked = linkedSignal(signal, timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL('responses', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: linked.signal,
      });
    } catch (error) {
      throw connectionError(error, key);
    }
    if (!response.ok) {
      const providerMessage = await readProviderMessage(response, key);
      throw new ProviderError(
        response.status,
        explainStatus(response.status, body.model, providerMessage),
        providerMessage,
      );
    }
    const data = await response.json().catch(() => null);
    const text = responseText(data);
    if (!text) {
      const reason = data?.incomplete_details?.reason;
      throw new ProviderError(
        502,
        reason === 'max_output_tokens'
          ? `The model used its ${MAX_OUTPUT_TOKENS}-token output limit before answering. Try again or choose another model.`
          : 'OpenAI returned no suggestion text.',
      );
    }
    const incomplete = data?.status === 'incomplete';
    return {
      text: incomplete ? `${text}\n\n_The answer was cut off by the output limit._` : text,
      model: typeof data?.model === 'string' ? data.model.slice(0, 100) : body.model,
    };
  } finally {
    linked.dispose();
  }
}

/**
 * Checks a model id against the provider. Returns {exists: true} or, when it is missing, the
 * provider's message and a list of available ids to choose from.
 */
export async function verifyModel({
  model,
  key,
  fetchImpl = fetch,
  baseUrl = OPENAI_BASE_URL,
  signal,
}) {
  const linked = linkedSignal(signal, 15000);
  const headers = { Authorization: `Bearer ${key}` };
  try {
    let response;
    try {
      response = await fetchImpl(new URL(`models/${encodeURIComponent(model)}`, baseUrl), {
        headers,
        redirect: 'error',
        signal: linked.signal,
      });
    } catch (error) {
      throw connectionError(error, key);
    }
    if (response.ok) {
      await response.body?.cancel?.();
      return { exists: true, message: `${model} is available to this key.`, models: [] };
    }
    const providerMessage = await readProviderMessage(response, key);
    if (response.status !== 404) {
      throw new ProviderError(
        response.status,
        explainStatus(response.status, model, providerMessage),
        providerMessage,
      );
    }
    let models = [];
    try {
      const list = await fetchImpl(new URL('models', baseUrl), {
        headers,
        redirect: 'error',
        signal: linked.signal,
      });
      const data = list.ok ? await list.json().catch(() => ({})) : {};
      models = (Array.isArray(data.data) ? data.data : [])
        .map((item) => item?.id)
        .filter((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id))
        .sort()
        .slice(0, 300);
    } catch {
      models = [];
    }
    return {
      exists: false,
      message: providerMessage || `The model ${model} does not exist or this key cannot use it.`,
      models,
    };
  } finally {
    linked.dispose();
  }
}
