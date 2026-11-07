import { FolderOpen, Plus, X } from 'lucide-react';
import './motionbricks-controls.css';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

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

export default function MotionBricksControls({ draft, onChange, file, onFile, onLibrary }) {
  const contextFrame = draft.contextFrame ?? 0;
  const targetFrame = draft.targetFrame ?? 20;
  const minTokens = draft.minTokens ?? 8;
  const maxTokens = draft.maxTokens ?? 14;
  const contextFrameInvalid = !isOptionalInteger(contextFrame, 0);
  const targetFrameInvalid = !isOptionalInteger(targetFrame, 0);
  const minTokensInvalid = !isOptionalInteger(minTokens, 6, 16);
  const maxTokensInvalid = !isOptionalInteger(maxTokens, 6, 16);
  const tokenOrderInvalid =
    !minTokensInvalid && !maxTokensInvalid && Number(minTokens) > Number(maxTokens);
  const fileTooLarge = Boolean(file && file.size > MAX_SOURCE_BYTES);

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
              type="file"
              accept=".bvh"
              aria-label="Choose a SOMA BVH file"
              aria-required="true"
              aria-describedby="motionbricks-source-guidance"
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
          <label htmlFor="motionbricks-context-frame">
            <span className="field-label">Starting pose frame</span>
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
          </label>
          <label htmlFor="motionbricks-target-frame">
            <span className="field-label">Target pose frame</span>
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
          </label>
        </div>
        <p className="helper motionbricks-group-help" id="motionbricks-frame-help">
          Zero-based frame numbers use a 30 fps timebase, including for 60 or 120 fps files. Each
          selection reads four frames; both windows must fit inside the clip.
        </p>
      </fieldset>

      <fieldset className="motionbricks-group motionbricks-length-group">
        <legend>Generated transition length</legend>
        <div className="motionbricks-parameter-grid">
          <label htmlFor="motionbricks-min-tokens">
            <span className="field-label">Minimum length (tokens)</span>
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
          </label>
          <label htmlFor="motionbricks-max-tokens">
            <span className="field-label">Maximum length (tokens)</span>
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
          </label>
        </div>
        <p className="helper motionbricks-group-help" id="motionbricks-length-help">
          Choose 6–16 tokens, with the minimum no greater than the maximum. One token represents
          four frames; boundary frames are trimmed, so the final clip can be shorter.
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
