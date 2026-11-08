import { useRouteToggle, routeDetails } from './useNav';
import './image-video-settings.css';

const dimensions = {
  'Landscape · 16:9': [1024, 576],
  'Square · 1:1': [1024, 1024],
  'Portrait · 9:16': [576, 1024],
};
const imageSteps = { Balanced: 30, Draft: 12, 'High quality': 40 };
const videoSizes = {
  'Landscape · 16:9': '608 × 352',
  'Square · 1:1': '448 × 448',
  'Portrait · 9:16': '352 × 608',
};

export default function ImageVideoSettings({ section, draft, update }) {
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
  const widthError = numberError(draft.imageWidth, 32, 2048, true, 32);
  const heightError = numberError(draft.imageHeight, 32, 2048, true, 32);
  const stepsError = numberError(draft.imageSteps, 1, 100);
  const seedError =
    draft.seed === undefined || draft.seed === null || draft.seed === ''
      ? ''
      : Number.isSafeInteger(Number(draft.seed)) && Number(draft.seed) >= 0
        ? ''
        : 'Enter a whole number of 0 or more.';
  const customSize = Boolean((draft.imageWidth ?? '') !== '' || (draft.imageHeight ?? '') !== '');
  const aspectLabel = draft.options?.[0] || 'Landscape · 16:9';
  const guidanceError = draft.imageNegativePrompt?.trim()
    ? numberError(draft.imageGuidance, 1.1, 10, false)
    : '';
  const heading = image ? 'Fine-tune image' : 'Video quality';
  const contentId = `image-video-settings-${section}`;
  return (
    <details className="image-video-settings" {...routeDetails(tuneOpen, setTuneOpen)}>
      <summary aria-expanded={tuneOpen} aria-controls={contentId}>
        <span className="image-video-settings-heading">{heading}</span>
        <span className="image-video-settings-hint">
          {tuneOpen ? 'Hide optional controls' : 'Show optional controls'}
        </span>
      </summary>
      {image ? (
        <div className="image-video-settings-body" id={contentId}>
          <p className="image-video-settings-intro">
            Optional overrides for the selected aspect ratio and quality. Leave a value blank to
            keep its preset.
          </p>
          <div className="image-video-settings-grid">
            <label htmlFor="image-width">
              <span className="field-label">Width in pixels</span>
              <input
                id="image-width"
                type="number"
                inputMode="numeric"
                min="32"
                max="2048"
                step="32"
                placeholder={String(width)}
                aria-describedby={`image-width-help${widthError ? ' image-width-error' : ''}`}
                aria-invalid={widthError ? 'true' : undefined}
                value={draft.imageWidth ?? ''}
                onChange={(e) => update({ imageWidth: e.target.value })}
              />
              <small id="image-width-help">
                32–2048 px, in multiples of 32. Blank uses {width} px.
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
                max="2048"
                step="32"
                placeholder={String(height)}
                aria-describedby={`image-height-help${heightError ? ' image-height-error' : ''}`}
                aria-invalid={heightError ? 'true' : undefined}
                value={draft.imageHeight ?? ''}
                onChange={(e) => update({ imageHeight: e.target.value })}
              />
              <small id="image-height-help">
                32–2048 px, in multiples of 32. Blank uses {height} px.
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
                placeholder={String(steps)}
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
        </div>
      ) : (
        <div className="image-video-settings-body" id={contentId}>
          <p className="image-video-settings-intro">
            Optional override for video detail. More steps can improve detail and increase render
            time.
          </p>
          <label className="image-video-settings-video-field" htmlFor="video-steps">
            <span className="field-label">Sampling steps</span>
            <select
              id="video-steps"
              aria-describedby="video-steps-help"
              value={draft.videoSteps || 12}
              onChange={(e) => update({ videoSteps: Number(e.target.value) })}
            >
              <option value={8}>8 · faster</option>
              <option value={12}>12 · balanced</option>
              <option value={20}>20 · detailed</option>
              <option value={30}>30 · highest</option>
            </select>
            <small id="video-steps-help">
              Default: 12 steps. Higher settings usually take longer.
            </small>
          </label>
          <p className="image-video-settings-facts">
            H3 renders at {videoSizes[draft.options?.[0]] || '608 × 352'} pixels and 24 frames per
            second. The current renderer does not expose a seed.
          </p>
        </div>
      )}
    </details>
  );
}
