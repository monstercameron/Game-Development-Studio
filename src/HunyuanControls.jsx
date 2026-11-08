import {
  hunyuanGuidance,
  hunyuanSteps,
  hunyuanTriangles,
  HUNYUAN_PAINT_DEFAULT_TRIANGLES,
  HUNYUAN_PAINT_VIEW_COUNTS,
  HUNYUAN_PAINT_VIEW_SIZES,
} from './hunyuan-settings.js';
import './hunyuan-controls.css';

const SUPPORTED_RESOLUTIONS = [128, 256, 384];
const TRIANGLE_CHOICES = [10000, 20000, 40000, 80000, 150000, 300000];
const count = (value) => Number(value).toLocaleString('en-US');

function validation(read, value) {
  try {
    read(value);
    return '';
  } catch (error) {
    return error.message;
  }
}

// This exposes only parameters accepted by the connected Hunyuan backend.
export default function HunyuanControls({ draft, onChange }) {
  const steps = draft.shapeSteps === undefined ? 30 : (draft.shapeSteps ?? '');
  const guidance = draft.shapeGuidance === undefined ? 5 : (draft.shapeGuidance ?? '');
  const triangles = draft.shapeTriangles ?? '';
  const resolution = draft.resolution ?? 128;
  const texture = draft.texture === true;
  const textureSize = draft.textureSize ?? 2048;
  const textureSizeError = [1024, 2048].includes(Number(textureSize))
    ? ''
    : 'Choose a 1024 or 2048 pixel texture.';
  const stepsError = validation(hunyuanSteps, steps) ? 'Enter a whole number from 1 to 100.' : '';
  const guidanceError = validation(hunyuanGuidance, guidance) ? 'Enter a number from 1 to 20.' : '';
  const trianglesError = validation(hunyuanTriangles, triangles)
    ? 'Choose a triangle target from 1,000 to 1,000,000.'
    : '';
  const resolutionError = SUPPORTED_RESOLUTIONS.includes(Number(resolution))
    ? ''
    : 'Choose 128, 256, or 384 samples per axis.';
  const customTriangles =
    triangles !== '' && !TRIANGLE_CHOICES.includes(Number(triangles)) && !trianglesError;

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
            <option value={128}>128 samples per axis · about 90,000 triangles</option>
            <option value={256}>256 samples per axis · about 350,000 triangles</option>
            <option value={384}>384 samples per axis · about 870,000 triangles</option>
          </select>
          <p className="hunyuan-controls__hint" id="hunyuan-resolution-help">
            Sets the grid density used to build the surface. Higher values add fine detail and
            triangles and take longer (about 25 s, 35 s and 80 s on this computer). Triangle counts
            are from one test image and vary. Upstream also allows up to 512; Forge stops at 384.
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
        <div className="hunyuan-controls__field">
          <label className="field-label" htmlFor="hunyuan-guidance">
            Guidance scale
          </label>
          <input
            id="hunyuan-guidance"
            type="number"
            min="1"
            max="20"
            step="0.5"
            inputMode="decimal"
            value={guidance}
            aria-invalid={Boolean(guidanceError)}
            aria-describedby="hunyuan-guidance-help"
            onChange={(event) => onChange({ shapeGuidance: event.target.value })}
          />
          <p
            className={guidanceError ? 'hunyuan-controls__error' : 'hunyuan-controls__hint'}
            id="hunyuan-guidance-help"
            role={guidanceError ? 'alert' : undefined}
          >
            {guidanceError ||
              'From 1 to 20. The default is 5. Higher values follow the picture more closely and can look harsher.'}
          </p>
        </div>
        <div className="hunyuan-controls__field">
          <label className="field-label" htmlFor="hunyuan-triangles">
            Triangle budget
          </label>
          <select
            id="hunyuan-triangles"
            value={triangles}
            aria-invalid={Boolean(trianglesError)}
            aria-describedby="hunyuan-triangles-help"
            onChange={(event) => onChange({ shapeTriangles: event.target.value })}
          >
            <option value="">Automatic</option>
            {customTriangles && <option value={triangles}>{count(triangles)} (custom)</option>}
            {TRIANGLE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {count(choice)} triangles
              </option>
            ))}
          </select>
          <p
            className={trianglesError ? 'hunyuan-controls__error' : 'hunyuan-controls__hint'}
            id="hunyuan-triangles-help"
            role={trianglesError ? 'alert' : undefined}
          >
            {trianglesError ||
              (triangles !== ''
                ? `Simplifies the mesh to about ${count(triangles)} triangles. Fewer triangles suit game engines but lose fine detail; a mesh already below the target is left alone.`
                : texture
                  ? `Automatic simplifies the mesh to ${count(HUNYUAN_PAINT_DEFAULT_TRIANGLES)} triangles before painting.`
                  : 'Automatic keeps the raw mesh, about 90,000 triangles at 128 and several times more at higher octree resolutions. Use a budget for game-ready meshes.')}
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
          Visible seams and soft detail can remain; there is no normal map. Untextured is the
          default and the tested path.
        </p>
        {texture && (
          <div className="hunyuan-controls__fields hunyuan-controls__paint">
            <div className="hunyuan-controls__field">
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
            </div>
            <div className="hunyuan-controls__field">
              <label className="field-label" htmlFor="hunyuan-paint-views">
                Painted views (advanced)
              </label>
              <select
                id="hunyuan-paint-views"
                value={draft.textureViews ?? 6}
                aria-describedby="hunyuan-paint-views-help"
                onChange={(event) => onChange({ textureViews: Number(event.target.value) })}
              >
                {HUNYUAN_PAINT_VIEW_COUNTS.map((views) => (
                  <option key={views} value={views}>
                    {views} views{views === 6 ? ' · default' : ''}
                  </option>
                ))}
              </select>
              <p className="hunyuan-controls__hint" id="hunyuan-paint-views-help">
                The painter was trained on 6 views. More views cover more of the surface but take
                longer.
              </p>
            </div>
            <div className="hunyuan-controls__field">
              <label className="field-label" htmlFor="hunyuan-paint-view-size">
                View size (advanced)
              </label>
              <select
                id="hunyuan-paint-view-size"
                value={draft.textureViewSize ?? 512}
                aria-describedby="hunyuan-paint-view-size-help"
                onChange={(event) => onChange({ textureViewSize: Number(event.target.value) })}
              >
                {HUNYUAN_PAINT_VIEW_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size} pixels{size === 512 ? ' · default' : ''}
                  </option>
                ))}
              </select>
              <p className="hunyuan-controls__hint" id="hunyuan-paint-view-size-help">
                In a test here, 8 views at 768 pixels looked no better than the default, took about
                twice as long and used about 15 GB more GPU memory. Forge waits for that extra
                memory before it starts.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
