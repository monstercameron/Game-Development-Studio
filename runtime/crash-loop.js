// Crash-loop protection. A supervisor that restarts a failing child forever hides the problem
// and can burn CPU, fill logs and corrupt state with every attempt. This guard counts abnormal
// exits in a sliding window; once the limit is reached the supervisor stops restarting and the
// studio reports "Recovery needed" instead of looping.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './durable-file.js';
import { defaultRuntimeDirectory, recordRecoveryEvent } from './recovery-events.js';
import { createLogger } from './app-log.js';

const log = createLogger('supervisor');

export const CRASH_LOOP_LIMIT = 5;
export const CRASH_LOOP_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_NEEDED_FILE = 'recovery-needed.json';

/**
 * @param {{ limit?: number, windowMs?: number, now?: () => number }} [options]
 */
export function createCrashLoopGuard({
  limit = CRASH_LOOP_LIMIT,
  windowMs = CRASH_LOOP_WINDOW_MS,
  now = Date.now,
} = {}) {
  let crashes = [];
  return {
    /** Records one abnormal exit. `tripped` is true once `limit` fall inside the window. */
    record() {
      const current = now();
      crashes = crashes.filter((time) => current - time < windowMs);
      crashes.push(current);
      const isTripped = crashes.length >= limit;
      log.warn('supervisor.crash.recorded', { count: crashes.length, limit, windowMs, isTripped });
      if (isTripped) {
        log.error('supervisor.crash_loop.tripped', { count: crashes.length, limit, windowMs });
      }
      return { tripped: isTripped, count: crashes.length, limit, windowMs };
    },
    /** Forget earlier crashes, for example after the user chose "try again". */
    reset() {
      crashes = [];
    },
    count() {
      const current = now();
      return crashes.filter((time) => current - time < windowMs).length;
    },
  };
}

/**
 * Persists that auto-restart stopped, so the next start and the Recovery report can say why.
 * A failed marker write is logged and not rethrown; the recovery journal entry is still attempted.
 */
export function markRecoveryNeeded(
  component,
  { count, windowMs },
  { directory = defaultRuntimeDirectory(), now = () => new Date() } = {},
) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteFileSync(
      path.join(directory, RECOVERY_NEEDED_FILE),
      `${JSON.stringify({ component, count, windowMs, at: now().toISOString() })}\n`,
    );
  } catch (error) {
    // The recovery journal below still records the event.
    log.warn('supervisor.recovery_marker.write.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
    });
  }
  recordRecoveryEvent(
    {
      code: 'supervisor.crash_loop',
      severity: 'error',
      kind: 'process',
      id: component,
      count,
      detail: `Stopped restarting ${component} after ${count} crashes in ${Math.round(windowMs / 60000)} minutes.`,
    },
    { directory },
  );
}

/**
 * Returns the parsed stop marker, or null when it is missing or unreadable.
 * The marker is not validated beyond JSON parsing; callers must check the fields they use.
 */
export function readRecoveryNeeded(directory = defaultRuntimeDirectory()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, RECOVERY_NEEDED_FILE), 'utf8'));
  } catch (error) {
    // A missing marker is the normal state; only a damaged one is worth a record.
    if (error?.code !== 'ENOENT') {
      log.debug('supervisor.recovery_marker.read.failed', {
        errorClass: error?.name,
        errorCode: error?.code,
      });
    }
    return null;
  }
}

/** The user asked to try again: remove the stop marker. */
export function clearRecoveryNeeded(directory = defaultRuntimeDirectory()) {
  fs.rmSync(path.join(directory, RECOVERY_NEEDED_FILE), { force: true });
  log.debug('supervisor.recovery_marker.cleared');
}
