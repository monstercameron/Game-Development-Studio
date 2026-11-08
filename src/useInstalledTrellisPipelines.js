import { useEffect, useState } from 'react';

// TRELLIS.2 pipelines whose checkpoints are on disk, as reported by the runtime (it reads the
// files, so this works while the worker is stopped). null means "not known yet".
export function useInstalledTrellisPipelines() {
  const [pipelines, setPipelines] = useState(null);
  useEffect(() => {
    let active = true;
    const request = new AbortController();
    (async () => {
      try {
        const response = await fetch('/api/runtime/services', { signal: request.signal });
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        const entry = data?.services?.find((item) => item.id === '3d-trellis');
        if (active && Array.isArray(entry?.pipelines)) {
          setPipelines(entry.pipelines.filter((item) => typeof item === 'string'));
        }
      } catch {
        // Leave the list unknown; the worker still rejects a pipeline that is not installed.
      }
    })();
    return () => {
      active = false;
      request.abort();
    };
  }, []);
  return pipelines;
}
