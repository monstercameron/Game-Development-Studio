import { useEffect, useState } from 'react';
import './hy-motion-controls.css';

const SEED_MAX = 2147483647;

const clipControl = {
  key: 'motionDuration',
  id: 'hy-motion-duration',
  label: 'Clip length',
  min: 1,
  max: 12,
  step: 0.5,
  fallback: 3,
  help: '1–12 seconds, in 0.5-second steps. Blank uses 3 seconds.',
  invalid: 'Enter a length from 1 to 12 seconds in 0.5-second steps.',
};

const advancedControls = [
  {
    key: 'motionSteps',
    id: 'hy-motion-steps',
    label: 'Sampling steps',
    min: 1,
    max: 100,
    step: 1,
    fallback: 50,
    integer: true,
    help: '1–100 whole steps. More steps take longer. Blank uses 50.',
    invalid: 'Enter a whole number from 1 to 100.',
  },
  {
    key: 'motionGuidance',
    id: 'hy-motion-guidance',
    label: 'Prompt guidance',
    min: 0,
    max: 20,
    step: 0.5,
    fallback: 5,
    help: '0–20, in 0.5 steps. Higher values follow the prompt more strictly. Blank uses 5.',
    invalid: 'Enter a value from 0 to 20 in 0.5 steps.',
  },
  {
    key: 'seed',
    id: 'hy-motion-seed',
    label: 'Seed',
    min: 0,
    max: SEED_MAX,
    step: 1,
    fallback: '',
    integer: true,
    help: `Whole number from 0 to ${SEED_MAX}. Blank picks a new random seed for each queued clip.`,
    invalid: `Enter a whole number from 0 to ${SEED_MAX}, or leave blank for a random seed.`,
  },
  {
    key: 'motionVariations',
    id: 'hy-motion-variations',
    label: 'Variations',
    min: 1,
    max: 4,
    step: 1,
    fallback: 1,
    integer: true,
    help: '1–4 separate clips. They use consecutive seeds from the seed above, or random seeds when it is blank. Blank uses 1.',
    invalid: 'Enter a whole number from 1 to 4.',
  },
];

function isValidValue(value, { min, max, step, integer }) {
  if (value === '' || value === undefined || value === null) {
    return true;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    return false;
  }
  if (integer && !Number.isInteger(number)) {
    return false;
  }

  const stepCount = (number - min) / step;
  return Math.abs(stepCount - Math.round(stepCount)) < 1e-8;
}

function MotionField({ control, draft, onChange }) {
  const value = draft[control.key] ?? control.fallback;
  const isValid = isValidValue(value, control);
  const helpId = `${control.id}-help`;
  const errorId = `${control.id}-error`;

  return (
    <div className="hy-motion-control">
      <label className="field-label" htmlFor={control.id}>
        {control.label}
      </label>
      <input
        id={control.id}
        type="number"
        inputMode={control.integer ? 'numeric' : 'decimal'}
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        aria-invalid={isValid ? undefined : 'true'}
        aria-describedby={isValid ? helpId : `${helpId} ${errorId}`}
        onChange={(event) => onChange({ [control.key]: event.target.value })}
      />
      <small id={helpId}>{control.help}</small>
      {!isValid && (
        <small className="hy-motion-control-error" id={errorId}>
          {control.invalid}
        </small>
      )}
    </div>
  );
}

export default function HyMotionControls({ draft, onChange }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedInvalid = advancedControls.some(
    (control) => !isValidValue(draft[control.key] ?? control.fallback, control),
  );

  useEffect(() => {
    if (advancedInvalid) {
      setAdvancedOpen(true);
    }
  }, [advancedInvalid]);

  return (
    <section className="hy-motion-controls" aria-labelledby="hy-motion-controls-title">
      <h3 id="hy-motion-controls-title">Generation settings</h3>
      <div className="hy-motion-controls-primary">
        <MotionField control={clipControl} draft={draft} onChange={onChange} />
      </div>
      <details
        className="hy-motion-advanced"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>
          Advanced settings
          <span>Defaults: 50 steps, guidance 5, random seed</span>
        </summary>
        <div className="hy-motion-controls-grid">
          {advancedControls.map((control) => (
            <MotionField key={control.key} control={control} draft={draft} onChange={onChange} />
          ))}
        </div>
      </details>
      <p className="hy-motion-controls-note">
        Experimental on Windows ARM64. HY-Motion creates one human skeletal BVH clip at 30 fps.
        Longer clips and more steps take more time and memory. Character rigging and retargeting are
        separate.
      </p>
    </section>
  );
}
