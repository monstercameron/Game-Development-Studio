import { FolderOpen, Plus, X } from 'lucide-react';

export default function MotionBricksControls({ draft, onChange, file, onFile, onLibrary }) {
  return (
    <>
      <div className="field-label reference-heading">
        SOMA motion clip <span>REQUIRED</span>
      </div>
      <label className="upload-box">
        <input
          type="file"
          accept=".bvh"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) {
              onFile(selected);
            }
            event.target.value = '';
          }}
        />
        <div className="upload-icon">
          <Plus size={19} />
        </div>
        <div>
          <strong>Choose a SOMA BVH file</strong>
          <small>30, 60 or 120 fps · up to 10 MiB</small>
        </div>
        <span className="upload-action">BROWSE FILES</span>
      </label>
      <button type="button" className="outline-button asset-library-button" onClick={onLibrary}>
        <FolderOpen size={15} /> Choose from asset library
      </button>
      {file && (
        <div className="ref-list">
          <span>
            {file.name}
            <button aria-label="Remove pose file" onClick={() => onFile(null)}>
              <X size={13} />
            </button>
          </span>
        </div>
      )}
      <p className="helper">
        Use a Y-up SOMA skeleton in centimeters. MotionBricks creates a transition between two
        four-frame windows; it does not rig or retarget a character.
      </p>
      <div className="options">
        <label>
          <span className="field-label">Starting window</span>
          <input
            type="number"
            min="0"
            step="1"
            value={draft.contextFrame ?? 0}
            onChange={(e) => onChange({ contextFrame: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Target window</span>
          <input
            type="number"
            min="0"
            step="1"
            value={draft.targetFrame ?? 20}
            onChange={(e) => onChange({ targetFrame: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Minimum length tokens</span>
          <input
            type="number"
            min="6"
            max="16"
            step="1"
            value={draft.minTokens ?? 8}
            onChange={(e) => onChange({ minTokens: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Maximum length tokens</span>
          <input
            type="number"
            min="6"
            max="16"
            step="1"
            value={draft.maxTokens ?? 14}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
          />
        </label>
      </div>
      <p className="helper">
        Window numbers are zero-based at 30 fps, even for higher-frame-rate files. Each window needs
        four frames. One token represents four frames; boundary frames are trimmed.
      </p>
    </>
  );
}
