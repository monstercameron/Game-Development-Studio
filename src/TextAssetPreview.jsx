import { useEffect, useState } from 'react';
import './text-asset-preview.css';

// Upper bound in bytes for previewed text. It is checked against asset metadata before
// fetching and again against the response Content-Length before the body is read.
const MAX_PREVIEW_BYTES = 512 * 1024;

export default function TextAssetPreview({ asset }) {
  const [state, setState] = useState({ loading: true, text: '', error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, text: '', error: '' });
    if (asset.size > MAX_PREVIEW_BYTES) {
      setState({
        loading: false,
        text: '',
        error: 'This file is too large to preview. Download it to read it.',
      });
      return () => controller.abort();
    }
    fetch(asset.file, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) {
          throw Error('Could not load this file.');
        }
        if (Number(response.headers.get('content-length')) > MAX_PREVIEW_BYTES) {
          throw Error('This file is too large to preview. Download it to read it.');
        }
        return response.text();
      })
      .then((text) => setState({ loading: false, text, error: '' }))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setState({ loading: false, text: '', error: error.message });
        }
      });
    return () => controller.abort();
  }, [asset.file, asset.size]);
  return (
    <div className="text-asset-preview" aria-label="Text preview">
      {state.loading ? (
        <p>Loading text…</p>
      ) : state.error ? (
        <p role="alert">{state.error}</p>
      ) : (
        <pre>{state.text}</pre>
      )}
    </div>
  );
}
