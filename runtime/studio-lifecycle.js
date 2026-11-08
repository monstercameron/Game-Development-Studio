// Lifecycle of the stable parent process (server.js): the clean-shutdown marker, the signal and
// stop-request handlers, the shutdown deadline and the "Recovery needed" responder.
//
// An orderly stop (SIGINT, SIGTERM, SIGBREAK, SIGHUP, or a stop request file written by
// stop-server.ps1 or the tray when Windows is ending the session) asks the supervisor to stop the
// HTTP host. The host closes its server and, through the closed IPC channel, the runtime worker
// stops the queue and checkpoints SQLite. Only when that completed is the session marked clean.
// If it does not finish within `deadlineMs` the process exits anyway (a stuck shutdown must never
// hold up Windows shutdown) and the marker says the stop was forced, so the next start produces
// a Recovery report. Engines are detached and keep running: Forge reconnects to them.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './durable-file.js';
import { beginSession } from './session-state.js';
import { STARTUP_FILE } from './recovery-report.js';
import { defaultRuntimeDirectory, recordRecoveryEvent } from './recovery-events.js';
import { createLogger } from './app-log.js';

export const STOP_REQUEST_MAX_AGE_MS = 2 * 60 * 1000;
export const SHUTDOWN_DEADLINE_MS = 6000;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
// Named appLog because createStudioLifecycle takes a `log` callback option.
const appLog = createLogger('supervisor');

export function stopRequestFile(runtimeDirectory, port) {
  return path.join(runtimeDirectory, `stop-request-${port}.json`);
}

/**
 * @param {object} options
 * @param {number} options.port
 * @param {{ stop: () => void }} options.supervisor
 * @param {{ stop: () => void } | null} [options.tray]
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.runtimeDirectory]
 * @param {number} [options.deadlineMs]
 * @param {number} [options.pollMs]
 * @param {(code: number) => void} [options.exit]
 * @param {NodeJS.Process} [options.proc]
 * @param {() => Date} [options.now]
 */
export function createStudioLifecycle({
  port,
  supervisor,
  tray = null,
  log = () => {},
  runtimeDirectory = defaultRuntimeDirectory(),
  deadlineMs = SHUTDOWN_DEADLINE_MS,
  pollMs = 1000,
  exit = (code) => process.exit(code),
  proc = process,
  now = () => new Date(),
} = {}) {
  let session = null;
  let stopping = false;
  let deadlineTimer = null;
  let pollTimer = null;
  const listeners = new Map();
  const requestPath = stopRequestFile(runtimeDirectory, port);

  function readStopRequest() {
    try {
      const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
      return request && typeof request === 'object' ? request : null;
    } catch (error) {
      // No request file is the normal state; it is polled every second.
      if (error?.code !== 'ENOENT') {
        appLog.warn('supervisor.stop_request.read.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
      }
      return null;
    }
  }

  function checkStopRequest() {
    const request = readStopRequest();
    if (!request) {
      return;
    }
    const age = now().getTime() - Date.parse(request.requestedAt);
    fs.rmSync(requestPath, { force: true });
    if (request.pid === proc.pid && age >= 0 && age < STOP_REQUEST_MAX_AGE_MS) {
      shutdown(`request:${String(request.reason || 'stop').slice(0, 20)}`);
    } else {
      appLog.warn('supervisor.stop_request.ignored', {
        reason: request.pid === proc.pid ? 'stale' : 'other_process',
      });
    }
  }

  function finish(clean, reason, code = 0) {
    clearTimeout(deadlineTimer);
    session?.end(reason, { clean });
    exit(code);
  }

  function shutdown(reason) {
    if (stopping) {
      return;
    }
    stopping = true;
    appLog.info('supervisor.stop.requested', { reason });
    log(`Supervisor event=shutdown_requested reason=${reason}`);
    clearInterval(pollTimer);
    // Never hang an OS shutdown: leave after the deadline even if the host has not finished.
    deadlineTimer = setTimeout(() => {
      appLog.warn('supervisor.stop.deadline_reached', { deadlineMs });
      log('Supervisor event=shutdown_deadline action=exit');
      finish(false, 'deadline');
    }, deadlineMs);
    try {
      tray?.stop();
      supervisor.stop();
    } catch (error) {
      appLog.warn('supervisor.stop.failed', { errorClass: error?.name, errorCode: error?.code });
      log(`Supervisor event=shutdown_error reason=${error.code || 'error'}`);
    }
  }

  return {
    get session() {
      return session;
    },
    /** Called by the supervisor when the host has stopped normally. */
    stopped() {
      finish(true, 'stopped');
    },
    /** Called when the supervisor exits for a fatal configuration error (not a crash). */
    fatal() {
      finish(true, 'fatal', 1);
    },
    shutdown,
    /** Starts the session, reports the previous one and installs the handlers. */
    start() {
      fs.mkdirSync(runtimeDirectory, { recursive: true });
      session = beginSession({ directory: runtimeDirectory, now });
      const { previous } = session;
      const startupRecord = {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        previous,
      };
      atomicWriteFileSync(
        path.join(runtimeDirectory, STARTUP_FILE),
        `${JSON.stringify(startupRecord)}\n`,
      );
      if (previous.state === 'unclean') {
        // Child processes read this: a resumed download repeats its last megabytes, for example.
        proc.env.FORGE_PREVIOUS_UNCLEAN = '1';
        recordRecoveryEvent(
          {
            code: 'session.unclean_exit',
            severity: 'warn',
            kind: 'session',
            detail: previous.endReason
              ? `The previous session did not finish an orderly stop (${previous.endReason}).`
              : 'The previous session ended without an orderly shutdown (crash, kill or power loss).',
          },
          { directory: runtimeDirectory },
        );
      } else {
        delete proc.env.FORGE_PREVIOUS_UNCLEAN;
      }
      fs.rmSync(requestPath, { force: true });
      appLog.debug('supervisor.stop_request.cleared');
      session.startHeartbeat();
      for (const signal of STOP_SIGNALS) {
        const listener = () => shutdown(signal.toLowerCase());
        listeners.set(signal, listener);
        proc.on(signal, listener);
      }
      pollTimer = setInterval(checkStopRequest, pollMs);
      pollTimer.unref();
      return session;
    },
    /** Removes handlers; used by tests. */
    dispose() {
      clearInterval(pollTimer);
      clearTimeout(deadlineTimer);
      for (const [signal, listener] of listeners) {
        proc.off(signal, listener);
      }
      listeners.clear();
    },
  };
}
