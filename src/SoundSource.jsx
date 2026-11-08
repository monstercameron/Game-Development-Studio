import { useEffect, useRef, useState } from 'react';
import AssetPicker from './AssetPicker';
import { useRouteToggle } from './useNav';
import {
  SOUND_SOURCE_EXTENSIONS,
  SOUND_SOURCE_MAX_BYTES,
  changeAmountProblem,
  regionProblems,
} from './sound-source.js';

const modes = [
  ['variation', 'Variation', 'Re-render the source with your description (audio-to-audio).'],
  [
    'replace',
    'Replace a part',
    'Regenerate only a start-to-end region; the rest follows the source closely but is re-rendered, not copied.',
  ],
  ['continue', 'Continue', 'Keep the source and generate the rest, up to the duration above.'],
];

// "Start from an existing sound": picks a project sound, snapshots it for the queue, and keeps
// only its staged ID in the draft. Used by the sound-effect page.
export default function SoundSource({ project, projects = [], draft, update }) {
  const [picking, setPicking] = useRouteToggle('soundSource');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mode = modes.some(([id]) => id === draft.soundEditMode) ? draft.soundEditMode : 'variation';
  const staged = Boolean(draft.soundSourceId);
  const levelProblem = changeAmountProblem(draft.soundInitLevel);
  const region = regionProblems(draft);
  const modeGroupRef = useRef(null);
  const focusModeOnStage = useRef(false);

  // Choosing a sound unmounts the picker button, which drops focus to the page body. Move it to the
  // checked "How to use it" radio, the next control the user must set. Remove is destructive, so
  // it is not a safe landing point.
  useEffect(() => {
    if (staged && focusModeOnStage.current) {
      focusModeOnStage.current = false;
      modeGroupRef.current?.querySelector('input:checked')?.focus();
    }
  }, [staged]);

  async function stage(files) {
    const file = files[0];
    const source = file?.forgeSource;
    setPicking(false);
    if (!source) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(source.projectId)}/clips/from-asset`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
          body: JSON.stringify({ path: source.path }),
        },
      );
      const result = await response.json();
      if (!response.ok) {
        throw Error(result.error || 'Could not copy the sound.');
      }
      focusModeOnStage.current = true;
      update({
        soundSourceId: result.reference.id,
        soundSourceName: source.path,
        soundEditMode: mode,
      });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="audio-setting-group sound-source">
      <legend>Start from an existing sound</legend>
      <p>
        Optional. Pick a sound from a project, then vary it, replace a part of it, or continue it.
        Forge copies the sound when you choose it, so later edits do not change this render.
      </p>
      <div className="audio-setting-group-fields">
        {staged ? (
          <div className="sound-source-chosen audio-setting-wide" role="status">
            <span>
              Source: <strong>{draft.soundSourceName || 'chosen sound'}</strong>
            </span>
            <button
              type="button"
              className="outline-button"
              onClick={() =>
                update({
                  soundSourceId: '',
                  soundSourceName: '',
                  soundRegionStart: '',
                  soundRegionEnd: '',
                })
              }
            >
              Remove source
            </button>
          </div>
        ) : (
          <div className="audio-setting-wide">
            <button
              type="button"
              className="outline-button"
              disabled={busy || !projects.length}
              onClick={() => setPicking(true)}
            >
              {busy ? 'Copying sound…' : 'Choose from asset library'}
            </button>
            <small className="sound-source-help">
              WAV, FLAC, MP3 or Ogg, up to 32 MiB. The sound is cropped or padded to the duration.
            </small>
          </div>
        )}
        {error && (
          <small className="audio-setting-error audio-setting-wide" role="alert">
            {error}
          </small>
        )}
        {staged && (
          <>
            <fieldset ref={modeGroupRef} className="sound-source-modes audio-setting-wide">
              <legend>How to use it</legend>
              {modes.map(([id, label, help]) => (
                <label key={id} className="sound-source-mode" htmlFor={`sound-mode-${id}`}>
                  <input
                    id={`sound-mode-${id}`}
                    type="radio"
                    name="sound-edit-mode"
                    value={id}
                    checked={mode === id}
                    onChange={() => update({ soundEditMode: id })}
                  />
                  <span>
                    <strong>{label}</strong> <small>{help}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            {mode === 'variation' && (
              <label className="audio-setting" htmlFor="soundInitLevel">
                <span>Change amount</span>
                <input
                  id="soundInitLevel"
                  type="number"
                  min="0.05"
                  max="1"
                  step="0.05"
                  inputMode="decimal"
                  placeholder="0.9"
                  value={draft.soundInitLevel ?? ''}
                  aria-invalid={levelProblem ? true : undefined}
                  aria-describedby={
                    levelProblem
                      ? 'soundInitLevel-help soundInitLevel-error'
                      : 'soundInitLevel-help'
                  }
                  onChange={(event) => update({ soundInitLevel: event.target.value })}
                />
                <small id="soundInitLevel-help">
                  0.05 to 1; blank uses 0.9. Low stays close to the source; 1 ignores it.
                </small>
                {levelProblem && (
                  <small className="audio-setting-error" id="soundInitLevel-error" role="alert">
                    {levelProblem}
                  </small>
                )}
              </label>
            )}
            {mode === 'replace' && (
              <>
                <label className="audio-setting" htmlFor="soundRegionStart">
                  <span>Replace from (seconds)</span>
                  <input
                    id="soundRegionStart"
                    type="number"
                    min="0"
                    max="380"
                    step="0.1"
                    inputMode="decimal"
                    value={draft.soundRegionStart ?? ''}
                    aria-invalid={region.start ? true : undefined}
                    aria-describedby={region.start ? 'soundRegionStart-error' : undefined}
                    onChange={(event) => update({ soundRegionStart: event.target.value })}
                  />
                  {region.start && (
                    <small className="audio-setting-error" id="soundRegionStart-error" role="alert">
                      {region.start}
                    </small>
                  )}
                </label>
                <label className="audio-setting" htmlFor="soundRegionEnd">
                  <span>Replace to (seconds)</span>
                  <input
                    id="soundRegionEnd"
                    type="number"
                    min="0"
                    max="380"
                    step="0.1"
                    inputMode="decimal"
                    value={draft.soundRegionEnd ?? ''}
                    aria-invalid={region.end ? true : undefined}
                    aria-describedby={
                      region.end
                        ? 'soundRegionEnd-help soundRegionEnd-error'
                        : 'soundRegionEnd-help'
                    }
                    onChange={(event) => update({ soundRegionEnd: event.target.value })}
                  />
                  <small id="soundRegionEnd-help">
                    The end must be after the start and inside the sound duration.
                  </small>
                  {region.end && (
                    <small className="audio-setting-error" id="soundRegionEnd-error" role="alert">
                      {region.end}
                    </small>
                  )}
                </label>
              </>
            )}
            {mode === 'continue' && (
              <p className="audio-setting-wide sound-source-help">
                Set the duration longer than the source sound; the new part fills the difference.
              </p>
            )}
          </>
        )}
      </div>
      {picking && (
        <AssetPicker
          title="Choose a source sound"
          description="Choose a WAV, FLAC, MP3 or Ogg sound from a project."
          projects={projects}
          project={project}
          extensions={SOUND_SOURCE_EXTENSIONS}
          maxBytes={SOUND_SOURCE_MAX_BYTES}
          onSelect={stage}
          onClose={() => setPicking(false)}
        />
      )}
    </fieldset>
  );
}
