import { useEffect, useRef, useState } from 'react';
import { canDeriveMusic, deriveMusicRequest } from './music-derive.js';
import { createLog } from './app-log.js';

const log = createLog('music');

async function queueMusicJob(projectId, request) {
  // log-coverage: ignore -- non-OK responses are thrown to submit(), which logs music.derive.failed; failed /api calls are captured by app-log
  const response = await fetch('/api/runtime/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'runtime' },
    body: JSON.stringify({ type: 'music', projectId, request }),
  });
  const result = await response.json();
  if (!response.ok) {
    throw Error(result.error || 'Request failed.');
  }
  return result;
}

// Actions on a finished YuE2 track: continue it, or render it again with a new seed. The form
// state belongs to one track, so a different track starts with a clean form and no old message.
export default function MusicDerive(props) {
  return <MusicDeriveActions key={`${props.project?.id}:${props.asset?.id}`} {...props} />;
}

function MusicDeriveActions({ project, asset, onQueued }) {
  const [mode, setMode] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [hasError, setHasError] = useState(false);
  const formRef = useRef(null);
  const triggerRefs = useRef({});

  // Open the form on its first field so keyboard users do not have to tab past the other action.
  useEffect(() => {
    if (!mode || !formRef.current) {
      return;
    }
    formRef.current.scrollIntoView?.({ block: 'nearest' });
    formRef.current.querySelector('input, textarea')?.focus({ preventScroll: true });
  }, [mode]);

  if (!project || !canDeriveMusic(asset)) {
    return null;
  }
  const set = (change) => setValues((current) => ({ ...current, ...change }));
  const open = (next) => {
    setMode(mode === next ? null : next);
    setMessage('');
    setHasError(false);
  };
  const close = () => {
    const trigger = triggerRefs.current[mode];
    setMode(null);
    trigger?.focus();
  };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setHasError(false);
    try {
      await queueMusicJob(project.id, deriveMusicRequest(mode, asset, values));
      log.info('music.derive.queued', { mode });
      setMessage(
        mode === 'extend'
          ? 'Extension added to the render queue. The original track is not changed.'
          : 'Re-synthesis added to the render queue. The original track is not changed.',
      );
      triggerRefs.current[mode]?.focus();
      setMode(null);
      setValues({});
      onQueued?.();
    } catch (error) {
      log.warn('music.derive.failed', { mode, errorClass: error?.name });
      setHasError(true);
      setMessage(`Could not queue it: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="music-derive">
      <div className="music-derive-actions">
        <button
          type="button"
          className="outline-button"
          ref={(element) => {
            triggerRefs.current.extend = element;
          }}
          aria-expanded={mode === 'extend'}
          aria-controls="music-derive-form"
          onClick={() => open('extend')}
        >
          Extend this track
        </button>
        <button
          type="button"
          className="outline-button"
          ref={(element) => {
            triggerRefs.current.resynth = element;
          }}
          aria-expanded={mode === 'resynth'}
          aria-controls="music-derive-form"
          onClick={() => open('resynth')}
        >
          Re-synthesize with a new seed
        </button>
      </div>
      {mode && (
        <form
          id="music-derive-form"
          ref={formRef}
          className="music-derive-form"
          onSubmit={submit}
          aria-busy={busy}
          aria-label={mode === 'extend' ? 'Extend this track' : 'Re-synthesize this track'}
        >
          {mode === 'extend' ? (
            <>
              <p>
                YuE2 keeps the song it planned for this track and generates more of it, then renders
                the whole thing again as a new file that is the original length plus the seconds you
                add. Only tracks Forge rendered can be extended.
              </p>
              <label htmlFor="music-derive-seconds">
                <span>Seconds to add (1 to 300)</span>
                <input
                  id="music-derive-seconds"
                  type="number"
                  min="1"
                  max="300"
                  step="1"
                  placeholder="30"
                  value={values.addSeconds ?? ''}
                  onChange={(event) => set({ addSeconds: event.target.value })}
                />
              </label>
              <label htmlFor="music-derive-lyrics">
                <span>New lyrics for the added part (optional)</span>
                <textarea
                  id="music-derive-lyrics"
                  rows={3}
                  maxLength={5000}
                  placeholder={'[Verse 2]\nLines for the new section'}
                  value={values.lyricsAddition ?? ''}
                  onChange={(event) => set({ lyricsAddition: event.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <p>
                The song YuE2 planned is kept; only the sound is rendered again, so the arrangement
                stays and the performance changes. This is faster than a full render.
              </p>
              <label htmlFor="music-derive-steps">
                <span>Synthesis steps (optional, 1 to 100)</span>
                <input
                  id="music-derive-steps"
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  placeholder="Same as the original"
                  value={values.steps ?? ''}
                  onChange={(event) => set({ steps: event.target.value })}
                />
              </label>
            </>
          )}
          <label htmlFor="music-derive-seed">
            <span>Seed (optional)</span>
            <input
              id="music-derive-seed"
              type="number"
              min="0"
              max="2147483647"
              step="1"
              placeholder="Random"
              value={values.seed ?? ''}
              onChange={(event) => set({ seed: event.target.value })}
            />
          </label>
          <div className="music-derive-submit">
            <button type="button" className="ghost-button" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? 'Adding…' : mode === 'extend' ? 'Extend track' : 'Re-synthesize'}
            </button>
          </div>
        </form>
      )}
      {message && (
        <p className="music-derive-message" role={hasError ? 'alert' : 'status'}>
          {message}
        </p>
      )}
    </div>
  );
}
