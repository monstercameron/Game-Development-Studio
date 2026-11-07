import { hunyuanSteps } from './hunyuan-settings.js';

// This exposes only parameters accepted by the connected shape backend.
export default function HunyuanControls({ draft, onChange }) {
  const steps = draft.shapeSteps === undefined ? 30 : (draft.shapeSteps ?? '');
  let invalid = false;
  try {
    hunyuanSteps(steps);
  } catch {
    invalid = true;
  }
  return (
    <>
      <div className="options">
        <label htmlFor="hunyuan-resolution">
          <span className="field-label">Mesh resolution</span>
          <select
            id="hunyuan-resolution"
            value={draft.resolution ?? 128}
            onChange={(event) => onChange({ resolution: Number(event.target.value) })}
          >
            <option value={128}>128 · tested</option>
            <option value={256}>256 · experimental</option>
            <option value={384}>384 · experimental</option>
          </select>
        </label>
        <label htmlFor="hunyuan-steps">
          <span className="field-label">Denoising steps</span>
          <input
            id="hunyuan-steps"
            type="number"
            min="1"
            max="100"
            step="1"
            value={steps}
            aria-invalid={invalid}
            aria-describedby="hunyuan-steps-help"
            onChange={(event) => onChange({ shapeSteps: event.target.value })}
          />
        </label>
      </div>
      <p id="hunyuan-steps-help" className="helper">
        {invalid
          ? 'Enter a whole number from 1 to 100.'
          : '30 steps has been tested. More steps and higher resolution can take longer and use more memory.'}
      </p>
    </>
  );
}
