import { useRouteToggle, routeDetails } from './useNav';
import {
  IMAGE_MAX_SIZE,
  IMAGE_MAX_VARIATIONS,
  LORA_MAX_SCALE,
  REFERENCE_TARGET,
  sigmaScheduleError,
} from './imageVideoInputs';
import VideoSettings, { videoChangedLabels } from './VideoSettings';
import './image-video-settings.css';

const dimensions = {
  'Landscape · 16:9': [1024, 576],
  'Square · 1:1': [1024, 1024],
  'Portrait · 9:16': [576, 1024],
};
const imageSteps = { Balanced: 30, Draft: 12, 'High quality': 40 };

// Above about two megapixels Qwen needs far more GPU memory (73 GB measured at 2752 × 1536).
const LARGE_IMAGE_PIXELS = 2.2e6;
const hasText = (value) => value !== undefined && value !== null && String(value) !== '';

export default function ImageVideoSettings({ section, draft, update, loras = [] }) {
  const [tuneOpen, setTuneOpen] = useRouteToggle('tune');
  if (section !== 'images' && section !== 'video') {
    return null;
  }
  const image = section === 'images';
  const [width, height] = dimensions[draft.options?.[0]] || [1024, 576];
  const steps = imageSteps[draft.options?.[1]] || 30;
  const numberError = (value, min, max, integer = true, multiple = 1) => {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      number < min ||
      number > max ||
      (integer && !Number.isSafeInteger(number)) ||
      (multiple > 1 && number % multiple !== 0)
    ) {
      return (
        `Enter ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}` +
        (multiple > 1 ? ` in multiples of ${multiple}.` : '.')
      );
    }
    return '';
  };
  const widthError = numberError(draft.imageWidth, 32, IMAGE_MAX_SIZE, true, 32);
  const heightError = numberError(draft.imageHeight, 32, IMAGE_MAX_SIZE, true, 32);
  const referenceCount = draft.refs?.length || 0;
  const matchReference = draft.imageMatchReference === true;
  const sizeFollowsReference = matchReference && referenceCount > 0;
  const sigmaError = sigmaScheduleError(draft.imageSigmas);
  const sigmaActive = Boolean(draft.imageSigmas?.trim()) && !sigmaError;
  const stepsError = sigmaActive ? '' : numberError(draft.imageSteps, 1, 100);
  const variationCount = Math.min(
    IMAGE_MAX_VARIATIONS,
    Math.max(1, Number(draft.imageVariations) || 1),
  );
  const loraMissing =
    Boolean(draft.imageLora) && !loras.some((item) => item.name === draft.imageLora);
  const loraScaleError = draft.imageLora
    ? numberError(draft.imageLoraScale, 0, LORA_MAX_SCALE, false)
    : '';
  const targetError = matchReference
    ? numberError(
        draft.imageTargetSize,
        REFERENCE_TARGET.min,
        REFERENCE_TARGET.max,
        true,
        REFERENCE_TARGET.step,
      )
    : '';
  const seedError =
    draft.seed === undefined || draft.seed === null || draft.seed === ''
      ? ''
      : Number.isSafeInteger(Number(draft.seed)) && Number(draft.seed) >= 0
        ? ''
        : 'Enter a whole number of 0 or more.';
  const customSize =
    !sizeFollowsReference &&
    Boolean((draft.imageWidth ?? '') !== '' || (draft.imageHeight ?? '') !== '');
  const aspectLabel = draft.options?.[0] || 'Landscape · 16:9';
  const guidanceError = draft.imageNegativePrompt?.trim()
    ? numberError(draft.imageGuidance, 1.1, 10, false)
    : '';
  const pixelWidth = Number(hasText(draft.imageWidth) ? draft.imageWidth : width);
  const pixelHeight = Number(hasText(draft.imageHeight) ? draft.imageHeight : height);
  const largeSize =
    !sizeFollowsReference &&
    !widthError &&
    !heightError &&
    pixelWidth * pixelHeight > LARGE_IMAGE_PIXELS;
  const heading = image ? 'Fine-tune image' : 'Fine-tune video';
  // Reused or saved values stay hidden while the panel is closed, so name what has been changed.
  const changed = image
    ? [
        [customSize || sizeFollowsReference, sizeFollowsReference ? 'size from reference' : 'size'],
        [hasText(draft.imageSteps), 'steps'],
        [hasText(draft.seed), 'seed'],
        [draft.imageNegativePrompt?.trim(), 'negative prompt'],
        [draft.imageTransparent === true, 'transparent background'],
        [variationCount > 1, 'variations'],
        [draft.imageLora, 'LoRA'],
        [matchReference && hasText(draft.imageTargetSize), 'reference size target'],
        [draft.imageKvCache === false, 'KV cache off'],
        [draft.imageSigmas?.trim(), 'sampling schedule'],
      ]
        .filter(([on]) => on)
        .map(([, label]) => label)
    : videoChangedLabels(draft);
  const contentId = `image-video-settings-${section}`;
  return (
    <details
      className={`image-video-settings ${image ? 'image-video-settings-images' : ''}`}
      {...routeDetails(tuneOpen, setTuneOpen)}
    >
      <summary aria-expanded={tuneOpen} aria-controls={contentId}>
        <span className="image-video-settings-heading">{heading}</span>
        <span className="image-video-settings-hint">
          {tuneOpen
            ? 'Hide optional controls'
            : changed.length
              ? `Show optional controls · changed: ${changed.join(', ')}`
              : 'Show optional controls'}
        </span>
      </summary>
      {image ? (
        <div className="image-video-settings-body" id={contentId}>
          <p className="image-video-settings-intro">
            Optional overrides for the selected aspect ratio and quality. Leave a value blank to
            keep its preset.
          </p>
          <div className="image-video-settings-toggles">
            <label className="image-video-settings-check" htmlFor="image-transparent">
              <input
                id="image-transparent"
                type="checkbox"
                aria-describedby="image-transparent-help"
                checked={draft.imageTransparent === true}
                onChange={(e) => update({ imageTransparent: e.target.checked })}
              />
              <span>
                <span className="field-label">Transparent background</span>
                <small id="image-transparent-help">
                  Asks Qwen for an RGBA PNG with a transparent background, for sprites, icons and
                  stickers. Works best with one clear subject. Forge adds Qwen&rsquo;s recommended
                  wording to your prompt; your own text is what is saved.
                </small>
              </span>
            </label>
            <label className="image-video-settings-check" htmlFor="image-match-reference">
              <input
                id="image-match-reference"
                type="checkbox"
                aria-describedby="image-match-reference-help"
                checked={matchReference}
                onChange={(e) => update({ imageMatchReference: e.target.checked })}
              />
              <span>
                <span className="field-label">Match the last reference&rsquo;s shape</span>
                <small id="image-match-reference-help">
                  Keeps the aspect ratio of the last reference image at about 1 megapixel instead of
                  the width and height below. Useful for edits.
                </small>
                {matchReference && referenceCount === 0 && (
                  <small className="image-video-settings-error" role="alert">
                    Add a reference image first, or turn this off.
                  </small>
                )}
              </span>
            </label>
          </div>
          <div className="image-video-settings-grid">
            <label htmlFor="image-width">
              <span className="field-label">Width in pixels</span>
              <input
                id="image-width"
                type="number"
                inputMode="numeric"
                min="32"
                max={IMAGE_MAX_SIZE}
                step="32"
                disabled={sizeFollowsReference}
                placeholder={sizeFollowsReference ? 'From reference' : String(width)}
                aria-describedby={`image-width-help${widthError ? ' image-width-error' : ''}`}
                aria-invalid={widthError ? 'true' : undefined}
                value={sizeFollowsReference ? '' : (draft.imageWidth ?? '')}
                onChange={(e) => update({ imageWidth: e.target.value })}
              />
              <small id="image-width-help">
                {sizeFollowsReference
                  ? 'Set by the last reference image.'
                  : `32–${IMAGE_MAX_SIZE} px, in multiples of 32. Blank uses ${width} px.`}
              </small>
              {widthError && (
                <small id="image-width-error" className="image-video-settings-error" role="alert">
                  {widthError}
                </small>
              )}
            </label>
            <label htmlFor="image-height">
              <span className="field-label">Height in pixels</span>
              <input
                id="image-height"
                type="number"
                inputMode="numeric"
                min="32"
                max={IMAGE_MAX_SIZE}
                step="32"
                disabled={sizeFollowsReference}
                placeholder={sizeFollowsReference ? 'From reference' : String(height)}
                aria-describedby={`image-height-help${heightError ? ' image-height-error' : ''}`}
                aria-invalid={heightError ? 'true' : undefined}
                value={sizeFollowsReference ? '' : (draft.imageHeight ?? '')}
                onChange={(e) => update({ imageHeight: e.target.value })}
              />
              <small id="image-height-help">
                {sizeFollowsReference
                  ? 'Set by the last reference image.'
                  : `32–${IMAGE_MAX_SIZE} px, in multiples of 32. Blank uses ${height} px.`}
              </small>
              {heightError && (
                <small id="image-height-error" className="image-video-settings-error" role="alert">
                  {heightError}
                </small>
              )}
            </label>
            <label htmlFor="image-steps">
              <span className="field-label">Sampling steps</span>
              <input
                id="image-steps"
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                disabled={sigmaActive}
                placeholder={sigmaActive ? 'From schedule' : String(steps)}
                aria-describedby={`image-steps-help${stepsError ? ' image-steps-error' : ''}`}
                aria-invalid={stepsError ? 'true' : undefined}
                value={draft.imageSteps ?? ''}
                onChange={(e) => update({ imageSteps: e.target.value })}
              />
              <small id="image-steps-help">
                1–100 steps. More steps can add refinement and take longer; blank uses {steps}.
              </small>
              {stepsError && (
                <small id="image-steps-error" className="image-video-settings-error" role="alert">
                  {stepsError}
                </small>
              )}
            </label>
            <label htmlFor="image-seed">
              <span className="field-label">
                Seed <span className="image-video-optional">Optional</span>
              </span>
              <input
                id="image-seed"
                type="number"
                inputMode="numeric"
                min="0"
                step="1"
                placeholder="Random"
                aria-describedby={`image-seed-help${seedError ? ' image-seed-error' : ''}`}
                aria-invalid={seedError ? 'true' : undefined}
                value={draft.seed ?? ''}
                onChange={(e) => update({ seed: e.target.value })}
              />
              <small id="image-seed-help">
                Whole number, 0 or more. Blank picks a random seed; reuse a seed with the same
                settings to try to repeat a result.
              </small>
              {seedError && (
                <small id="image-seed-error" className="image-video-settings-error" role="alert">
                  {seedError}
                </small>
              )}
            </label>
          </div>
          <div className="image-video-settings-grid">
            <label htmlFor="image-variations">
              <span className="field-label">Variations</span>
              <select
                id="image-variations"
                aria-describedby="image-variations-help"
                value={variationCount}
                onChange={(e) => update({ imageVariations: Number(e.target.value) })}
              >
                <option value={1}>1 · single render</option>
                {Array.from({ length: IMAGE_MAX_VARIATIONS - 1 }, (_, index) => index + 2).map(
                  (count) => (
                    <option key={count} value={count}>
                      {count} renders
                    </option>
                  ),
                )}
              </select>
              <small id="image-variations-help">
                {variationCount > 1
                  ? `Queues ${variationCount} renders with the same settings and different seeds, shown as "variation 1 of ${variationCount}". A seed you enter is used for the first and counted up from there.`
                  : 'Queue 2 to 4 renders at once with different seeds to compare. The model makes one image per render.'}
              </small>
            </label>
            <label htmlFor="image-lora">
              <span className="field-label">
                LoRA <span className="image-video-optional">Optional</span>
              </span>
              <select
                id="image-lora"
                aria-describedby={`image-lora-help${loraMissing ? ' image-lora-missing' : ''}`}
                value={draft.imageLora || ''}
                onChange={(e) => update({ imageLora: e.target.value })}
              >
                <option value="">None</option>
                {loraMissing && (
                  <option value={draft.imageLora}>{draft.imageLora} (not found)</option>
                )}
                {loras.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              <small id="image-lora-help">
                {loras.length
                  ? 'Applied to this render only. Needs a LoRA made for Qwen Image 2.1. Many LoRAs only act when their trigger word is in the prompt (the camera-angle LoRA needs <mva> at the start).'
                  : 'No LoRA files found. Copy .safetensors files into models/Qwen-Image-2.1-LoRA and reopen this page.'}
              </small>
              {loraMissing && (
                <small id="image-lora-missing" className="image-video-settings-error" role="alert">
                  This LoRA file is not in the LoRA folder. Choose another or None.
                </small>
              )}
            </label>
            {draft.imageLora && (
              <label htmlFor="image-lora-scale">
                <span className="field-label">LoRA strength</span>
                <input
                  id="image-lora-scale"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max={LORA_MAX_SCALE}
                  step="0.05"
                  placeholder="1"
                  aria-describedby={`image-lora-scale-help${loraScaleError ? ' image-lora-scale-error' : ''}`}
                  aria-invalid={loraScaleError ? 'true' : undefined}
                  value={draft.imageLoraScale ?? ''}
                  onChange={(e) => update({ imageLoraScale: e.target.value })}
                />
                <small id="image-lora-scale-help">
                  0–{LORA_MAX_SCALE}; blank uses 1. Lower blends the LoRA in more gently.
                </small>
                {loraScaleError && (
                  <small
                    id="image-lora-scale-error"
                    className="image-video-settings-error"
                    role="alert"
                  >
                    {loraScaleError}
                  </small>
                )}
              </label>
            )}
            {matchReference && (
              <label htmlFor="image-target-size">
                <span className="field-label">Reference size target</span>
                <input
                  id="image-target-size"
                  type="number"
                  inputMode="numeric"
                  min={REFERENCE_TARGET.min}
                  max={REFERENCE_TARGET.max}
                  step={REFERENCE_TARGET.step}
                  placeholder={String(REFERENCE_TARGET.fallback)}
                  aria-describedby={`image-target-size-help${targetError ? ' image-target-size-error' : ''}`}
                  aria-invalid={targetError ? 'true' : undefined}
                  value={draft.imageTargetSize ?? ''}
                  onChange={(e) => update({ imageTargetSize: e.target.value })}
                />
                <small id="image-target-size-help">
                  Side length in pixels the matched size is built around; blank uses{' '}
                  {REFERENCE_TARGET.fallback} (about 1 megapixel). Larger needs much more GPU
                  memory.
                </small>
                {targetError && (
                  <small
                    id="image-target-size-error"
                    className="image-video-settings-error"
                    role="alert"
                  >
                    {targetError}
                  </small>
                )}
              </label>
            )}
          </div>
          <div className="image-video-settings-toggles">
            <label className="image-video-settings-check" htmlFor="image-kv-cache">
              <input
                id="image-kv-cache"
                type="checkbox"
                aria-describedby="image-kv-cache-help"
                checked={draft.imageKvCache !== false}
                onChange={(e) => update({ imageKvCache: e.target.checked })}
              />
              <span>
                <span className="field-label">Advanced: KV cache</span>
                <small id="image-kv-cache-help">
                  On by default. It reuses the prompt and reference computations on every step,
                  which speeds up edits with references. Turn it off only to compare: the same seed
                  then gives a different but equally valid image.
                </small>
              </span>
            </label>
          </div>
          <label className="image-video-settings-wide" htmlFor="image-sigmas">
            <span className="field-label">
              Advanced: custom sampling schedule{' '}
              <span className="image-video-optional">Optional</span>
            </span>
            <input
              id="image-sigmas"
              type="text"
              spellCheck={false}
              placeholder="Model schedule"
              aria-describedby={`image-sigmas-help${sigmaError ? ' image-sigmas-error' : ''}`}
              aria-invalid={sigmaError ? 'true' : undefined}
              value={draft.imageSigmas ?? ''}
              onChange={(e) => update({ imageSigmas: e.target.value })}
            />
            <small id="image-sigmas-help">
              Expert. Comma-separated sigmas that fall from 1 (for example 1, 0.8, 0.5, 0.2); their
              count replaces Sampling steps. Blank uses the model&rsquo;s own schedule, which is
              almost always best.
            </small>
            {sigmaError && (
              <small id="image-sigmas-error" className="image-video-settings-error" role="alert">
                {sigmaError}
              </small>
            )}
          </label>
          {largeSize && (
            <p className="image-video-settings-warning" role="status">
              {pixelWidth} × {pixelHeight} is a very large image. A 2752 × 1536 test used about 73
              GB of GPU memory and 45 seconds for only 4 steps. Close other models first, or lower
              the size.
            </p>
          )}
          {customSize && (
            <div className="image-video-settings-override" role="status">
              <span>
                A custom size is set. The aspect ratio ({aspectLabel}) only fills blank fields.
              </span>
              <button
                type="button"
                className="outline-button"
                onClick={() => update({ imageWidth: '', imageHeight: '' })}
              >
                Clear custom size
              </button>
            </div>
          )}
          <label className="image-video-settings-wide" htmlFor="image-negative-prompt">
            <span className="field-label">
              Negative prompt <span className="image-video-optional">Optional</span>
            </span>
            <textarea
              id="image-negative-prompt"
              className="short-text"
              maxLength={4000}
              aria-describedby="image-negative-prompt-help"
              value={draft.imageNegativePrompt ?? ''}
              onChange={(e) => update({ imageNegativePrompt: e.target.value })}
              placeholder="Describe what to avoid"
            />
            <small id="image-negative-prompt-help">
              Describe details to avoid. Its guidance control appears below when you enter text;
              blank guidance uses 2.
            </small>
          </label>
          {draft.imageNegativePrompt?.trim() && (
            <>
              <label className="image-video-settings-wide" htmlFor="image-guidance">
                <span className="field-label">Negative prompt guidance</span>
                <input
                  id="image-guidance"
                  type="number"
                  min="1.1"
                  max="10"
                  step="0.1"
                  placeholder="2"
                  aria-describedby={`image-guidance-help${guidanceError ? ' image-guidance-error' : ''}`}
                  aria-invalid={guidanceError ? 'true' : undefined}
                  value={draft.imageGuidance ?? ''}
                  onChange={(e) => update({ imageGuidance: e.target.value })}
                />
                <small id="image-guidance-help">
                  1.1–10; blank uses 2. Higher values strengthen avoidance and can take longer. Qwen
                  normally runs without guidance.
                </small>
                {guidanceError && (
                  <small
                    id="image-guidance-error"
                    className="image-video-settings-error"
                    role="alert"
                  >
                    {guidanceError}
                  </small>
                )}
              </label>
            </>
          )}
          <p className="image-video-settings-facts">
            Each render makes one image; Variations queues several with different seeds. Qwen Image
            uses one scheduler (flow-matching Euler with dynamic shifting), so the choice is the
            sampling schedule above rather than a sampler list. A painted mask is not an engine
            input: to change part of an image, add it as a reference and describe the edit; a mask
            or marked-up copy can be added as another reference and described in the prompt.
          </p>
        </div>
      ) : (
        <VideoSettings draft={draft} update={update} contentId={contentId} />
      )}
    </details>
  );
}
