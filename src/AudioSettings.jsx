import { useRouteToggle, routeDetails } from './useNav';
import './audio-settings.css';

// Only settings implemented by the connected local workers are exposed here.
export default function AudioSettings({ section, draft, update }) {
  const [tuneOpen, setTuneOpen] = useRouteToggle('tune');
  if (!['music', 'sfx', 'voices'].includes(section)) {
    return null;
  }

  const field = (id, label, { min, max, step = 1, placeholder, help, integer = step === 1 }) => {
    const value = draft[id] ?? '';
    const number = value === '' ? null : Number(value);
    const invalid =
      number !== null &&
      (!Number.isFinite(number) ||
        number < min ||
        number > max ||
        (integer && !Number.isSafeInteger(number)));
    const describedBy = [help && `${id}-help`, invalid && `${id}-error`].filter(Boolean).join(' ');
    return (
      <label className="audio-setting" htmlFor={id}>
        <span id={`${id}-label`}>{label}</span>
        <input
          id={id}
          aria-labelledby={`${id}-label`}
          type="number"
          min={min}
          max={max}
          step={step}
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => update({ [id]: event.target.value })}
        />
        {help && <small id={`${id}-help`}>{help}</small>}
        {invalid && (
          <small className="audio-setting-error" id={`${id}-error`} role="alert">
            Enter {integer ? 'a whole number' : 'a number'} from {min} to {max}.
          </small>
        )}
      </label>
    );
  };

  const group = (title, description, children) => (
    <fieldset className="audio-setting-group">
      <legend>{title}</legend>
      <p>{description}</p>
      <div className="audio-setting-group-fields">{children}</div>
    </fieldset>
  );

  const label = section === 'music' ? 'music' : section === 'sfx' ? 'sound' : 'voice';
  const description =
    section === 'music'
      ? 'Optional controls for the track length, generation, and metadata.'
      : section === 'sfx'
        ? 'Optional overrides for the selected duration and quality.'
        : 'Optional limit for how much speech the model can produce.';

  return (
    <details className="audio-settings" {...routeDetails(tuneOpen, setTuneOpen)}>
      <summary aria-expanded={tuneOpen} aria-controls="audio-settings-content">
        <span className="audio-settings-heading">Fine-tune {label}</span>
        <span className="audio-settings-hint">
          {tuneOpen ? 'Hide optional controls' : 'Show optional controls'}
        </span>
      </summary>
      <div className="audio-settings-content" id="audio-settings-content">
        <p className="audio-settings-intro">{description}</p>
        <div className="audio-settings-grid">
          {section === 'music' && (
            <>
              {group(
                'Generation',
                'Set a target length and how closely generation follows your prompt.',
                <>
                  {field('musicDuration', 'Duration in seconds', {
                    min: 1,
                    max: 600,
                    step: 0.1,
                    placeholder: 'Use preset',
                    help: 'Target length; the model may finish earlier.',
                  })}
                  {field('musicSteps', 'Synthesis steps', {
                    min: 1,
                    max: 100,
                    placeholder: '32',
                    help: 'More steps can take longer.',
                  })}
                  {field('musicGuidance', 'Guidance scale', {
                    min: 0,
                    max: 20,
                    step: 0.1,
                    placeholder: 'Automatic',
                    help: 'Automatic by default. A value of 1 turns off Style to avoid.',
                  })}
                </>,
              )}
              {group(
                'Track details',
                'Add a title or describe styles and sounds to avoid.',
                <>
                  <label className="audio-setting" htmlFor="musicTitle">
                    <span>Track title</span>
                    <input
                      id="musicTitle"
                      maxLength={200}
                      value={draft.musicTitle || ''}
                      onChange={(event) => update({ musicTitle: event.target.value })}
                      placeholder="Optional"
                    />
                  </label>
                  <label className="audio-setting audio-setting-wide" htmlFor="musicNegative">
                    <span>Style to avoid</span>
                    <textarea
                      id="musicNegative"
                      rows={2}
                      maxLength={2000}
                      value={draft.musicNegative || ''}
                      onChange={(event) => update({ musicNegative: event.target.value })}
                      placeholder="Optional instruments or styles to steer away from"
                      aria-describedby="musicNegative-help"
                    />
                    <small id="musicNegative-help">
                      Applies only when Guidance scale is not 1.
                    </small>
                  </label>
                </>,
              )}
            </>
          )}
          {section === 'sfx' &&
            group(
              'Generation',
              'Custom values replace the matching preset above.',
              <>
                {field('soundDuration', 'Duration in seconds', {
                  min: 1,
                  max: 380,
                  step: 0.1,
                  placeholder: 'Use preset',
                  help: 'Replaces the duration above. Range: 1 to 380 seconds.',
                })}
                {field('soundSteps', 'Generation steps', {
                  min: 1,
                  max: 50,
                  placeholder: 'Use preset',
                  help: 'Replaces the quality preset above. Range: 1 to 50.',
                })}
              </>,
            )}
          {section === 'voices' &&
            group(
              'Speech length',
              'Set the maximum amount of speech the model can generate.',
              field('voiceMaxTokens', 'Speech token limit', {
                min: 64,
                max: 2048,
                placeholder: '1024',
                help: 'Counted in speech tokens (64 to 2048), not seconds or characters. A higher limit can allow longer speech but takes more time.',
              }),
            )}
        </div>
      </div>
    </details>
  );
}
