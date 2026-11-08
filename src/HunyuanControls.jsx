import { hunyuanSteps } from './hunyuan-settings.js';
import './hunyuan-controls.css';

const SUPPORTED_RESOLUTIONS = [128, 256, 384];

// This exposes only parameters accepted by the connected Hunyuan backend.
export default function HunyuanControls({ draft, onChange }) {
  const steps = draft.shapeSteps === undefined ? 30 : (draft.shapeSteps ?? '');
  const resolution = draft.resolution ?? 128;
  const texture = draft.texture === true;
  const textureSize = draft.textureSize ?? 2048;
  const textureSizeError = [1024, 2048].includes(Number(textureSize))
    ? ''
    : 'Choose a 1024 or 2048 pixel texture.';
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
    <section className="hunyuan-controls" aria-label="Hunyuan 3D settings">
      <div className="hunyuan-controls__fields">
        <div className="hunyuan-controls__field">
          <label className="field-label" htmlFor="hunyuan-resolution">
            Octree resolution
          </label>
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
          <p className="hunyuan-controls__hint" id="hunyuan-resolution-help">
            Sets the grid density used to build the surface. Higher values take longer and use more
            GPU memory.
          </p>
          {resolutionError && (
            <p className="hunyuan-controls__error" id="hunyuan-resolution-error" role="alert">
              {resolutionError}
            </p>
          )}
        </div>
        <div className="hunyuan-controls__field">
          <label className="field-label" htmlFor="hunyuan-steps">
            Denoising steps
          </label>
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
          <p
            className={stepsError ? 'hunyuan-controls__error' : 'hunyuan-controls__hint'}
            id="hunyuan-steps-help"
            role={stepsError ? 'alert' : undefined}
          >
            {stepsError ||
              'Whole numbers from 1 to 100. The default is 30; more steps take longer.'}
          </p>
        </div>
      </div>
      <div className="hunyuan-controls__field hunyuan-controls__texture">
        <label className="hunyuan-controls__switch" htmlFor="hunyuan-texture">
          <input
            id="hunyuan-texture"
            type="checkbox"
            role="switch"
            checked={texture}
            aria-describedby="hunyuan-texture-help"
            onChange={(event) => onChange({ texture: event.target.checked })}
          />
          <span className="field-label">Paint texture (experimental)</span>
        </label>
        <p className="hunyuan-controls__hint" id="hunyuan-texture-help">
          Paints colour and metallic-roughness maps onto the shape using your reference image. It
          loads extra models, takes several more minutes, and needs more GPU and system memory.
          Untextured is the default and the tested path.
        </p>
        {texture && (
          <>
            <label className="field-label" htmlFor="hunyuan-texture-size">
              Texture map size
            </label>
            <select
              id="hunyuan-texture-size"
              value={textureSize}
              aria-invalid={Boolean(textureSizeError)}
              aria-describedby="hunyuan-texture-size-help"
              onChange={(event) => onChange({ textureSize: Number(event.target.value) })}
            >
              <option value={1024}>1024 pixels</option>
              <option value={2048}>2048 pixels</option>
            </select>
            <p
              className={textureSizeError ? 'hunyuan-controls__error' : 'hunyuan-controls__hint'}
              id="hunyuan-texture-size-help"
              role={textureSizeError ? 'alert' : undefined}
            >
              {textureSizeError || 'Larger maps hold more detail and make a larger file.'}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
