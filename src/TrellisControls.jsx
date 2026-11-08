import {
  trellisRequest,
  TRELLIS_DEFAULT_PIPELINE,
  TRELLIS_DEFAULT_TRIANGLES,
  TRELLIS_PIPELINES,
} from './trellis-settings';
import { useInstalledTrellisPipelines } from './useInstalledTrellisPipelines';
import './trellis-controls.css';

const validationReference = '00000000-0000-0000-0000-000000000000.png';
// Triangle budgets offered in the menu. Any other saved count is shown as a custom option.
const TRIANGLE_CHOICES = [20000, 50000, 100000, 250000, 500000, 1000000];
const formatCount = (value) => Number(value).toLocaleString('en-US');

// Checks one control at a time, with every other control held at a valid value.
function fieldError(overrides) {
  try {
    trellisRequest(
      { seed: 42, trellisSteps: 12, trellisTexture: 1024, trellisTriangles: 100000, ...overrides },
      [validationReference],
    );
    return '';
    // log-coverage: ignore -- render-time validator (inline message), not logged per render
  } catch (reason) {
    return reason.message;
  }
}

// installedPipelines is for tests; the studio asks the runtime which checkpoints are on disk.
export default function TrellisControls({ draft, onChange, installedPipelines }) {
  const reported = useInstalledTrellisPipelines();
  const installed = installedPipelines === undefined ? reported : installedPipelines;
  // Only pipelines whose checkpoints exist are offered. While that is unknown, every pipeline is
  // shown and the worker rejects one that is missing with a clear message.
  const offered = TRELLIS_PIPELINES.filter((item) => !installed || installed.includes(item.id));
  const fromDescription = draft.threeDMode === 'text';
  const pipelineId = draft.trellisPipeline ?? TRELLIS_DEFAULT_PIPELINE;
  const pipeline = TRELLIS_PIPELINES.find((item) => item.id === pipelineId);
  const steps = draft.trellisSteps === undefined ? 12 : (draft.trellisSteps ?? '');
  const triangles = draft.trellisTriangles ?? TRELLIS_DEFAULT_TRIANGLES;
  const stepsError = fieldError({ trellisSteps: steps });
  const trianglesError = fieldError({ trellisTriangles: triangles });
  const customTriangles = !TRIANGLE_CHOICES.includes(Number(triangles)) && !trianglesError;

  return (
    <section className="trellis-controls" aria-label="TRELLIS.2 settings">
      <aside className="trellis-controls__status" aria-label="TRELLIS.2 experimental status">
        <span className="trellis-controls__badge">Experimental</span>
        <p>
          TRELLIS.2 makes textured 3D models with colour and metallic-roughness maps. Renders
          complete on this computer for all four pipelines, but each was timed on one simple object
          only, and memory use is not calibrated: Forge&apos;s GPU and system memory waits are
          cautious guesses.
        </p>
      </aside>

      <p className="trellis-controls__reference-help">
        {fromDescription
          ? 'The picture comes from your description: Qwen Image draws it with a transparent background first, so no reference image is needed.'
          : 'Requires one PNG or WebP with a transparent background (alpha channel); an opaque image is rejected unless you remove its background first (above). A checkerboard flattened into the image is opaque. Segmentation can also cut an object out.'}
      </p>

      <div className="trellis-controls__fields">
        <div className="trellis-controls__field">
          <label htmlFor="trellis-pipeline">
            <span className="field-label">Pipeline</span>
            <select
              id="trellis-pipeline"
              value={pipelineId}
              aria-describedby="trellis-pipeline-help"
              onChange={(event) => onChange({ trellisPipeline: event.target.value })}
            >
              {offered.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <p id="trellis-pipeline-help" className="trellis-controls__help">
            {pipeline?.summary}{' '}
            {pipeline && pipeline.id !== TRELLIS_DEFAULT_PIPELINE
              ? `Forge waits for about ${pipeline.gpuGiB} GB of free GPU memory (a cautious guess). The first render with a higher pipeline also reads about 5 GB of extra checkpoints into system memory. One test object took ${pipeline.measured}; yours may differ.`
              : `Forge waits for about 24 GB of free GPU memory. One test object took ${pipeline?.measured ?? 'about 1 minute'}; yours may differ.`}
          </p>
        </div>

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
          <label htmlFor="trellis-triangles">
            <span className="field-label">Triangle budget</span>
            <select
              id="trellis-triangles"
              value={triangles}
              aria-invalid={trianglesError ? 'true' : undefined}
              aria-describedby={`trellis-triangles-help${trianglesError ? ' trellis-triangles-error' : ''}`}
              onChange={(event) => onChange({ trellisTriangles: Number(event.target.value) })}
            >
              {customTriangles && (
                <option value={triangles}>{formatCount(triangles)} (custom)</option>
              )}
              {TRIANGLE_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {formatCount(choice)} triangles
                  {choice === TRELLIS_DEFAULT_TRIANGLES ? ' · default' : ''}
                  {choice === 1000000 ? ' · upstream default' : ''}
                </option>
              ))}
            </select>
          </label>
          <p id="trellis-triangles-help" className="trellis-controls__help">
            Triangles in the exported mesh. The default of 100,000 suits most game assets; 1,000,000
            keeps the most detail but makes a file of 30 MB or more.
          </p>
          {trianglesError && (
            <p id="trellis-triangles-error" className="trellis-controls__error" role="alert">
              {trianglesError}
            </p>
          )}
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
            Whole number from 1 to 50. Default: 12. The same count is used for each of TRELLIS.2's
            three sampling stages, so more steps take longer.
          </p>
          {stepsError && (
            <p id="trellis-steps-error" className="trellis-controls__error" role="alert">
              {stepsError}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
