import React, { Suspense, useEffect, useState } from 'react';
import ModelPreview from './ModelPreview';
import './ux-viewer.css';

const GaussianPreview = React.lazy(() => import('./GaussianPreview'));

// Bytes read from the start of the file. Must match the Range header below.
const HEADER_READ_BYTES = 8192;

// A PLY can be a mesh, point cloud, or Gaussian splat. Inspect only its
// header before choosing the viewer; do not download the entire file twice.
export default function PlyAssetPreview({ url, name, ...viewerProps }) {
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
        let bytesRead = 0;
        try {
          while (bytesRead < HEADER_READ_BYTES) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunk = value.subarray(0, HEADER_READ_BYTES - bytesRead);
            chunks.push(chunk);
            bytesRead += chunk.byteLength;
          }
        } finally {
          // The Range response may still be streaming; cancel it once the header is read.
          await reader.cancel();
        }
        const bytes = new Uint8Array(bytesRead);
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
      <div className="viewer-message" role="status">
        <span className="vw-spinner" aria-hidden="true" />
        <strong>Checking 3D file…</strong>
      </div>
    );
  }
  if (kind === 'model') {
    return <ModelPreview url={url} name={name} {...viewerProps} />;
  }
  return (
    <Suspense
      fallback={
        <div className="viewer-message" role="status">
          <span className="vw-spinner" aria-hidden="true" />
          <strong>Loading Gaussian viewer…</strong>
        </div>
      }
    >
      <GaussianPreview url={url} name={name} {...viewerProps} onFallback={() => setKind('model')} />
    </Suspense>
  );
}
