// Streaming latency of the Nemotron speech engine. The model is cache-aware: its right context R
// sets a chunk of (R + 1) x 80 ms, so R = 0, 1, 6 and 13 are the 80, 160, 560 and 1120 ms modes.
// A smaller chunk answers sooner and a larger one is usually more accurate. The engine reads the
// value only at startup, so the choice is saved here and applied the next time the engine starts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';
import { atomicWriteFileSync } from './durable-file.js';

const log = createLogger('asr');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ASR_LATENCY_MS = 160;
export const ASR_LATENCY_MODES = Object.freeze({ 80: 0, 160: 1, 560: 6, 1120: 13 });
export const ASR_LATENCIES_MS = Object.freeze(Object.keys(ASR_LATENCY_MODES).map(Number));

export function asrLatencyFile(directory) {
  return path.join(
    directory || process.env.FORGE_RUNTIME_DIR || path.join(appRoot, '.forge-runtime'),
    'asr-latency.json',
  );
}

export function validateAsrLatency(value) {
  if (!ASR_LATENCIES_MS.includes(value)) {
    log.warn('asr.latency.rejected', { reason: 'unsupported_value', target: 'latencyMs' });
    throw Error(`Latency must be one of ${ASR_LATENCIES_MS.join(', ')} ms.`);
  }
  return value;
}

// An unreadable or invalid file means the default, never an error that blocks the engine.
export function readAsrLatency(file = asrLatencyFile()) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8')).latencyMs;
  } catch (error) {
    // A missing file is the normal first-run state, so this is debug rather than warn.
    log.debug('asr.latency.read.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
      reason: 'using_default',
    });
    return DEFAULT_ASR_LATENCY_MS;
  }
  if (ASR_LATENCIES_MS.includes(value)) {
    return value;
  }
  log.warn('asr.latency.rejected', { reason: 'invalid_stored_value', target: 'latencyMs' });
  return DEFAULT_ASR_LATENCY_MS;
}

export function writeAsrLatency(value, file = asrLatencyFile()) {
  validateAsrLatency(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ latencyMs: value });
  try {
    // Staged, flushed and renamed: a crash leaves the old value or the new one.
    atomicWriteFileSync(file, text);
  } catch (error) {
    log.error('asr.latency.write.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
      reason: 'not_saved',
    });
    throw error;
  }
  log.debug('asr.latency.saved', { latencyMs: value, bytes: Buffer.byteLength(text) });
  return value;
}

// Extra engine arguments for the saved mode. The default adds none, so the command line is
// exactly what it was before the setting existed.
export function asrLatencyArgs(file = asrLatencyFile()) {
  const latency = readAsrLatency(file);
  return latency === DEFAULT_ASR_LATENCY_MS
    ? []
    : ['--right-context', String(ASR_LATENCY_MODES[latency])];
}

// Saves the chosen mode and, when Forge owns a running idle engine, restarts it so the mode takes
// effect. The stop goes through the engine's own guard, which refuses while a transcription session
// is connected; that refusal leaves the engine running and the mode saved for its next start.
// A running engine is restarted even when the value is unchanged. The saved value can differ from the
// mode the engine was started with (for example after a refused change), so it cannot prove the mode.
export async function applyAsrLatency(latencyMs, { write, probe, managed, stop, start }) {
  validateAsrLatency(latencyMs);
  write(latencyMs);
  if (!(await probe())) {
    return {
      latencyMs,
      applied: true,
      restarted: false,
      message: `Saved. The speech engine will use ${latencyMs} ms chunks the next time it starts.`,
    };
  }
  if (!(await managed())) {
    return {
      latencyMs,
      applied: false,
      restarted: false,
      message:
        'Saved, but the running speech engine was not started by Forge. Stop it and start it again to apply the new latency.',
    };
  }
  try {
    await stop();
  } catch (error) {
    log.warn('asr.engine.stop.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
      reason: 'left_running',
    });
    return {
      latencyMs,
      applied: false,
      restarted: false,
      message: `Saved, but the speech engine was left running because it could not be stopped safely (${String(error.message).slice(0, 200)}). Try again when no transcription is running.`,
    };
  }
  const result = await start();
  const started = result.status >= 200 && result.status < 300;
  return {
    latencyMs,
    applied: started,
    restarted: true,
    message: started
      ? `Restarting the speech engine with ${latencyMs} ms chunks.`
      : `Saved. The speech engine stopped but did not restart: ${result.body?.message || 'check its status'}`,
  };
}
