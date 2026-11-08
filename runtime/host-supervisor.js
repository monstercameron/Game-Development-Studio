import { fork } from 'node:child_process';

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
  }
  scheduleRestart(started, reason) {
    if (this.stopping || this.finished) {
      return;
    }
    this.failures = (Date.now() - started > 30000 ? 0 : this.failures) + 1;
    const delay = Math.min(this.restartDelay * 2 ** Math.min(this.failures - 1, 6), 10000);
    this.log(
      `Supervisor event=host_restart_scheduled reason=${reason} attempt=${this.failures} delay_ms=${delay}`,
    );
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
    if (this.stopping) {
      this.log('INFO', 'Supervisor event=host_stopped reason=shutdown');
      this.finishStop();
      return;
    }
    const reason = code === null && signal === null ? 'spawn_failed' : 'process_exit';
    this.log(`Supervisor event=host_stopped reason=${reason}`);
    if (code === 78) {
      this.finished = true;
      this.log('Supervisor event=host_fatal reason=startup_configuration');
      this.onFatal();
      return;
    }
    this.scheduleRestart(started, reason);
  }
  start() {
    if (this.stopping || this.finished || this.child || this.timer) {
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
      this.scheduleRestart(started, 'spawn_failed');
      return;
    }
    this.child = host;
    host.on('message', (message) => {
      if (message?.type !== 'engine_request') {
        return;
      }
      const reply = (result, error) => {
        if (host.connected) {
          host.send({ type: 'engine_reply', id: message.id, result, error }, (sendError) => {
            if (sendError) {
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
            reply(undefined, error.message);
          },
        );
    });
    host.on('error', (_error) => {
      this.log('Supervisor event=host_process_error reason=process_error');
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
    this.onStopped();
  }
  stop() {
    if (this.stopping || this.finished) {
      return;
    }
    this.stopping = true;
    this.log('Supervisor event=host_stopping');
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
    } catch {
      // The host may already have exited; the stop timer still completes shutdown.
    }
    this.stopTimer = setTimeout(() => {
      host.kill();
      this.finishStop();
    }, 5000);
    this.stopTimer.unref();
  }
}
