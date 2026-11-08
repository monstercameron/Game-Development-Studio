import { fork } from 'node:child_process';
import { createCrashLoopGuard, markRecoveryNeeded } from './crash-loop.js';
import { createRuntimeLog } from './runtime-log.js';
import { buildModelCatalog } from './model-catalog.js';
import { LORA_FOLDER_NAME, listImageLoras } from './image-loras.js';
import { createLogger } from './app-log.js';

const appLog = createLogger('supervisor');

// Only a real integer pid is logged; a placeholder string would be dropped by the log allow-list.
function knownPid(child) {
  return Number.isSafeInteger(child?.pid) ? child.pid : undefined;
}

const ENGINE_OPERATIONS = new Set([
  'health',
  'services',
  'hardware',
  'jobs',
  'modelStorage',
  'modelCatalog',
  'job',
  'enqueue',
  'enqueueChain',
  'estimate',
  'decide',
  'transcribe',
  'loadChat',
  'loadMusic',
  'loadSound',
  'loadTts',
  'loadAsr',
  'asrLatency',
  'setAsrLatency',
  'loadGame',
  'loadHunyuan',
  'loadTrellis',
  'loadSam31',
  'loadHyMotion',
  'loadMotionBricks',
  'clearWaiting',
  'clearMusicLoadBarrier',
  'clearSoundLoadBarrier',
  'clearTtsLoadBarrier',
  'clearAsrLoadBarrier',
  'clearGameLoadBarrier',
  'clearHunyuanLoadBarrier',
  'clearTrellisLoadBarrier',
  'clearSam31LoadBarrier',
  'clearHyMotionLoadBarrier',
  'clearMotionBricksLoadBarrier',
  'startEngines',
  'startEngine',
  'cancel',
  'resolve',
  'retry',
  'move',
  'offload',
  'forceStop',
  'closeModel',
  'removeModel',
]);

function safeOperation(method) {
  return ENGINE_OPERATIONS.has(method) ? method : 'unknown';
}

export class RuntimeSupervisor {
  constructor({
    workerUrl = new URL('./worker.js', import.meta.url),
    restartDelay = 250,
    timeout = 8000,
    env = process.env,
    engineBroker = null,
    forkWorker = fork,
    log = null,
    crashLoop = createCrashLoopGuard(),
    runtimeDirectory = undefined,
  } = {}) {
    this.workerUrl = workerUrl;
    this.restartDelay = restartDelay;
    this.timeout = timeout;
    this.env = env;
    this.engineBroker = engineBroker;
    this.forkWorker = forkWorker;
    this.log =
      log ||
      ((level, message, raw) => {
        const output = level === 'ERROR' ? process.stderr : process.stdout;
        output.write(raw ? message : `[forge runtime] ${message}\n`);
      });
    this.pending = new Map();
    this.nextId = 0;
    this.restarts = 0;
    this.stopped = false;
    this.child = null;
    this.timer = null;
    this.ready = false;
    this.crashLoop = crashLoop;
    this.runtimeDirectory = runtimeDirectory;
    this.crashLooped = false;
  }
  scheduleRestart() {
    if (this.stopped || this.crashLooped) {
      return;
    }
    // A runtime worker that keeps crashing is not restarted forever. The queue is durable, so
    // stopping loses nothing; the Recovery panel and /api/runtime/health say what happened.
    const loop = this.crashLoop.record();
    if (loop.tripped) {
      this.crashLooped = true;
      appLog.error('supervisor.restart.capped', {
        count: loop.count,
        windowMs: loop.windowMs,
        reason: 'crash_loop',
      });
      this.log(
        'ERROR',
        `Supervisor event=worker_crash_loop attempts=${loop.count} auto_restart=stopped`,
      );
      markRecoveryNeeded(
        'runtime worker',
        loop,
        this.runtimeDirectory ? { directory: this.runtimeDirectory } : {},
      );
      return;
    }
    this.restarts++;
    const delay = Math.min(this.restartDelay * 2 ** Math.min(this.restarts - 1, 5), 10000);
    appLog.warn('supervisor.worker.restart.scheduled', {
      restartCount: this.restarts,
      delayMs: delay,
    });
    this.log(
      'WARN',
      `Supervisor event=restart_scheduled attempt=${this.restarts} delay_ms=${delay}`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
    this.timer.unref();
  }
  workerStopped(child, code = null, signal = null) {
    if (this.child !== child) {
      return;
    }
    const reason = code === null && signal === null ? 'spawn_failed' : 'process_exit';
    const exitFields = {
      pid: knownPid(child),
      exitCode: code,
      signal,
      restartCount: this.restarts,
      reason,
    };
    if (this.stopped) {
      appLog.info('supervisor.worker.exited', exitFields);
    } else {
      appLog.error('supervisor.worker.exited', exitFields);
    }
    const pid = Number.isSafeInteger(child.pid) ? child.pid : 'unknown';
    this.log(
      this.stopped ? 'INFO' : 'ERROR',
      `Supervisor event=worker_stopped pid=${pid} reason=${reason}`,
    );
    this.child = null;
    this.ready = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Runtime process stopped; retry the request.'));
    }
    this.pending.clear();
    this.scheduleRestart();
  }
  start() {
    if (this.stopped || this.child || this.timer || this.crashLooped) {
      return;
    }
    let child;
    try {
      this.log('INFO', 'Supervisor event=worker_starting');
      child = this.forkWorker(this.workerUrl, [], {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: this.env,
      });
    } catch (error) {
      this.log('ERROR', 'Supervisor event=worker_start_failed reason=spawn_failed');
      appLog.error('supervisor.worker.start.failed', {
        reason: 'spawn_failed',
        errorClass: error?.name,
        restartCount: this.restarts,
      });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    appLog.info('supervisor.worker.spawned', {
      pid: knownPid(child),
      restartCount: this.restarts,
    });
    this.ready = false;
    child.stdout.on('data', (data) => this.log('INFO', data, true));
    child.stderr.on('data', (data) => this.log('ERROR', data, true));
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        this.ready = true;
        const pid = Number.isSafeInteger(child.pid) ? child.pid : 'unknown';
        this.log('INFO', `Supervisor event=worker_ready pid=${pid}`);
        appLog.info('supervisor.worker.ready', { pid: knownPid(child) });
        return;
      }
      if (message?.type === 'engine_request') {
        const reply = (result, error) => {
          if (child.connected) {
            child.send({ type: 'engine_reply', id: message.id, result, error }, (sendError) => {
              if (sendError) {
                appLog.warn('supervisor.broker.reply.failed', {
                  operation: safeOperation(message.method),
                  reason: 'send_failed',
                });
                this.log(
                  'WARN',
                  `Supervisor event=broker_reply_failed operation=${safeOperation(message.method)} reason=send_failed`,
                );
              }
            });
          }
        };
        if (!this.engineBroker) {
          this.log(
            'WARN',
            `Supervisor event=broker_unavailable operation=${safeOperation(message.method)} reason=unavailable`,
          );
          appLog.warn('supervisor.broker.unavailable', {
            operation: safeOperation(message.method),
            reason: 'unavailable',
          });
          reply(undefined, 'Engine supervisor unavailable.');
          return;
        }
        this.engineBroker.call(message.method, message.params).then(
          (result) => reply(result, undefined),
          (error) => {
            this.log(
              'WARN',
              `Supervisor event=broker_call_failed operation=${safeOperation(message.method)} reason=broker_error`,
            );
            appLog.warn('supervisor.broker.call.failed', {
              operation: safeOperation(message.method),
              reason: 'broker_error',
              errorClass: error?.name,
            });
            reply(undefined, error.message);
          },
        );
        return;
      }
      const pending = this.pending.get(message?.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
    });
    child.on('error', (_error) => {
      this.log('ERROR', 'Supervisor event=worker_process_error reason=process_error');
      appLog.error('supervisor.worker.error', {
        reason: 'process_error',
        pid: knownPid(child),
      });
      if (child.pid === null || child.pid === undefined) {
        this.workerStopped(child);
      }
    });
    child.once('exit', (code, signal) => this.workerStopped(child, code, signal));
  }
  call(method, params = {}, timeout = this.timeout) {
    if (!this.child?.connected || !this.ready) {
      return Promise.reject(new Error('Runtime is starting or restarting.'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const operation = safeOperation(method);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log('WARN', `Supervisor event=rpc_timeout operation=${operation} reason=timeout`);
        appLog.warn('supervisor.call.timeout', {
          operation,
          reason: 'timeout',
          durationMs: timeout,
        });
        reject(new Error('Runtime request timed out.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, method, params }, (error) => {
        if (error && this.pending.has(id)) {
          this.log(
            'WARN',
            `Supervisor event=rpc_send_failed operation=${operation} reason=send_failed`,
          );
          clearTimeout(timer);
          this.pending.delete(id);
          appLog.warn('supervisor.call.send.failed', {
            operation,
            reason: 'send_failed',
            errorClass: error?.name,
          });
          reject(error);
        }
      });
    });
  }
  status() {
    return {
      ready: this.ready,
      pid: this.child?.pid ?? null,
      restarts: this.restarts,
      crashLooped: this.crashLooped,
    };
  }
  stop() {
    if (!this.stopped) {
      this.log('INFO', 'Supervisor event=stop_requested');
      appLog.info('supervisor.stop.requested', { restartCount: this.restarts });
    }
    this.stopped = true;
    clearTimeout(this.timer);
    this.child?.kill();
  }
}

export function runtimeService({ engineBroker = null } = {}) {
  const runtimeLog = createRuntimeLog();
  const supervisor = new RuntimeSupervisor({
    engineBroker,
    env: { ...process.env, FORGE_ENGINE_BROKER: engineBroker ? '1' : '0' },
    log: (...args) => runtimeLog.write(...args),
  });
  function attach(server) {
    supervisor.start();
    server.middlewares.use('/api/models', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const send = (status, data) => {
        res.statusCode = status;
        res.end(JSON.stringify(data));
      };
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) {
        return send(403, { error: 'Local studio requests only.' });
      }
      if (new URL(req.url, 'http://127.0.0.1').pathname !== '/') {
        return send(404, { error: 'Not found.' });
      }
      if (req.method !== 'GET') {
        return send(405, { error: 'Method not allowed.' });
      }
      try {
        return send(200, await supervisor.call('modelCatalog'));
      } catch (error) {
        appLog.debug('supervisor.models.fallback', {
          reason: 'runtime_unavailable',
          errorClass: error?.name,
        });
        return send(200, {
          ...buildModelCatalog(),
          runtimeError: 'Live model status and storage inventory are temporarily unavailable.',
        });
      }
    });
    server.middlewares.use('/api/runtime', async (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      const send = (status, data) => {
        res.statusCode = status;
        res.end(JSON.stringify(data));
      };
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) {
        return send(403, { error: 'Local studio requests only.' });
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      // A plain folder listing; it needs neither the worker nor a running engine.
      if (req.method === 'GET' && url.pathname === '/image-loras') {
        return send(200, { folder: `models/${LORA_FOLDER_NAME}`, loras: listImageLoras() });
      }
      const routes = {
        '/health': 'health',
        '/services': 'services',
        '/hardware': 'hardware',
        '/jobs': 'jobs',
        '/model-storage': 'modelStorage',
        '/asr/latency': 'asrLatency',
      };
      const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(cancel|resolve|retry|move))?$/i.exec(
        url.pathname,
      );
      const modelMatch =
        /^\/models\/(music|sfx|images|video|tts|3d-hunyuan|3d-trellis|segmentation|motion-hy|motion-bricks|asr|game)\/offload$/.exec(
          url.pathname,
        );
      const forceMatch =
        /^\/models\/(chat|music|sfx|images|video|world|tts|3d-hunyuan|3d-trellis|segmentation|motion-hy|motion-bricks|asr|game)\/force-stop$/.exec(
          url.pathname,
        );
      const closeMatch =
        /^\/models\/(music|sfx|images|video|world|tts|3d-hunyuan|3d-trellis|segmentation|motion-hy|motion-bricks|asr|game)\/close$/.exec(
          url.pathname,
        );
      const startMatch = /^\/engines\/([a-z0-9][a-z0-9-]{0,39})\/start$/.exec(url.pathname);
      const removeMatch =
        /^\/models\/(tts|3d-hunyuan|segmentation|motion-hy|motion-bricks|asr)\/remove$/.exec(
          url.pathname,
        );
      let method,
        params = {};
      if (req.method === 'GET') {
        method = match && !match[2] ? 'job' : routes[url.pathname];
      } else if (req.method === 'POST') {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers['x-forge-request'] !== 'runtime'
        ) {
          return send(403, { error: 'Local studio requests only.' });
        }
        if (url.pathname === '/jobs/clear-waiting') {
          method = 'clearWaiting';
        } else if (url.pathname === '/models/chat/load') {
          method = 'loadChat';
        } else if (url.pathname === '/jobs') {
          method = 'enqueue';
        } else if (url.pathname === '/jobs/chain') {
          method = 'enqueueChain';
        } else if (url.pathname === '/estimate') {
          method = 'estimate';
        } else if (url.pathname === '/game/decide') {
          method = 'decide';
        } else if (url.pathname === '/asr/transcribe') {
          method = 'transcribe';
        } else if (url.pathname === '/models/music/load') {
          method = 'loadMusic';
        } else if (url.pathname === '/models/sfx/load') {
          method = 'loadSound';
        } else if (url.pathname === '/models/tts/load') {
          method = 'loadTts';
        } else if (url.pathname === '/models/asr/load') {
          method = 'loadAsr';
        } else if (url.pathname === '/asr/latency') {
          method = 'setAsrLatency';
        } else if (url.pathname === '/models/game/load') {
          method = 'loadGame';
        } else if (url.pathname === '/models/3d-hunyuan/load') {
          method = 'loadHunyuan';
        } else if (url.pathname === '/models/3d-trellis/load') {
          method = 'loadTrellis';
        } else if (url.pathname === '/models/segmentation/load') {
          method = 'loadSam31';
        } else if (url.pathname === '/models/motion-hy/load') {
          method = 'loadHyMotion';
        } else if (url.pathname === '/models/motion-bricks/load') {
          method = 'loadMotionBricks';
        } else if (url.pathname === '/models/music/clear-load-barrier') {
          method = 'clearMusicLoadBarrier';
        } else if (url.pathname === '/models/sfx/clear-load-barrier') {
          method = 'clearSoundLoadBarrier';
        } else if (url.pathname === '/models/tts/clear-load-barrier') {
          method = 'clearTtsLoadBarrier';
        } else if (url.pathname === '/models/asr/clear-load-barrier') {
          method = 'clearAsrLoadBarrier';
        } else if (url.pathname === '/models/game/clear-load-barrier') {
          method = 'clearGameLoadBarrier';
        } else if (url.pathname === '/models/3d-hunyuan/clear-load-barrier') {
          method = 'clearHunyuanLoadBarrier';
        } else if (url.pathname === '/models/3d-trellis/clear-load-barrier') {
          method = 'clearTrellisLoadBarrier';
        } else if (url.pathname === '/models/segmentation/clear-load-barrier') {
          method = 'clearSam31LoadBarrier';
        } else if (url.pathname === '/models/motion-hy/clear-load-barrier') {
          method = 'clearHyMotionLoadBarrier';
        } else if (url.pathname === '/models/motion-bricks/clear-load-barrier') {
          method = 'clearMotionBricksLoadBarrier';
        } else if (url.pathname === '/engines/start-all') {
          method = 'startEngines';
        } else if (startMatch) {
          method = 'startEngine';
        } else if (modelMatch) {
          method = 'offload';
        } else if (match && match[2]) {
          method = match[2];
        }
        if (removeMatch) {
          method = 'removeModel';
        }
        if (forceMatch) {
          method = 'forceStop';
        }
        if (closeMatch) {
          method = 'closeModel';
        }
        if (!method) {
          return send(404, { error: 'Not found.' });
        }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > (method === 'decide' ? 210000 : 32000)) {
              return send(413, { error: 'Request too large.' });
            }
          }
          params = body ? JSON.parse(body) : {};
          if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw Error('Expected a JSON object.');
          }
        } catch (error) {
          appLog.warn('supervisor.request.rejected', {
            operation: safeOperation(method),
            reason: 'invalid_body',
            errorClass: error?.name,
          });
          return send(400, { error: 'Invalid request body.' });
        }
      } else {
        return send(405, { error: 'Method not allowed.' });
      }
      if (!method) {
        return send(404, { error: 'Not found.' });
      }
      if (match) {
        params.id = match[1];
      }
      if (modelMatch) {
        params.id = modelMatch[1];
      }
      if (forceMatch) {
        params.id = forceMatch[1];
      }
      if (closeMatch) {
        params.id = closeMatch[1];
      }
      if (removeMatch) {
        params.id = removeMatch[1];
      }
      if (startMatch) {
        params.id = startMatch[1];
      }
      try {
        const result = await supervisor.call(
          method,
          params,
          method === 'transcribe'
            ? 130000
            : method === 'decide' || method === 'forceStop' || method === 'closeModel'
              ? 65000
              : method === 'offload'
                ? 30000
                : method === 'removeModel'
                  ? 15000
                  : [
                        'loadChat',
                        'loadMusic',
                        'loadSound',
                        'loadTts',
                        'loadAsr',
                        'loadGame',
                        'loadHunyuan',
                        'loadTrellis',
                        'loadSam31',
                        'loadHyMotion',
                        'loadMotionBricks',
                      ].includes(method)
                    ? 20000
                    : undefined,
        );
        if (method === 'decide') {
          return send(result.status, result.result);
        }
        if (method === 'move') {
          return send(result.status, result.body);
        }
        if (
          [
            'loadChat',
            'loadMusic',
            'loadSound',
            'loadTts',
            'loadAsr',
            'loadGame',
            'loadHunyuan',
            'loadTrellis',
            'loadSam31',
            'loadHyMotion',
            'loadMotionBricks',
          ].includes(method)
        ) {
          return send(result.status, result.body);
        }
        send(
          ['enqueue', 'enqueueChain'].includes(method) ? 201 : method === 'removeModel' ? 202 : 200,
          method === 'health' ? { ...result, supervisor: supervisor.status() } : result,
        );
      } catch (error) {
        const unavailable =
          !supervisor.status().ready || /timed out|process stopped/i.test(error.message);
        appLog.debug('supervisor.call.failed', {
          operation: safeOperation(method),
          reason: unavailable ? 'unavailable' : 'rejected',
          errorClass: error?.name,
        });
        send(unavailable ? 503 : 400, { error: error.message, supervisor: supervisor.status() });
      }
    });
    server.httpServer?.once('close', () => {
      supervisor.stop();
      runtimeLog.close();
    });
  }
  return {
    name: 'forge-runtime-supervisor',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
