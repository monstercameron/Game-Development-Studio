export default function HyMotionControls({ draft, onChange }) {
  return (
    <>
      <div className="options">
        <label>
          <span className="field-label">Duration in seconds</span>
          <input
            type="number"
            min="1"
            max="12"
            step="0.5"
            value={draft.motionDuration ?? 3}
            onChange={(event) => onChange({ motionDuration: event.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Sampling steps</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            value={draft.motionSteps ?? 50}
            onChange={(event) => onChange({ motionSteps: event.target.value })}
          />
        </label>
        <label>
          <span className="field-label">Guidance</span>
          <input
            type="number"
            min="0"
            max="20"
            step="0.5"
            value={draft.motionGuidance ?? 5}
            onChange={(event) => onChange({ motionGuidance: event.target.value })}
          />
        </label>
      </div>
      <p className="helper">
        Experimental on Windows ARM64. Creates one human motion as a 30 fps BVH skeleton. Longer
        clips and more steps need more time and memory. Retargeting to your character is separate.
      </p>
    </>
  );
}
