import { hunyuanSteps } from './hunyuan-settings.js';
import './hunyuan-controls.css';

const SUPPORTED_RESOLUTIONS = [128, 256, 384];

// This exposes only parameters accepted by the connected shape backend.
export default function HunyuanControls({ draft, onChange }) {
  const steps = draft.shapeSteps === undefined ? 30 : (draft.shapeSteps ?? '');
  const resolution = draft.resolution ?? 128;
  let stepsError = '';
  try {
    hunyuanSteps(steps);
  } catch {
    stepsError = 'Enter a whole number from 1 to 100.';
  }
  const resolutionError = SUPPORTED_RESOLUTIONS.includes(Number(resolution))
    ? ''
    : 'Choose 128, 256, or 384 samples per axis.';

  return (
    <section className="hunyuan-controls" aria-label="Hunyuan shape settings">
      <div className="hunyuan-controls__fields">
        <label className="hunyuan-controls__field" htmlFor="hunyuan-resolution">
          <span className="field-label">Octree resolution</span>
          <select
            id="hunyuan-resolution"
            value={resolution}
            aria-invalid={Boolean(resolutionError)}
            aria-describedby={`hunyuan-resolution-help${resolutionError ? ' hunyuan-resolution-error' : ''}`}
            onChange={(event) => onChange({ resolution: Number(event.target.value) })}
          >
            <option value={128}>128 samples per axis · tested</option>
            <option value={256}>256 samples per axis · experimental</option>
            <option value={384}>384 samples per axis · experimental</option>
          </select>
          <span className="hunyuan-controls__hint" id="hunyuan-resolution-help">
            Controls the 3D grid used to build the surface. Higher values can take longer and use
            more GPU memory.
          </span>
          {resolutionError && (
            <span className="hunyuan-controls__error" id="hunyuan-resolution-error" role="alert">
              {resolutionError}
            </span>
          )}
        </label>
        <label className="hunyuan-controls__field" htmlFor="hunyuan-steps">
          <span className="field-label">Denoising steps</span>
          <input
            id="hunyuan-steps"
            type="number"
            min="1"
            max="100"
            step="1"
            inputMode="numeric"
            value={steps}
            aria-invalid={Boolean(stepsError)}
            aria-describedby="hunyuan-steps-help"
            onChange={(event) => onChange({ shapeSteps: event.target.value })}
          />
          <span
            className={stepsError ? 'hunyuan-controls__error' : 'hunyuan-controls__hint'}
            id="hunyuan-steps-help"
            role={stepsError ? 'alert' : undefined}
          >
            {stepsError ||
              'Whole numbers from 1 to 100. The default is 30; more steps can take longer.'}
          </span>
        </label>
      </div>
    </section>
  );
}
