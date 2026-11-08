// The clean-shutdown marker. The stable parent process (server.js) records that a studio
// session is running and rewrites the record as "clean" only at the end of an orderly stop. At
// the next start the absence of that marker means the previous session ended abnormally (crash,
// kill, power loss, forced shutdown) and a Recovery report is produced. A heartbeat, rewritten
// every HEARTBEAT_MS, tells the report when the studio was last known to be alive. Writes use
// the atomic protocol of durable-file.js, so a power loss leaves the old or the new record.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from './durable-file.js';
import { defaultRuntimeDirectory } from './recovery-events.js';
import { createLogger } from './app-log.js';

const log = createLogger('supervisor');

export const SESSION_FILE = 'session-state.json';
export const HEARTBEAT_MS = 30_000;
// A wall-clock jump much larger than the timer period means the computer was suspended.
export const SUSPEND_GAP_MS = 30_000;

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (error) {
    // A missing file is the normal first start; other failures leave the state unknown.
    log.debug('session.marker.read.failed', { errorClass: error?.name, errorCode: error?.code });
    return null;
  }
}

function describePrevious(record) {
  if (!record) {
    return { state: 'none' };
  }
  const clean = record.state === 'clean';
  return {
    state: clean ? 'clean' : 'unclean',
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    startedAt: record.startedAt || null,
    lastAliveAt: clean ? record.endedAt || null : record.heartbeatAt || record.startedAt || null,
    endedAt: record.endedAt || null,
    // 'forced' means a stop was requested but did not finish before its deadline.
    endReason: record.endReason || null,
  };
}

/**
 * Starts a session and reports how the previous one ended.
 * `previous.state` is 'none' on the first start, 'clean' after an orderly stop, and 'unclean'
 * when the clean marker is missing.
 * @param {{ directory?: string, now?: () => Date, pid?: number }} [options]
 */
export function beginSession({
  directory = defaultRuntimeDirectory(),
  now = () => new Date(),
  pid = process.pid,
} = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, SESSION_FILE);
  const previous = describePrevious(readJson(file));
  const startedAt = now().toISOString();
  const record = {
    version: 1,
    sessionId: randomUUID(),
    pid,
    startedAt,
    heartbeatAt: startedAt,
    state: 'running',
  };
  atomicWriteFileSync(file, `${JSON.stringify(record)}\n`);
  if (previous.state === 'unclean') {
    log.warn('session.unclean.detected', { reason: previous.endReason ?? 'none' });
  }
  log.info('session.started', { sessionId: record.sessionId, previousState: previous.state });
  let heartbeat = null;
  let ended = false;
  let lastTick = Date.now();
  const suspendListeners = new Set();

  function write(extra) {
    atomicWriteFileSync(file, `${JSON.stringify({ ...record, ...extra })}\n`);
  }

  return {
    sessionId: record.sessionId,
    startedAt,
    previous,
    /**
     * Starts the heartbeat. Also notices a wall-clock gap (the computer slept) and calls the
     * listeners registered with onResume. Returns nothing; call end() to stop it.
     */
    startHeartbeat({ intervalMs = HEARTBEAT_MS, gapMs = SUSPEND_GAP_MS } = {}) {
      if (heartbeat || ended) {
        return;
      }
      lastTick = Date.now();
      heartbeat = setInterval(() => {
        const current = Date.now();
        const gap = current - lastTick - intervalMs;
        lastTick = current;
        if (gap > gapMs) {
          for (const listener of suspendListeners) {
            try {
              listener({ gapMs: gap });
            } catch (error) {
              // A listener failure must not stop the heartbeat.
              log.warn('session.resume.listener.failed', {
                errorClass: error?.name,
                errorCode: error?.code,
              });
            }
          }
        }
        try {
          write({ heartbeatAt: new Date(current).toISOString() });
        } catch (error) {
          // A missed heartbeat only makes the "last alive" time older.
          log.debug('session.heartbeat.write.failed', {
            errorClass: error?.name,
            errorCode: error?.code,
          });
        }
      }, intervalMs);
      heartbeat.unref();
      log.debug('session.heartbeat.started', { intervalMs });
    },
    onResume(listener) {
      suspendListeners.add(listener);
      return () => suspendListeners.delete(listener);
    },
    /**
     * Writes the end marker. `clean: false` records a stop that was requested but did not finish
     * in time (state 'forced'), which the next start treats like an unclean exit.
     * Safe to call more than once.
     */
    end(reason = 'stopped', { clean = true } = {}) {
      if (ended) {
        return;
      }
      ended = true;
      clearInterval(heartbeat);
      heartbeat = null;
      const endState = clean ? 'clean' : 'forced';
      const endReason = String(reason).slice(0, 40);
      try {
        write({
          state: endState,
          endedAt: now().toISOString(),
          endReason,
        });
        if (clean) {
          log.info('session.stop.recorded', { state: endState, reason: endReason });
        } else {
          log.warn('session.stop.recorded', { state: endState, reason: endReason });
        }
      } catch (error) {
        // If the marker cannot be written, the next start treats this stop as unclean, which
        // only produces an unnecessary (and harmless) Recovery report.
        log.warn('session.marker.write.failed', {
          state: endState,
          errorClass: error?.name,
          errorCode: error?.code,
        });
      }
    },
  };
}

/**
 * Detects wall-clock gaps in a process that has no session of its own (the studio host and the
 * runtime worker). Calls `onResume({ gapMs })` after a gap longer than `gapMs` beyond the period.
 * @returns {() => void} stop function
 */
export function watchForSuspend(onResume, { intervalMs = 5000, gapMs = SUSPEND_GAP_MS } = {}) {
  let last = Date.now();
  const timer = setInterval(() => {
    const current = Date.now();
    const gap = current - last - intervalMs;
    last = current;
    if (gap > gapMs) {
      try {
        onResume({ gapMs: gap });
      } catch (error) {
        // The watcher keeps running whatever the listener does.
        log.warn('session.resume.listener.failed', {
          errorClass: error?.name,
          errorCode: error?.code,
        });
      }
    }
  }, intervalMs);
  timer.unref();
  log.debug('session.suspend_watch.started', { intervalMs });
  return () => clearInterval(timer);
}
