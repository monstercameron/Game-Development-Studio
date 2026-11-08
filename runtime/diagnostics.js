import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { createLogger } from './app-log.js';

const log = createLogger('diagnostics');
// This file lives in runtime/; the repository root is its parent folder.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = process.env.FORGE_RUNTIME_DIR || path.join(root, '.forge-runtime');
const desktop = path.join(os.homedir(), 'Desktop');
const sources = [
  { id: 'studio', label: 'Forge Studio', file: null },
  {
    id: 'service-supervisor',
    label: 'Forge · service supervisor',
    file: path.join(runtimeDir, 'service-supervisor.log'),
  },
  {
    id: 'runtime-worker',
    label: 'Forge · runtime worker',
    file: path.join(runtimeDir, 'runtime-worker.log'),
  },
  {
    id: 'managed-images',
    label: 'Images · Forge engine',
    file: path.join(runtimeDir, 'engine-images.log'),
  },
  {
    id: 'managed-music',
    label: 'Music · Forge engine',
    file: path.join(runtimeDir, 'engine-music.log'),
  },
  {
    id: 'managed-sfx',
    label: 'Sound effects · Forge engine',
    file: path.join(runtimeDir, 'engine-sfx.log'),
  },
  {
    id: 'managed-video',
    label: 'Video · Forge engine',
    file: path.join(runtimeDir, 'engine-video.log'),
  },
  {
    id: 'managed-world',
    label: 'Worlds · Forge engine',
    file: path.join(runtimeDir, 'engine-world.log'),
  },
  {
    id: 'managed-game',
    label: 'Game logic · Forge engine',
    file: path.join(runtimeDir, 'engine-game.log'),
  },
  {
    id: 'managed-tts',
    label: 'Voices · Forge engine',
    file: path.join(runtimeDir, 'engine-tts.log'),
  },
  {
    id: 'managed-asr',
    label: 'Speech recognition · Forge engine',
    file: path.join(runtimeDir, 'engine-asr.log'),
  },
  {
    id: 'managed-3d-hunyuan',
    label: '3D shape · Forge engine',
    file: path.join(runtimeDir, 'engine-3d-hunyuan.log'),
  },
  {
    id: 'managed-3d-trellis',
    label: 'TRELLIS.2 · Forge engine',
    file: path.join(runtimeDir, 'engine-3d-trellis.log'),
  },
  {
    id: 'managed-segmentation',
    label: 'Segmentation · Forge engine',
    file: path.join(runtimeDir, 'engine-segmentation.log'),
  },
  {
    id: 'managed-motion-hy',
    label: 'Motion · Forge engine',
    file: path.join(runtimeDir, 'engine-motion-hy.log'),
  },
  {
    id: 'managed-motion-bricks',
    label: 'MotionBricks · Forge engine',
    file: path.join(runtimeDir, 'engine-motion-bricks.log'),
  },
  {
    id: 'music',
    label: 'Music · studio',
    file: path.join(desktop, 'Snapdargon-DJ', 'outputs', 'app', 'logs', 'studio.log'),
  },
  {
    id: 'music-errors',
    label: 'Music · launcher errors',
    file: path.join(desktop, 'Snapdargon-DJ', 'outputs', 'app', 'logs', 'launcher.stderr.log'),
  },
  {
    id: 'sfx',
    label: 'Sound effects · server',
    file: path.join(desktop, 'Stable Audio Lab', 'server.log'),
  },
  {
    id: 'sfx-errors',
    label: 'Sound effects · errors',
    file: path.join(desktop, 'Stable Audio Lab', 'server-error.log'),
  },
  { id: 'video', label: 'Video · studio', file: path.join(desktop, 'H3 Studio', 'studio.log') },
  {
    id: 'video-errors',
    label: 'Video · errors',
    file: path.join(desktop, 'H3 Studio', 'studio-error.log'),
  },
  {
    id: 'game',
    label: 'Game logic · server',
    file: path.join(desktop, 'Mammoth Studio', 'server.log'),
  },
  {
    id: 'game-errors',
    label: 'Game logic · errors',
    file: path.join(desktop, 'Mammoth Studio', 'server-error.log'),
  },
  {
    id: 'images',
    label: 'Images · log not configured',
    file: null,
    unavailable: 'Qwen Image Studio does not currently write a dedicated log file.',
  },
];
const services = [
  { id: 'images', name: 'Qwen Image Studio', port: 8189 },
  { id: 'music', name: 'YuE2 Studio', port: 8765 },
  { id: 'sfx', name: 'Stable Audio Lab', port: 7863 },
  { id: 'video', name: 'H3 Studio', port: 8274 },
  { id: 'world', name: 'World generation', port: 8288 },
  { id: 'game', name: 'Mammoth Studio', port: 8791 },
  { id: 'tts', name: 'Qwen3-TTS', port: 8281 },
  { id: 'asr', name: 'Nemotron ASR', port: 8282 },
  { id: '3d-hunyuan', name: 'Hunyuan3D shape', port: 8283 },
  { id: 'segmentation', name: 'SAM 3.1', port: 8284 },
  { id: '3d-trellis', name: 'TRELLIS.2', port: 8285 },
  { id: 'motion-hy', name: 'HY-Motion 1.0', port: 8286 },
  { id: 'motion-bricks', name: 'MotionBricks SOMA', port: 8287 },
];
const startedAt = new Date().toISOString();
const studioLog = [`${startedAt} INFO Forge diagnostics started`];
const MAX_BYTES = 32768;
// Last reported failure code per probe or log, so a missing file or a stopped service is logged
// once when it changes instead of on every poll.
const lastFailureCodeByKey = new Map();
const lastReachabilityById = new Map();

// Returns true when this failure code differs from the last one reported for the same key.
function isFailureChange(event, sourceId, errorCode) {
  const key = `${event}|${sourceId}`;
  if (lastFailureCodeByKey.get(key) === errorCode) {
    return false;
  }
  lastFailureCodeByKey.set(key, errorCode);
  return true;
}

function forgetFailure(event, sourceId) {
  lastFailureCodeByKey.delete(`${event}|${sourceId}`);
}

function logReachabilityChange(service) {
  if (lastReachabilityById.get(service.id) === service.reachable) {
    return;
  }
  lastReachabilityById.set(service.id, service.reachable);
  log.debug('diagnostics.service.reachability.changed', {
    serviceId: service.id,
    isReachable: service.reachable,
  });
}

// A rejected browser log entry is logged with a reason code only; its text is never logged.
function clientRejectionReason(error) {
  if (error?.message === 'Request too large.') {
    return 'too_large';
  }
  return error?.message === 'A message is required.' ? 'missing_message' : 'invalid_body';
}

const clean = (text) =>
  String(text)
    .replace(/\b(?:hf_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|hf[_-]?token|password|secret|x-lab-session)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]',
    );
function appendStudio(level, message) {
  studioLog.push(clean(`${new Date().toISOString()} ${level} ${message}`).slice(0, 4000));
  if (studioLog.length > 150) {
    studioLog.shift();
  }
}

async function readTail(source) {
  if (!source.file) {
    return {
      ...source,
      available: !source.unavailable,
      lines: source.unavailable ? [] : studioLog.slice(-100),
    };
  }
  let handle;
  try {
    handle = await fs.open(source.file, 'r');
    const info = await handle.stat();
    const size = Math.min(info.size, MAX_BYTES);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, info.size - size);
    let text = buf.toString('utf8');
    if (info.size > size) {
      text = text.slice(text.indexOf('\n') + 1);
    }
    forgetFailure('diagnostics.log.read.failed', source.id);
    return {
      ...source,
      available: true,
      modified: info.mtime.toISOString(),
      size: info.size,
      lines: clean(text).split(/\r?\n/).filter(Boolean).slice(-150),
    };
  } catch (error) {
    const errorCode = error.code || 'error';
    if (isFailureChange('diagnostics.log.read.failed', source.id, errorCode)) {
      log.debug('diagnostics.log.read.failed', { sourceId: source.id, errorCode });
    }
    return {
      ...source,
      available: false,
      lines: [],
      unavailable:
        error.code === 'ENOENT'
          ? 'Log file not found.'
          : `Unable to read log (${error.code || 'error'}).`,
    };
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}
function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (online) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
function json(res, value, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(value));
}

export function diagnosticsService({ streamIntervalMs = 2000 } = {}) {
  function attach(server) {
    const logger = server.config.logger;
    const originals = {};
    for (const level of ['info', 'warn', 'error']) {
      originals[level] = logger[level];
      logger[level] = function (message, ...args) {
        appendStudio(level.toUpperCase(), message);
        return originals[level].call(this, message, ...args);
      };
    }
    server.httpServer?.once('close', () => {
      for (const level of Object.keys(originals)) {
        logger[level] = originals[level];
      }
    });
    server.middlewares.use('/api/client-logs', async (req, res) => {
      const host = req.headers.host;
      if (
        req.method !== 'POST' ||
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
        req.headers.origin !== `http://${host}` ||
        req.headers['x-forge-request'] !== 'client-log'
      ) {
        log.warn('diagnostics.request.rejected', {
          route: '/api/client-logs',
          status: 403,
          reason: 'forbidden',
        });
        return json(res, { error: 'Local studio requests only.' }, 403);
      }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 10000) {
            throw Error('Request too large.');
          }
        }
        const entry = JSON.parse(body);
        if (typeof entry.message !== 'string') {
          throw Error('A message is required.');
        }
        appendStudio('CLIENT ERROR', entry.message);
        json(res, { ok: true });
      } catch (error) {
        log.warn('diagnostics.request.rejected', {
          route: '/api/client-logs',
          status: 400,
          reason: clientRejectionReason(error),
        });
        json(res, { error: error.message }, 400);
      }
    });
    server.middlewares.use('/api/diagnostics', async (req, res) => {
      if (req.method !== 'GET') {
        return json(res, { error: 'Method not allowed' }, 405);
      }
      const address = server.httpServer?.address();
      const port = typeof address === 'object' && address ? address.port : null;
      const statuses = await Promise.all(
        services.map(async (service) => ({
          ...service,
          url: `http://127.0.0.1:${service.port}`,
          reachable: await reachable(service.port),
        })),
      );
      statuses.forEach(logReachabilityChange);
      json(res, {
        application: 'Forge Game Development Studio',
        mode: 'early integration',
        server: {
          url: port ? `http://127.0.0.1:${port}` : null,
          host: '127.0.0.1',
          port,
          pid: process.pid,
          supervisorPid: Number(process.env.FORGE_SERVICE_SUPERVISOR_PID) || null,
          projectDirectory: root,
          startedAt,
          nodeVersion: process.version,
          platform: process.platform,
          architecture: process.arch,
        },
        services: statuses,
        logEndpoints: { snapshot: '/api/logs', stream: '/api/logs/stream' },
        runtimeEndpoints: {
          health: '/api/runtime/health',
          hardware: '/api/runtime/hardware',
          services: '/api/runtime/services',
          jobs: '/api/runtime/jobs',
        },
        note: 'Port reachability does not verify service identity. Logs may contain prompts or other private data.',
      });
    });
    server.middlewares.use('/api/logs', async (req, res) => {
      if (req.method !== 'GET') {
        return json(res, { error: 'Method not allowed' }, 405);
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      const selected = url.searchParams.get('source') || 'all';
      const list = selected === 'all' ? sources : sources.filter((s) => s.id === selected);
      if (!list.length) {
        log.warn('diagnostics.request.rejected', {
          route: '/api/logs',
          status: 400,
          reason: 'unknown_source',
        });
        return json(res, { error: 'Unknown log source' }, 400);
      }
      if (url.pathname === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        let closed = false;
        let running = false;
        let last = '';
        // Do not buffer repeated snapshots for a client that is not reading.
        // Once its socket drains, the next poll sends the latest full snapshot.
        async function send() {
          if (closed || running || res.writableNeedDrain) {
            return;
          }
          running = true;
          try {
            const logs = await Promise.all(list.map(readTail));
            const body = JSON.stringify({ sources: logs });
            if (body !== last && !closed) {
              res.write(`event: logs\ndata: ${body}\n\n`);
              last = body;
            } else if (!closed) {
              res.write(': keepalive\n\n');
            }
          } catch (error) {
            const errorCode = error?.code || 'error';
            if (isFailureChange('diagnostics.stream.failed', 'logs', errorCode)) {
              log.debug('diagnostics.stream.failed', { sourceId: 'logs', errorCode });
            }
            if (!closed) {
              res.write('event: error\ndata: {"error":"Unable to read logs."}\n\n');
            }
          } finally {
            running = false;
          }
        }
        let timer;
        // The GET request itself completes immediately; the response remains
        // open for the lifetime of the event stream.
        res.on?.('close', () => {
          closed = true;
          clearInterval(timer);
          log.debug('diagnostics.stream.stopped');
        });
        await send();
        if (!closed) {
          timer = setInterval(send, streamIntervalMs);
          timer.unref?.();
          log.debug('diagnostics.stream.started');
        }
        return;
      }
      if (url.pathname !== '/' && url.pathname !== '') {
        return json(res, { error: 'Not found' }, 404);
      }
      json(res, { sources: await Promise.all(list.map(readTail)) });
    });
  }
  return { name: 'forge-diagnostics', configureServer: attach, configurePreviewServer: attach };
}
