import { useEffect, useState } from 'react';
import { createLog } from './app-log.js';

const log = createLog('three-d');

// TRELLIS.2 pipelines whose checkpoints are on disk, as reported by the runtime (it reads the
// files, so this works while the worker is stopped). null means "not known yet".
export function useInstalledTrellisPipelines() {
  const [pipelines, setPipelines] = useState(null);
  useEffect(() => {
    let active = true;
    const abortController = new AbortController();
    (async () => {
      try {
        const response = await fetch('/api/runtime/services', { signal: abortController.signal });
        if (!response.ok) {
          log.warn('three-d.pipelines.unavailable', { reason: 'http_error' });
          return;
        }
        const servicesResponse = await response.json();
        const entry = servicesResponse?.services?.find((item) => item.id === '3d-trellis');
        if (active && Array.isArray(entry?.pipelines)) {
          setPipelines(entry.pipelines.filter((item) => typeof item === 'string'));
        }
      } catch (error) {
        // Leave the list unknown; the worker still rejects a pipeline that is not installed.
        if (abortController.signal.aborted) {
          log.debug('three-d.pipelines.cancelled');
        } else {
          log.warn('three-d.pipelines.unavailable', {
            reason: 'request_failed',
            errorClass: error?.name,
          });
        }
      }
    })();
    return () => {
      active = false;
      abortController.abort();
    };
  }, []);
  return pipelines;
}
