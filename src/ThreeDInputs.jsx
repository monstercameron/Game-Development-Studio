import { useEffect, useRef } from 'react';
import FieldError from './FieldError';
import { alphaStatusFor, fileKey, measureTransparency } from './image-alpha.js';
import {
  REMOVE_BACKGROUND_DEFAULT_PROMPT,
  REMOVE_PROMPT_LIMIT,
  TEXT_PROMPT_LIMIT,
  TEXT_TO_3D_IMAGE_STEPS,
} from './three-d-requests.js';
import './three-d-inputs.css';

const IMAGE_STEP_RANGE = [1, 100];

// "Start from": a reference picture, or a description that Qwen Image turns into a picture first.
export function ThreeDModeSwitch({ draft, onChange, trellis, descriptionError = '' }) {
  const text = draft.threeDMode === 'text';
  const modelName = trellis ? 'TRELLIS.2' : 'Hunyuan3D 2.1';
  const steps = draft.textImageSteps === undefined ? TEXT_TO_3D_IMAGE_STEPS : draft.textImageSteps;
  const stepsNumber = Number(steps);
  const stepsInvalid =
    String(steps).trim() === '' ||
    !Number.isInteger(stepsNumber) ||
    stepsNumber < IMAGE_STEP_RANGE[0] ||
    stepsNumber > IMAGE_STEP_RANGE[1];
  const seed = draft.textImageSeed ?? '';
  const seedInvalid =
    String(seed).trim() !== '' &&
    (!Number.isSafeInteger(Number(seed)) || Number(seed) < 0 || !/^\d+$/.test(String(seed).trim()));
  return (
    <fieldset className="three-d-inputs three-d-mode">
      <legend className="field-label">Start from</legend>
      <div className="three-d-mode__choices">
        <label>
          <input
            type="radio"
            name="three-d-mode"
            checked={!text}
            onChange={() => onChange({ threeDMode: 'image' })}
          />
          <span>A reference image</span>
        </label>
        <label>
          <input
            type="radio"
            name="three-d-mode"
            checked={text}
            onChange={() => onChange({ threeDMode: 'text' })}
          />
          <span>A description</span>
        </label>
      </div>
      {text && (
        <div className="three-d-text">
          <label htmlFor="three-d-text-prompt" className="field-label">
            Describe the object <span>REQUIRED</span>
          </label>
          <textarea
            id="three-d-text-prompt"
            rows={4}
            maxLength={TEXT_PROMPT_LIMIT}
            value={draft.prompt ?? ''}
            placeholder="A weathered wooden barrel with iron bands, stylised game prop, whole object in view"
            aria-invalid={descriptionError ? 'true' : undefined}
            aria-describedby={
              descriptionError ? 'three-d-text-help three-d-text-prompt-error' : 'three-d-text-help'
            }
            onChange={(event) => onChange({ prompt: event.target.value })}
          />
          <FieldError id="three-d-text-prompt-error" message={descriptionError} />
          <p id="three-d-text-help" className="three-d-inputs__hint">
            One object, fully in view, works best. Forge first draws it with Qwen Image 2.1 (1024 ×
            1024, transparent background, always on), saves that picture in your project, then
            builds the 3D model from it with {modelName}. Check the picture in the project library
            if the model looks wrong.
          </p>
          <div className="three-d-text__fields">
            <label htmlFor="three-d-image-steps">
              <span className="field-label">Image steps</span>
              <input
                id="three-d-image-steps"
                type="number"
                min={IMAGE_STEP_RANGE[0]}
                max={IMAGE_STEP_RANGE[1]}
                step="1"
                value={steps}
                aria-invalid={stepsInvalid ? 'true' : undefined}
                aria-describedby="three-d-image-steps-help"
                onChange={(event) => onChange({ textImageSteps: event.target.value })}
              />
            </label>
            <label htmlFor="three-d-image-seed">
              <span className="field-label">Image seed</span>
              <input
                id="three-d-image-seed"
                type="text"
                inputMode="numeric"
                value={seed}
                placeholder="Random"
                aria-invalid={seedInvalid ? 'true' : undefined}
                aria-describedby="three-d-image-steps-help"
                onChange={(event) => onChange({ textImageSeed: event.target.value })}
              />
            </label>
          </div>
          <p
            id="three-d-image-steps-help"
            className={
              stepsInvalid || seedInvalid ? 'three-d-inputs__error' : 'three-d-inputs__hint'
            }
            role={stepsInvalid || seedInvalid ? 'alert' : undefined}
          >
            {stepsInvalid
              ? 'Image steps must be a whole number from 1 to 100.'
              : seedInvalid
                ? 'The image seed must be a whole number from 0, or empty for a random one.'
                : `Image steps: 1 to 100, default ${TEXT_TO_3D_IMAGE_STEPS}. More steps take longer. The 3D settings below (and the 3D seed) apply to the model step.`}
          </p>
          <p className="three-d-inputs__memory">
            Two models run one after the other: Qwen Image draws the picture, then {modelName}{' '}
            builds the model. Forge frees the first model before loading the second when it can
            (when it started that model, nothing else is using it, and no other queued render needs
            it), and checks GPU and system memory before each, so the second stage can include a
            model load. The estimate on this page covers the 3D step only.
          </p>
        </div>
      )}
    </fieldset>
  );
}

// Help text under "Remove the background first" for each picture state. TRELLIS.2 rejects an
// opaque picture outright, so its warning is stronger than the Hunyuan3D one.
function backgroundHelpText({ alreadyTransparent, checked, alpha, trellis }) {
  if (alreadyTransparent) {
    return 'This picture already has a transparent background, so there is nothing to remove. Forge uses it as it is.';
  }
  if (checked) {
    return 'Queues two renders: SAM 3.1 cuts out what you describe (saved as a transparent PNG in your project), then the 3D model is built from the cutout. Forge frees SAM 3.1 before loading the 3D model when it can. If SAM 3.1 finds nothing, the 3D render stops with that message.';
  }
  if (alpha === 'opaque') {
    return trellis
      ? 'This picture has no transparent background, and TRELLIS.2 rejects it. Tick this box to cut the object out first.'
      : 'This picture has no transparent background. Hunyuan3D treats an opaque picture as all object, so the background becomes part of the model unless you remove it.';
  }
  return trellis
    ? 'Cuts the object out of an ordinary picture before the 3D step. Tick it before choosing a JPEG: TRELLIS.2 only lists PNG and WebP files until then. Skip it when the picture already has a transparent background.'
    : 'Cuts the object out of an ordinary picture before the 3D step. Skip it when the picture already has a transparent background.';
}

// "Remove the background first": SAM 3.1 cuts the object out, then the 3D render uses the cutout.
export function ThreeDBackgroundOption({ draft, onChange, file, trellis }) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const key = fileKey(file);
  const stored = draft.refAlpha;
  useEffect(() => {
    let active = true;
    if (!file) {
      if (stored) {
        onChangeRef.current({ refAlpha: null });
      }
      return undefined;
    }
    if (stored?.key === key) {
      return undefined;
    }
    measureTransparency(file).then((result) => {
      if (active) {
        onChangeRef.current({ refAlpha: { key, status: result.status } });
      }
    });
    return () => {
      active = false;
    };
    // The measurement depends only on which file is chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const alpha = alphaStatusFor(file, stored);
  const alreadyTransparent = alpha === 'transparent';
  const checked = draft.removeBackground === true && !alreadyTransparent;
  const promptValue = draft.removeBackgroundPrompt ?? '';
  return (
    <div className="three-d-inputs three-d-background">
      <label className="three-d-background__switch" htmlFor="three-d-remove-background">
        <input
          id="three-d-remove-background"
          type="checkbox"
          checked={checked}
          disabled={alreadyTransparent}
          aria-describedby="three-d-background-help"
          onChange={(event) => onChange({ removeBackground: event.target.checked })}
        />
        <span className="field-label">Remove the background first (uses SAM 3.1)</span>
      </label>
      <p id="three-d-background-help" className="three-d-inputs__hint" aria-live="polite">
        {backgroundHelpText({ alreadyTransparent, checked, alpha, trellis })}
      </p>
      {checked && (
        <div className="three-d-background__prompt">
          <label htmlFor="three-d-remove-prompt">
            <span className="field-label">What to isolate</span>
            <input
              id="three-d-remove-prompt"
              type="text"
              maxLength={REMOVE_PROMPT_LIMIT}
              value={promptValue}
              placeholder={REMOVE_BACKGROUND_DEFAULT_PROMPT}
              onChange={(event) => onChange({ removeBackgroundPrompt: event.target.value })}
            />
          </label>
          <p className="three-d-inputs__hint">
            Name the object in a word or two, for example “dragon” or “wooden chest”. Generic words
            such as “object” often find nothing and then the 3D render stops. Empty means “
            {REMOVE_BACKGROUND_DEFAULT_PROMPT}”, which works on many pictures but not all.
          </p>
        </div>
      )}
    </div>
  );
}
