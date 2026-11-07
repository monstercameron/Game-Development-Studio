import React, { Suspense, useEffect, useState } from 'react';
import ModelPreview from './ModelPreview';

const GaussianPreview = React.lazy(() => import('./GaussianPreview'));

// A PLY can be a mesh, point cloud, or Gaussian splat. Inspect only its
// header before choosing the viewer; do not download the entire file twice.
export default function PlyAssetPreview({ url, name }) {
  const [kind, setKind] = useState('checking');
  useEffect(() => {
    const controller = new AbortController();
    setKind('checking');
    fetch(url, { headers: { Range: 'bytes=0-8191' }, signal: controller.signal, redirect: 'error' })
      .then(async (response) => {
        if (!response.ok) {
          throw Error('Could not read the PLY header.');
        }
        const reader = response.body?.getReader();
        if (!reader) {
          throw Error('Could not read the PLY header.');
        }
        const chunks = [];
        let length = 0;
        try {
          while (length < 8192) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunk = value.subarray(0, 8192 - length);
            chunks.push(chunk);
            length += chunk.byteLength;
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const header = new TextDecoder('ascii').decode(bytes).split('end_header')[0];
        setKind(
          /property\s+float\s+f_dc_0\b/.test(header) && /property\s+float\s+scale_0\b/.test(header)
            ? 'splat'
            : 'model',
        );
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setKind('model');
        }
      });
    return () => controller.abort();
  }, [url]);
  if (kind === 'checking') {
    return (
      <div className="model-preview-message" role="status">
        Checking 3D file…
      </div>
    );
  }
  if (kind === 'model') {
    return <ModelPreview url={url} name={name} />;
  }
  return (
    <Suspense
      fallback={
        <div className="model-preview-message" role="status">
          Loading Gaussian viewer…
        </div>
      }
    >
      <GaussianPreview url={url} name={name} onFallback={() => setKind('model')} />
    </Suspense>
  );
}
