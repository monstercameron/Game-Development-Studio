import { useEffect, useRef, useState } from 'react';
import AssetPicker from './AssetPicker';
import { useRouteToggle } from './useNav';
import {
  CLONE_REFERENCE_EXTENSIONS,
  CLONE_REFERENCE_MAX_BYTES,
  CLONE_REFERENCE_SECONDS,
  CLONE_TRANSCRIPT_MAX,
  VOICE_DESCRIPTION_MAX,
  VOICE_MODE_CHECKPOINTS,
  cloneReferenceLengthProblem,
  readClipDurationSeconds,
  voiceModeFieldErrors,
} from './voice-modes.js';

const modes = [
  ['preset', 'Preset voice', 'One of nine built-in speakers, with optional voice direction.'],
  ['clone', 'Clone a voice', 'Copy a voice from a short reference clip and its exact transcript.'],
  ['design', 'Design a voice', 'Describe the voice in words, and Forge creates a new one.'],
];
const checkpointNames = {
  'tts-base': 'Qwen3-TTS-12Hz-1.7B-Base',
  'tts-voicedesign': 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
};
// Element to focus for each invalid field, in form order. Submit moves focus to the first one.
const fieldFocusIds = {
  reference: 'voiceReference-choose',
  transcript: 'voiceReferenceText',
  consent: 'voiceConsent',
  description: 'voiceDescription',
};

// Voice modes on the Voices page: the mode switch, the preset direction, and the clone or design
// fields. Checkpoints that are not staged are disabled with the command that stages them.
export default function VoiceModeControls({
  project,
  projects = [],
  draft,
  update,
  // Counts failed submits from the page. Field errors appear after the first one.
  submitAttempts = 0,
}) {
  const [picking, setPicking] = useRouteToggle('voiceReference');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // null means the storage scan has not answered; the server still refuses a missing checkpoint.
  const [installed, setInstalled] = useState({});
  const mode = modes.some(([id]) => id === draft.voiceMode) ? draft.voiceMode : 'preset';
  const staged = Boolean(draft.voiceReferenceId);
  // Null when the browser could not read the clip; the worker decides in that case.
  const referenceSeconds = Number.isFinite(draft.voiceReferenceSeconds)
    ? draft.voiceReferenceSeconds
    : null;
  const referenceLengthProblem = cloneReferenceLengthProblem(referenceSeconds);
  const transcriptRef = useRef(null);
  const focusTranscriptOnStage = useRef(false);
  const handledSubmitAttempts = useRef(0);
  // Errors come from the draft, so they clear as soon as a field is fixed. They show only after
  // a failed submit, so a fresh page does not open with error text.
  const fieldErrors = voiceModeFieldErrors(draft);
  const showFieldErrors = submitAttempts > 0;
  // A length problem already has its own alert beside the clip, so it is not repeated here.
  const referenceError =
    showFieldErrors && fieldErrors.reference !== referenceLengthProblem
      ? fieldErrors.reference
      : '';
  const voiceOnly = draft.voiceCloneVoiceOnly === true;
  const transcriptError = showFieldErrors ? fieldErrors.transcript : '';
  const consentError = showFieldErrors ? fieldErrors.consent : '';
  const descriptionError = showFieldErrors ? fieldErrors.description : '';
  const firstInvalidField = Object.keys(fieldFocusIds).find((field) => fieldErrors[field]);
  const firstInvalidId = firstInvalidField ? fieldFocusIds[firstInvalidField] : '';

  // A failed submit moves focus to the first invalid field. Keyed on the attempt count so that
  // later edits to the draft do not pull focus away from the field being typed in.
  useEffect(() => {
    if (submitAttempts === handledSubmitAttempts.current) {
      return;
    }
    handledSubmitAttempts.current = submitAttempts;
    if (firstInvalidId) {
      document.getElementById(firstInvalidId)?.focus();
    }
  }, [submitAttempts, firstInvalidId]);

  // Choosing a clip unmounts the picker button, which drops focus to the page body. Move it to the
  // transcript instead: it is the next required field. Remove is a destructive control, so it is
  // a poor place for focus to land.
  useEffect(() => {
    if (staged && focusTranscriptOnStage.current) {
      focusTranscriptOnStage.current = false;
      transcriptRef.current?.focus();
    }
  }, [staged]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/runtime/model-storage', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((inventory) => {
        const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
        const next = {};
        for (const id of Object.keys(checkpointNames)) {
          const entry = entries.find((item) => item.id === id);
          next[id] = typeof entry?.installed === 'boolean' ? entry.installed : null;
        }
        setInstalled(next);
      })
      .catch((reason) => {
        if (reason.name !== 'AbortError') {
          setInstalled({});
        }
      });
    return () => controller.abort();
  }, []);

  async function stageReference(files) {
    const file = files[0];
    const source = file?.forgeSource;
    setPicking(false);
    if (!source) {
      return;
    }
    setBusy(true);
    setError('');
    // Read the length while the copy is in flight. The read never rejects, so it cannot fail staging.
    const durationRead = readClipDurationSeconds(file);
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
        throw Error(result.error || 'Could not copy the reference clip.');
      }
      const seconds = await durationRead;
      focusTranscriptOnStage.current = true;
      const clipKey = JSON.stringify([source.projectId, source.path]);
      // A transcript typed for another clip no longer matches, so choosing a different clip clears
      // it. Unbound text (typed before any clip, or restored by Reuse settings) stays for this clip.
      const transcriptBoundKey = draft.voiceReferenceTextKey || '';
      const clearsTranscript =
        transcriptBoundKey !== '' &&
        transcriptBoundKey !== clipKey &&
        Boolean(draft.voiceReferenceText);
      update({
        voiceReferenceId: result.reference.id,
        voiceReferenceName: source.path,
        voiceReferenceSeconds: seconds,
        voiceReferenceSourceKey: clipKey,
        voiceReferenceTextKey: clipKey,
        ...(clearsTranscript ? { voiceReferenceText: '' } : {}),
      });
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <fieldset className="audio-setting-group voice-mode">
        <legend>Voice type</legend>
        <div className="audio-setting-group-fields">
          {modes.map(([id, label, help]) => {
            const checkpoint = VOICE_MODE_CHECKPOINTS[id];
            const missing = Boolean(checkpoint) && installed[checkpoint] === false;
            const reason = missing
              ? `Not installed: ${checkpointNames[checkpoint]}. Stage it with .\\install.ps1 -Models ${checkpoint}.`
              : help;
            return (
              <label key={id} className="sound-source-mode" htmlFor={`voice-mode-${id}`}>
                <input
                  id={`voice-mode-${id}`}
                  type="radio"
                  name="voice-mode"
                  value={id}
                  checked={mode === id}
                  disabled={missing}
                  aria-describedby={`voice-mode-${id}-help`}
                  onChange={() => update({ voiceMode: id })}
                />
                <span>
                  <strong>{label}</strong> <small id={`voice-mode-${id}-help`}>{reason}</small>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {mode === 'preset' && (
        <>
          <label className="field-label" htmlFor="extra">
            Voice direction <span>OPTIONAL</span>
          </label>
          <textarea
            id="extra"
            className="short-text"
            maxLength={500}
            value={draft.second}
            onChange={(e) => update({ second: e.target.value })}
            placeholder="Speak warmly and clearly, with a sense of wonder..."
          />
          <p className="helper">
            Choose a preset voice and add direction. Speech is generated as a completed audio file;
            streaming is not yet available.
          </p>
        </>
      )}

      {mode === 'design' && (
        <>
          <label className="field-label" htmlFor="voiceDescription">
            Voice description <span>REQUIRED</span>
          </label>
          <textarea
            id="voiceDescription"
            className="short-text"
            maxLength={VOICE_DESCRIPTION_MAX}
            value={draft.voiceDescription ?? ''}
            aria-invalid={descriptionError ? 'true' : undefined}
            aria-describedby={`voiceDescription-help${descriptionError ? ' voiceDescription-error' : ''}`}
            onChange={(e) => update({ voiceDescription: e.target.value })}
            placeholder="A calm, older storyteller with a low, warm voice and a slight rasp..."
          />
          <p id="voiceDescription-help" className="helper">
            Describe age, gender, tone, accent and pace in up to {VOICE_DESCRIPTION_MAX} characters.
            The VoiceDesign checkpoint creates the voice from this text; the same description does
            not always sound identical across renders unless the seed is also the same.
          </p>
          {descriptionError && (
            <small id="voiceDescription-error" className="voice-field-error" role="alert">
              {descriptionError}
            </small>
          )}
        </>
      )}

      {mode === 'clone' && (
        <fieldset className="audio-setting-group sound-source">
          <legend>Reference clip</legend>
          <p>
            Choose a project WAV, FLAC or MP3 of {CLONE_REFERENCE_SECONDS.min} to{' '}
            {CLONE_REFERENCE_SECONDS.max} seconds with one clear speaker. Forge copies the clip when
            you choose it, so later edits do not change this render.
          </p>
          <div className="audio-setting-group-fields">
            {staged ? (
              <div
                className="sound-source-chosen audio-setting-wide"
                role="status"
                aria-describedby={
                  referenceLengthProblem ? 'voiceReference-length-alert' : undefined
                }
              >
                <span>
                  Reference: <strong>{draft.voiceReferenceName || 'chosen clip'}</strong>
                  {referenceSeconds !== null && (
                    <small> · Length {referenceSeconds.toFixed(1)} s</small>
                  )}
                </span>
                <button
                  type="button"
                  className="outline-button"
                  onClick={() =>
                    update({
                      voiceReferenceId: '',
                      voiceReferenceName: '',
                      voiceReferenceSeconds: null,
                      voiceReferenceSourceKey: '',
                    })
                  }
                >
                  Remove clip
                </button>
              </div>
            ) : (
              <div className="audio-setting-wide">
                <button
                  type="button"
                  className="outline-button"
                  id="voiceReference-choose"
                  disabled={busy || !projects.length}
                  aria-invalid={referenceError ? 'true' : undefined}
                  aria-describedby={referenceError ? 'voiceReference-error' : undefined}
                  onClick={() => setPicking(true)}
                >
                  {busy ? 'Copying clip…' : 'Choose from asset library'}
                </button>
                <small className="sound-source-help">
                  WAV, FLAC or MP3, {CLONE_REFERENCE_SECONDS.min} to {CLONE_REFERENCE_SECONDS.max}{' '}
                  seconds, up to {CLONE_REFERENCE_MAX_BYTES / 1024 / 1024} MiB.
                </small>
              </div>
            )}
            {referenceLengthProblem && (
              <small
                id="voiceReference-length-alert"
                className="audio-setting-error audio-setting-wide"
                role="alert"
              >
                {referenceLengthProblem}
              </small>
            )}
            {error && (
              <small className="audio-setting-error audio-setting-wide" role="alert">
                {error}
              </small>
            )}
            {referenceError && (
              <small
                id="voiceReference-error"
                className="voice-field-error audio-setting-wide"
                role="alert"
              >
                {referenceError}
              </small>
            )}
            <label className="sound-source-mode audio-setting-wide" htmlFor="voiceCloneVoiceOnly">
              <input
                id="voiceCloneVoiceOnly"
                type="checkbox"
                checked={voiceOnly}
                aria-describedby="voiceCloneVoiceOnly-help"
                onChange={(e) => update({ voiceCloneVoiceOnly: e.target.checked })}
              />
              <span>
                <strong>Voice only - no transcript, lower similarity</strong>{' '}
                <small id="voiceCloneVoiceOnly-help">
                  Copies the voice from the clip alone. Forge does not send a transcript, so the
                  field below is optional. The result usually sounds less like the speaker.
                </small>
              </span>
            </label>
            <label className="audio-setting audio-setting-wide" htmlFor="voiceReferenceText">
              <span>
                {voiceOnly ? 'Reference transcript (optional)' : 'Reference transcript (required)'}
              </span>
              <textarea
                ref={transcriptRef}
                id="voiceReferenceText"
                className="short-text"
                maxLength={CLONE_TRANSCRIPT_MAX}
                value={draft.voiceReferenceText ?? ''}
                aria-invalid={transcriptError ? 'true' : undefined}
                aria-describedby={`voiceReferenceText-help${transcriptError ? ' voiceReferenceText-error' : ''}`}
                onChange={(e) =>
                  update({
                    voiceReferenceText: e.target.value,
                    // Keep the clip the text was written for; typing with no clip staged keeps
                    // the binding from the last clip.
                    voiceReferenceTextKey:
                      draft.voiceReferenceSourceKey || draft.voiceReferenceTextKey || '',
                  })
                }
                placeholder="The exact words spoken in the reference clip"
              />
              <small id="voiceReferenceText-help">
                {voiceOnly
                  ? 'Voice only is on, so this text is not sent. Turn it off to clone with the transcript.'
                  : 'Type what is said in the clip, word for word, including punctuation. The transcript must match the chosen clip; choosing a different clip clears it. Forge does not transcribe it for you yet.'}{' '}
                Up to {CLONE_TRANSCRIPT_MAX} characters.
              </small>
            </label>
            {transcriptError && (
              <small
                id="voiceReferenceText-error"
                className="voice-field-error audio-setting-wide"
                role="alert"
              >
                {transcriptError}
              </small>
            )}
            <label className="sound-source-mode audio-setting-wide" htmlFor="voiceConsent">
              <input
                id="voiceConsent"
                type="checkbox"
                checked={draft.voiceConsent === true}
                aria-required="true"
                aria-invalid={consentError ? 'true' : undefined}
                aria-describedby={consentError ? 'voiceConsent-error' : undefined}
                onChange={(e) => update({ voiceConsent: e.target.checked })}
              />
              <span>
                <strong>Only clone voices you have the right to use.</strong>{' '}
                <small>
                  Required: I have the right to use this voice for the audio I am making.
                </small>
              </span>
            </label>
            {consentError && (
              <small
                id="voiceConsent-error"
                className="voice-field-error audio-setting-wide"
                role="alert"
              >
                {consentError}
              </small>
            )}
          </div>
          {picking && (
            <AssetPicker
              title="Choose a reference clip"
              description="Choose a WAV, FLAC or MP3 clip from a project."
              projects={projects}
              project={project}
              extensions={CLONE_REFERENCE_EXTENSIONS}
              maxBytes={CLONE_REFERENCE_MAX_BYTES}
              onSelect={stageReference}
              onClose={() => setPicking(false)}
            />
          )}
        </fieldset>
      )}
    </>
  );
}
