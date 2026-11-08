import { FolderOpen, Plus, X } from 'lucide-react';
import FieldError from './FieldError';
import './motionbricks-controls.css';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

// A blank value counts as valid: the field is optional and the caller decides what blank means.
function isOptionalInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') {
    return true;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum;
}

function formatFileSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export default function MotionBricksControls({
  draft,
  onChange,
  file,
  onFile,
  onLibrary,
  sourceError = '',
}) {
  const contextFrame = draft.contextFrame ?? 0;
  const targetFrame = draft.targetFrame ?? 20;
  const minTokens = draft.minTokens ?? 8;
  const maxTokens = draft.maxTokens ?? 14;
  const targetPoses = draft.targetPoses ?? 4;
  const targetPosesInvalid = !isOptionalInteger(targetPoses, 1, 4);
  const contextFrameInvalid = !isOptionalInteger(contextFrame, 0);
  const targetFrameInvalid = !isOptionalInteger(targetFrame, 0);
  const minTokensInvalid = !isOptionalInteger(minTokens, 6, 16);
  const maxTokensInvalid = !isOptionalInteger(maxTokens, 6, 16);
  const tokenOrderInvalid =
    !minTokensInvalid && !maxTokensInvalid && Number(minTokens) > Number(maxTokens);
  const fileTooLarge = Boolean(file && file.size > MAX_SOURCE_BYTES);
  // A transition of N tokens keeps 4N - 6 frames after the worker trims boundary frames.
  const frameCount = (tokens) => 4 * tokens - 6;
  const lengthRangeValid =
    !minTokensInvalid &&
    !maxTokensInvalid &&
    !tokenOrderInvalid &&
    minTokens !== '' &&
    maxTokens !== '';
  const shortestFrames = lengthRangeValid ? frameCount(Number(minTokens)) : null;
  const longestFrames = lengthRangeValid ? frameCount(Number(maxTokens)) : null;
  // The frame range is shown only when both token bounds are valid. Durations assume 30 fps.
  const frameRangeText =
    shortestFrames !== null
      ? ` (${shortestFrames} to ${longestFrames} frames, about ${(shortestFrames / 30).toFixed(1)} to ${(longestFrames / 30).toFixed(1)} seconds)`
      : '';

  return (
    <section className="motionbricks-controls" aria-label="MotionBricks source and settings">
      <section className="motionbricks-source" aria-labelledby="motionbricks-source-heading">
        <div className="field-label reference-heading" id="motionbricks-source-heading">
          SOMA motion clip <span>Required</span>
        </div>
        <p className="helper motionbricks-source-guidance" id="motionbricks-source-guidance">
          Choose a BVH sampled at 30, 60, or 120 fps with the 30-joint SOMA skeleton, Y up, and
          positions in centimeters. Maximum file size: 10 MiB.
        </p>
        <div className="motionbricks-source-actions">
          <label className="upload-box motionbricks-upload">
            <input
              id="motionbricks-file"
              type="file"
              accept=".bvh"
              aria-label="Choose a SOMA BVH file"
              aria-required="true"
              aria-invalid={sourceError ? 'true' : undefined}
              aria-describedby={
                sourceError
                  ? 'motionbricks-source-guidance motionbricks-source-error'
                  : 'motionbricks-source-guidance'
              }
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) {
                  onFile(selected);
                }
                event.target.value = '';
              }}
            />
            <span className="upload-icon" aria-hidden="true">
              <Plus size={19} />
            </span>
            <span className="motionbricks-upload-copy">
              <strong>Choose a SOMA BVH file</strong>
              <small>BVH only · up to 10 MiB</small>
            </span>
            <span className="upload-action">Browse files</span>
          </label>
          <button type="button" className="outline-button asset-library-button" onClick={onLibrary}>
            <FolderOpen size={15} aria-hidden="true" /> Choose from asset library
          </button>
        </div>
        <FieldError id="motionbricks-source-error" message={sourceError} />
        {file && (
          <div className="motionbricks-selected-source" role="status" aria-live="polite">
            <div className="motionbricks-selected-copy">
              <span className="motionbricks-selected-label">Selected source</span>
              <strong title={file.name}>{file.name}</strong>
              {Number.isFinite(file.size) && (
                <span className="motionbricks-file-size">{formatFileSize(file.size)}</span>
              )}
            </div>
            <button
              type="button"
              className="motionbricks-remove-source"
              aria-label={`Remove pose file ${file.name}`}
              onClick={() => onFile(null)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        )}
        {fileTooLarge && (
          <p className="motionbricks-error" role="alert">
            This file exceeds 10 MiB. Choose a smaller BVH before adding the job to the queue.
          </p>
        )}
        <p className="helper motionbricks-limit-note">
          The worker checks BVH structure, frame rate, and window bounds when the job runs. This
          panel cannot check the file’s skeleton, units, or length in advance. Other skeletons are
          not retargeted. This experimental model does not correct transition endpoints.
        </p>
      </section>

      <fieldset className="motionbricks-group">
        <legend>Pose windows</legend>
        <div className="motionbricks-parameter-grid">
          <div>
            <label className="field-label" htmlFor="motionbricks-context-frame">
              Starting pose frame
            </label>
            <input
              id="motionbricks-context-frame"
              type="number"
              min="0"
              step="1"
              value={contextFrame}
              aria-invalid={contextFrameInvalid || undefined}
              aria-describedby={
                contextFrameInvalid
                  ? 'motionbricks-frame-help motionbricks-context-error'
                  : 'motionbricks-frame-help'
              }
              onChange={(event) => onChange({ contextFrame: event.target.value })}
            />
            {contextFrameInvalid && (
              <span className="motionbricks-error" id="motionbricks-context-error">
                Enter a whole frame number of 0 or greater.
              </span>
            )}
          </div>
          <div>
            <label className="field-label" htmlFor="motionbricks-target-frame">
              Target pose frame
            </label>
            <input
              id="motionbricks-target-frame"
              type="number"
              min="0"
              step="1"
              value={targetFrame}
              aria-invalid={targetFrameInvalid || undefined}
              aria-describedby={
                targetFrameInvalid
                  ? 'motionbricks-frame-help motionbricks-target-error'
                  : 'motionbricks-frame-help'
              }
              onChange={(event) => onChange({ targetFrame: event.target.value })}
            />
            {targetFrameInvalid && (
              <span className="motionbricks-error" id="motionbricks-target-error">
                Enter a whole frame number of 0 or greater.
              </span>
            )}
          </div>
          <div>
            <label className="field-label" htmlFor="motionbricks-target-poses">
              Target poses to use
            </label>
            <input
              id="motionbricks-target-poses"
              type="number"
              min="1"
              max="4"
              step="1"
              value={targetPoses}
              aria-invalid={targetPosesInvalid || undefined}
              aria-describedby={
                targetPosesInvalid
                  ? 'motionbricks-poses-help motionbricks-poses-error'
                  : 'motionbricks-poses-help'
              }
              onChange={(event) => onChange({ targetPoses: event.target.value })}
            />
            <p className="helper motionbricks-field-help" id="motionbricks-poses-help">
              1–4 of the target window’s poses. The first pose sets the destination; more poses add
              velocity and acceleration. Blank uses 4.
            </p>
            {targetPosesInvalid && (
              <span className="motionbricks-error" id="motionbricks-poses-error">
                Enter a whole number from 1 to 4.
              </span>
            )}
          </div>
        </div>
        <p className="helper motionbricks-group-help" id="motionbricks-frame-help">
          Each window reads four consecutive frames: the starting window leads into the generated
          transition, and the target window is the pose it should reach. Frame numbers are
          zero-based at 30 fps, including for 60 or 120 fps files. Both windows must fit inside the
          clip.
        </p>
      </fieldset>

      <fieldset className="motionbricks-group motionbricks-length-group">
        <legend>Generated transition length</legend>
        <div className="motionbricks-parameter-grid">
          <div>
            <label className="field-label" htmlFor="motionbricks-min-tokens">
              Minimum length (tokens)
            </label>
            <input
              id="motionbricks-min-tokens"
              type="number"
              min="6"
              max="16"
              step="1"
              value={minTokens}
              aria-invalid={minTokensInvalid || tokenOrderInvalid || undefined}
              aria-describedby={
                minTokensInvalid || tokenOrderInvalid
                  ? 'motionbricks-length-help motionbricks-token-error'
                  : 'motionbricks-length-help'
              }
              onChange={(event) => onChange({ minTokens: event.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="motionbricks-max-tokens">
              Maximum length (tokens)
            </label>
            <input
              id="motionbricks-max-tokens"
              type="number"
              min="6"
              max="16"
              step="1"
              value={maxTokens}
              aria-invalid={maxTokensInvalid || tokenOrderInvalid || undefined}
              aria-describedby={
                maxTokensInvalid || tokenOrderInvalid
                  ? 'motionbricks-length-help motionbricks-token-error'
                  : 'motionbricks-length-help'
              }
              onChange={(event) => onChange({ maxTokens: event.target.value })}
            />
          </div>
        </div>
        <p className="helper motionbricks-group-help" id="motionbricks-length-help">
          Choose 6–16 tokens; the minimum must not exceed the maximum. Each token is four frames at
          30 fps, and boundary frames are trimmed, so a transition has 4 × tokens − 6 frames
          {frameRangeText}.
        </p>
        {(minTokensInvalid || maxTokensInvalid || tokenOrderInvalid) && (
          <p className="motionbricks-error" id="motionbricks-token-error" aria-live="polite">
            {tokenOrderInvalid
              ? 'Minimum length must not exceed maximum length.'
              : 'Enter whole token counts from 6 to 16.'}
          </p>
        )}
      </fieldset>
    </section>
  );
}
