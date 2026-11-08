import {
  SEGMENTATION_MATCH_CHOICES,
  SEGMENTATION_MAX_INSTANCES,
  SEGMENTATION_MAX_INSTANCES_DEFAULT,
  matchChoice,
  maxInstancesProblem,
} from './segmentation-settings.js';

// Which of the matches SAM finds become the result, plus the limit for "best-scoring matches".
export default function SegmentationMatchControls({ draft, onChange }) {
  const choice = matchChoice(draft.matches);
  const limit = draft.maxInstances ?? SEGMENTATION_MAX_INSTANCES_DEFAULT;
  const problem = maxInstancesProblem(choice, limit);
  return (
    <>
      <div className="options" data-section="segmentation-matches">
        <label htmlFor="segmentation-matches">
          <span className="field-label">Which matches</span>
          <select
            id="segmentation-matches"
            value={choice}
            onChange={(e) => onChange({ matches: e.target.value })}
          >
            {SEGMENTATION_MATCH_CHOICES.map(([label, id]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {choice === 'top' && (
        <label htmlFor="segmentation-max-instances">
          <span className="field-label">Most matches to keep</span>
          <input
            id="segmentation-max-instances"
            className="segmentation-confidence"
            type="number"
            min="1"
            max={SEGMENTATION_MAX_INSTANCES}
            step="1"
            inputMode="numeric"
            value={limit}
            aria-invalid={problem ? 'true' : undefined}
            aria-describedby="segmentation-max-instances-help"
            onChange={(e) => onChange({ maxInstances: e.target.value })}
          />
          <p
            id="segmentation-max-instances-help"
            className={problem ? 'helper field-error' : 'helper'}
            role={problem ? 'alert' : undefined}
          >
            {problem ||
              `Keeps this many of the highest-scoring matches (1 to ${SEGMENTATION_MAX_INSTANCES}). If fewer are found, all of them are kept.`}
          </p>
        </label>
      )}
    </>
  );
}
