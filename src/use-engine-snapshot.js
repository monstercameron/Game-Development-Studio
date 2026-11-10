import { useCallback, useEffect, useRef, useState } from 'react';
import { createLog } from './app-log.js';

const log = createLog('queue');

async function readJson(path, signal) {
  const response = await fetch(path, { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(body.error || `Could not read ${path}.`);
  }
  return body;
}

const EMPTY_SNAPSHOT = {
  engineId: null,
  status: 'idle',
  service: null,
  hardware: null,
  jobs: [],
  error: '',
};

/**
 * Reads what a person needs before a manual engine decision: the engine's own state, the GPU
 * memory and the queue. Only GET requests. `enabled` false keeps the hook idle, so opening a
 * dialog is the only thing that reads the runtime. A snapshot taken for another engine is never
 * returned for this one.
 */
export default function useEngineSnapshot(engineId, enabled) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [reloadCount, setReloadCount] = useState(0);
  const latest = useRef(0);
  const reload = useCallback(() => setReloadCount((count) => count + 1), []);

  useEffect(() => {
    if (!enabled || !engineId) {
      return undefined;
    }
    const controller = new AbortController();
    const request = ++latest.current;
    setSnapshot((current) => ({
      ...(current.engineId === engineId ? current : EMPTY_SNAPSHOT),
      engineId,
      status: 'loading',
      error: '',
    }));
    Promise.all([
      readJson('/api/runtime/services', controller.signal),
      readJson('/api/runtime/hardware', controller.signal),
      readJson('/api/runtime/jobs', controller.signal),
    ])
      .then(([services, hardware, queue]) => {
        if (request !== latest.current) {
          return;
        }
        setSnapshot({
          engineId,
          status: 'ready',
          service: (services.services || []).find((item) => item.id === engineId) || null,
          hardware,
          jobs: queue.jobs || [],
          error: '',
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || request !== latest.current) {
          return;
        }
        log.warn('queue.engine.snapshot.failed', { engineId, error });
        setSnapshot((current) => ({
          ...current,
          engineId,
          status: 'error',
          error: error.message || 'Could not read the engine state.',
        }));
      });
    return () => controller.abort();
  }, [engineId, enabled, reloadCount]);

  // While the effect has not yet run for this engine, the snapshot is treated as loading.
  if (!enabled || !engineId) {
    return { ...EMPTY_SNAPSHOT, reload };
  }
  if (snapshot.engineId !== engineId) {
    return { ...EMPTY_SNAPSHOT, engineId, status: 'loading', reload };
  }
  return { ...snapshot, reload };
}
