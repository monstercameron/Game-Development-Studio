import './hy-motion-controls.css';

const controls = [
  {
    key: 'motionDuration',
    id: 'hy-motion-duration',
    label: 'Clip length',
    min: 1,
    max: 12,
    step: 0.5,
    fallback: 3,
    help: '1–12 seconds, in 0.5-second steps. Blank uses 3 seconds.',
    invalid: 'Enter a length from 1 to 12 seconds in 0.5-second steps.',
  },
  {
    key: 'motionSteps',
    id: 'hy-motion-steps',
    label: 'Sampling steps',
    min: 1,
    max: 100,
    step: 1,
    fallback: 50,
    integer: true,
    help: '1–100 whole steps. More steps can take longer. Blank uses 50.',
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
    help: '0–20, in 0.5 steps. Higher values can constrain motion more strongly. Blank uses 5.',
    invalid: 'Enter a value from 0 to 20 in 0.5 steps.',
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

export default function HyMotionControls({ draft, onChange }) {
  return (
    <section className="hy-motion-controls" aria-labelledby="hy-motion-controls-title">
      <h3 id="hy-motion-controls-title">Generation settings</h3>
      <div className="hy-motion-controls-grid">
        {controls.map((control) => {
          const value = draft[control.key] ?? control.fallback;
          const isValid = isValidValue(value, control);
          const helpId = `${control.id}-help`;
          const errorId = `${control.id}-error`;

          return (
            <label className="hy-motion-control" htmlFor={control.id} key={control.key}>
              <span className="field-label">{control.label}</span>
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
            </label>
          );
        })}
      </div>
      <p className="hy-motion-controls-note">
        Experimental on Windows ARM64. HY-Motion creates one human skeletal BVH clip at 30 fps.
        Longer clips and more steps take more time and memory. Character rigging and retargeting are
        separate.
      </p>
    </section>
  );
}
