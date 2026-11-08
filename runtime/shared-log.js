// Logger for runtime/ modules that are ALSO imported by the browser (src/), such as
// runtime/queue-order.js or runtime/*-options.js. This module is pure (no Node built-ins), so the
// Vite bundle can include it. It has the same API as runtime/app-log.js createLogger:
//
//   import { createLogger } from './shared-log.js';
//   const log = createLogger('queue');
//   log.info('queue.move.completed', { jobId });
//
// Records are handed to whichever real logger the process loaded: runtime/app-log.js in Node,
// src/app-log.js in the browser (each installs itself here when it is first imported). Records
// logged before that happen are kept (at most 200) and replayed. See docs/LOGGING.md.
const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error'];
// Records beyond this count are discarded while no sink is installed, so a process that never
// installs one cannot grow memory without bound.
const PENDING_CAP = 200;

// The real logger, or null until installSharedLogSink runs. `pending` holds records logged
// before that, in order, and is replayed when the sink arrives.
let sink = null;
const pending = [];

// performance.now() is monotonic and sub-millisecond; Date.now() is the fallback for runtimes
// (such as some Node test contexts) that do not expose a global performance object.
function currentTimeMs() {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Installs the real logger. Called by runtime/app-log.js and src/app-log.js; not for feature code.
 *
 * @param {{ log: Function, isEnabled: Function }} target
 *   log(component, level, event, fields, message, context) and isEnabled(component, level)
 */
export function installSharedLogSink(target) {
  sink = target;
  for (const entry of pending.splice(0)) {
    try {
      target.log(...entry);
    } catch {
      // log-coverage: ignore -- the sink itself never throws; this guards a broken test double
    }
  }
}

function write(component, level, event, fields, message, context) {
  try {
    if (sink) {
      sink.log(component, level, event, fields, message, context);
    } else if (pending.length < PENDING_CAP) {
      pending.push([component, level, event, fields, message, context]);
    }
  } catch {
    // log-coverage: ignore -- logging must never throw into the caller
  }
}

/**
 * Same contract as createLogger in runtime/app-log.js: trace/debug/info/warn/error(eventId,
 * fields?, message?), isEnabled(level), time(eventId, fields?) -> stop(extra?), child(context).
 */
export function createLogger(component, context = undefined) {
  const logger = { component };
  for (const level of LEVEL_NAMES) {
    logger[level] = (event, fields, message) =>
      write(component, level, event, fields, message, context);
  }
  logger.isEnabled = (level) => {
    try {
      return sink
        ? Boolean(sink.isEnabled(component, level))
        : level !== 'trace' && level !== 'debug';
    } catch {
      // log-coverage: ignore -- the logger's own level check; logging a failure here would recurse
      return false;
    }
  };
  logger.time = (event, fields) => {
    const started = currentTimeMs();
    return (extra) => {
      const durationMs = Math.round(currentTimeMs() - started);
      const hasError = Boolean(extra && extra.error !== undefined && extra.error !== null);
      write(
        component,
        hasError ? 'error' : 'info',
        event,
        { ...fields, ...extra, durationMs },
        '',
        context,
      );
      return durationMs;
    };
  };
  logger.child = (extraContext) => createLogger(component, { ...context, ...extraContext });
  return logger;
}
