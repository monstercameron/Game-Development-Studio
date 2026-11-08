import { fork } from 'node:child_process';
import { createCrashLoopGuard, markRecoveryNeeded } from './crash-loop.js';
import { recordRecoveryEvent } from './recovery-events.js';
import { createLogger } from './app-log.js';

const appLog = createLogger('supervisor');

const ENGINE_OPERATIONS = new Set([
  'status',
  'speechActivity',
  'gameActivity',
  'requestGameLoad',
  'start',
  'startOne',
  'startAll',
  'offload',
  'forceStop',
  'removeModel',
]);

function safeOperation(method) {
  return ENGINE_OPERATIONS.has(method) ? method : 'unknown';
}

// Only a real integer pid is logged; a placeholder string would be dropped by the log allow-list.
function knownPid(child) {
  return Number.isSafeInteger(child?.pid) ? child.pid : undefined;
}

// Owns the HTTP host but not the engines, whose handles remain in the parent.
export class HostSupervisor {
  constructor({
    port,
    engines,
    log = console.error,
    onStopped = () => {},
    onFatal = () => {},
    forkHost = fork,
    hostUrl = new URL('./http-server.js', import.meta.url),
    env = process.env,
    restartDelay = 250,
    crashLoop = createCrashLoopGuard(),
    // Called once, after the host crashed too often to keep restarting it.
    onCrashLoop = () => {},
    runtimeDirectory = undefined,
  } = {}) {
    this.port = port;
    this.engines = engines;
    this.log = log;
    this.onStopped = onStopped;
    this.onFatal = onFatal;
    this.forkHost = forkHost;
    this.hostUrl = hostUrl;
    this.env = env;
    this.restartDelay = restartDelay;
    this.child = null;
    this.timer = null;
    this.stopTimer = null;
    this.stopping = false;
    this.finished = false;
    this.failures = 0;
    this.startCount = 0;
    this.crashLoop = crashLoop;
    this.onCrashLoop = onCrashLoop;
    this.runtimeDirectory = runtimeDirectory;
    this.crashLooped = false;
  }
  scheduleRestart(started, reason) {
    if (this.stopping || this.finished || this.crashLooped) {
      return;
    }
    // Restarting forever hides a persistent fault. After too many crashes in a short window the
    // supervisor stops and the studio reports that recovery is needed (docs/RESILIENCE.md).
    const loop = this.crashLoop.record();
    const eventOptions = this.runtimeDirectory ? { directory: this.runtimeDirectory } : {};
    recordRecoveryEvent(
      {
        code: 'supervisor.host_crashed',
        severity: 'warn',
        kind: 'process',
        id: 'host',
        count: loop.count,
      },
      eventOptions,
    );
    if (loop.tripped) {
      this.crashLooped = true;
      this.log(`Supervisor event=host_crash_loop attempts=${loop.count} auto_restart=stopped`);
      appLog.error('supervisor.restart.capped', {
        count: loop.count,
        windowMs: loop.windowMs,
        reason: 'crash_loop',
      });
      markRecoveryNeeded('host', loop, eventOptions);
      this.onCrashLoop(loop);
      return;
    }
    this.failures = (Date.now() - started > 30000 ? 0 : this.failures) + 1;
    const delay = Math.min(this.restartDelay * 2 ** Math.min(this.failures - 1, 6), 10000);
    this.log(
      `Supervisor event=host_restart_scheduled reason=${reason} attempt=${this.failures} delay_ms=${delay}`,
    );
    appLog.warn('supervisor.host.restart.scheduled', {
      reason,
      attempt: this.failures,
      delayMs: delay,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay);
  }
  hostStopped(host, started, code, signal) {
    if (this.child !== host) {
      return;
    }
    this.child = null;
    const exitFields = {
      pid: knownPid(host),
      exitCode: code,
      signal,
      startCount: this.startCount,
      durationMs: Date.now() - started,
    };
    if (this.stopping) {
      appLog.info('supervisor.host.exited', { ...exitFields, reason: 'shutdown' });
      this.log('INFO', 'Supervisor event=host_stopped reason=shutdown');
      this.finishStop();
      return;
    }
    const reason = code === null && signal === null ? 'spawn_failed' : 'process_exit';
    appLog.warn('supervisor.host.exited', { ...exitFields, reason });
    this.log(`Supervisor event=host_stopped reason=${reason}`);
    if (code === 78) {
      this.finished = true;
      appLog.error('supervisor.host.fatal', { exitCode: code, reason: 'startup_configuration' });
      this.log('Supervisor event=host_fatal reason=startup_configuration');
      this.onFatal();
      return;
    }
    this.scheduleRestart(started, reason);
  }
  /** Clears the crash-loop stop (the user chose to try again) and starts the host. */
  retryAfterCrashLoop() {
    this.crashLoop.reset();
    appLog.info('supervisor.restart.retried', { reason: 'user_retry' });
    this.crashLooped = false;
    this.failures = 0;
    this.start();
  }
  start() {
    if (this.stopping || this.finished || this.child || this.timer || this.crashLooped) {
      return;
    }
    const started = Date.now();
    let host;
    try {
      this.log('Supervisor event=host_starting');
      host = this.forkHost(this.hostUrl, [String(this.port)], {
        execArgv: [],
        env: {
          ...this.env,
          FORGE_SERVICE_SUPERVISOR_PID: String(process.pid),
          FORGE_ENGINE_BROKER: '1',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      });
    } catch (error) {
      this.log('Supervisor event=host_start_failed reason=spawn_failed');
      appLog.error('supervisor.host.start.failed', {
        reason: 'spawn_failed',
        errorClass: error?.name,
        startCount: this.startCount,
      });
      this.scheduleRestart(started, 'spawn_failed');
      return;
    }
    this.child = host;
    this.startCount += 1;
    appLog.info('supervisor.host.spawned', { pid: knownPid(host), startCount: this.startCount });
    host.on('message', (message) => {
      if (message?.type !== 'engine_request') {
        return;
      }
      const reply = (result, error) => {
        if (host.connected) {
          host.send({ type: 'engine_reply', id: message.id, result, error }, (sendError) => {
            if (sendError) {
              appLog.warn('supervisor.broker.reply.failed', {
                operation: safeOperation(message.method),
                reason: 'send_failed',
              });
              this.log(
                `Supervisor event=host_broker_reply_failed operation=${safeOperation(message.method)} reason=send_failed`,
              );
            }
          });
        }
      };
      const allowed = {
        status: () => this.engines.status(),
        speechActivity: () => this.engines.speechActivity(),
        gameActivity: () => this.engines.gameActivity(),
        requestGameLoad: () => this.engines.requestGameLoad(),
        start: () => this.engines.start(message.params?.id, message.params?.options),
        startOne: () => this.engines.startOne(message.params?.id),
        startAll: () => this.engines.startAll(),
        offload: () => this.engines.offload(message.params?.id),
        forceStop: () => this.engines.forceStop(message.params?.id),
        removeModel: () =>
          this.engines.removeModel(message.params?.id, message.params?.retry === true),
      };
      if (!Object.hasOwn(allowed, message.method)) {
        reply(undefined, 'Unknown engine operation.');
        return;
      }
      Promise.resolve()
        .then(allowed[message.method])
        .then(
          (result) => reply(result, undefined),
          (error) => {
            this.log(
              `Supervisor event=host_broker_call_failed operation=${safeOperation(message.method)} reason=broker_error`,
            );
            appLog.warn('supervisor.broker.call.failed', {
              operation: safeOperation(message.method),
              reason: 'broker_error',
              errorClass: error?.name,
            });
            reply(undefined, error.message);
          },
        );
    });
    host.on('error', (_error) => {
      this.log('Supervisor event=host_process_error reason=process_error');
      appLog.error('supervisor.host.error', { reason: 'process_error', pid: knownPid(host) });
      if (host.pid === null || host.pid === undefined) {
        this.hostStopped(host, started, null, null);
      }
    });
    host.once('exit', (code, signal) => this.hostStopped(host, started, code, signal));
  }
  finishStop() {
    if (this.finished) {
      return;
    }
    this.finished = true;
    clearTimeout(this.stopTimer);
    appLog.info('supervisor.stop.completed', { startCount: this.startCount });
    this.onStopped();
  }
  stop() {
    if (this.stopping || this.finished) {
      return;
    }
    this.stopping = true;
    this.log('Supervisor event=host_stopping');
    appLog.info('supervisor.host.stopping', { hasChild: Boolean(this.child) });
    clearTimeout(this.timer);
    this.timer = null;
    const host = this.child;
    if (!host) {
      this.finishStop();
      return;
    }
    try {
      if (host.connected) {
        host.send({ type: 'shutdown' }, () => {});
      }
    } catch (error) {
      appLog.debug('supervisor.host.shutdown.send.failed', { errorClass: error?.name });
      // The host may already have exited; the stop timer still completes shutdown.
    }
    this.stopTimer = setTimeout(() => {
      appLog.warn('supervisor.host.stop.forced', { pid: knownPid(host), reason: 'deadline' });
      host.kill();
      this.finishStop();
    }, 5000);
    this.stopTimer.unref();
  }
}
