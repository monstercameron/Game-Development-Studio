import { useEffect, useState } from 'react';

// The LoRA files Forge found for Qwen Image, read each time the images page is shown so files
// added while the studio runs appear. A failed read is an empty list, never an error banner.
export function useImageLoras(active) {
  const [loras, setLoras] = useState([]);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const controller = new AbortController();
    fetch('/api/runtime/image-loras', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { loras: [] }))
      .then((listing) => setLoras(Array.isArray(listing.loras) ? listing.loras : []))
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoras([]);
        }
      });
    return () => controller.abort();
  }, [active]);
  return loras;
}
