import { useEffect, useState } from 'react';
import './text-asset-preview.css';
export default function TextAssetPreview({ asset }) {
  const [state, setState] = useState({ loading: true, text: '', error: '' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, text: '', error: '' });
    if (asset.size > 512 * 1024) {
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
        if (Number(response.headers.get('content-length')) > 512 * 1024) {
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
