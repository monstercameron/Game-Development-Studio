import { trellisRequest } from './trellis-settings';
import './trellis-controls.css';

const validationReference = '00000000-0000-0000-0000-000000000000.png';

export default function TrellisControls({ draft, onChange }) {
  const steps = draft.trellisSteps === undefined ? 12 : (draft.trellisSteps ?? '');
  let stepsError = '';

  try {
    trellisRequest({ ...draft, seed: 42, trellisSteps: steps, trellisTexture: 1024 }, [
      validationReference,
    ]);
  } catch (reason) {
    stepsError = reason.message;
  }

  return (
    <section className="trellis-controls" aria-label="TRELLIS.2 settings">
      <aside className="trellis-controls__status" aria-label="TRELLIS.2 experimental status">
        <span className="trellis-controls__badge">Experimental</span>
        <p>TRELLIS.2 makes textured 3D models. A complete render has not yet been verified.</p>
      </aside>

      <p className="trellis-controls__reference-help">
        Requires one PNG or WebP with a transparent background (alpha channel). A checkerboard
        flattened into the image is opaque.
      </p>

      <div className="trellis-controls__fields">
        <div className="trellis-controls__field">
          <label htmlFor="trellis-texture">
            <span className="field-label">Texture size</span>
            <select
              id="trellis-texture"
              value={draft.trellisTexture ?? 1024}
              aria-describedby="trellis-texture-help"
              onChange={(event) => onChange({ trellisTexture: Number(event.target.value) })}
            >
              <option value={512}>512 px</option>
              <option value={1024}>1024 px</option>
              <option value={2048}>2048 px</option>
            </select>
          </label>
          <p id="trellis-texture-help" className="trellis-controls__help">
            Larger textures can take longer and use more memory.
          </p>
        </div>

        <div className="trellis-controls__field">
          <label htmlFor="trellis-steps">
            <span className="field-label">Denoising steps</span>
            <input
              id="trellis-steps"
              type="number"
              min="1"
              max="50"
              step="1"
              value={steps}
              aria-invalid={stepsError ? 'true' : undefined}
              aria-describedby={`trellis-steps-help${stepsError ? ' trellis-steps-error' : ''}`}
              onChange={(event) => onChange({ trellisSteps: event.target.value })}
            />
          </label>
          <p id="trellis-steps-help" className="trellis-controls__help">
            Whole number from 1 to 50. Default: 12. More steps can take longer.
          </p>
          {stepsError && (
            <p id="trellis-steps-error" className="trellis-controls__error" aria-live="polite">
              {stepsError}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
