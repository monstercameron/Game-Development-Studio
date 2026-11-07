import { useRouteToggle, routeDetails } from './useNav';
import './audio-settings.css';

// Only settings implemented by the connected local workers are exposed here.
export default function AudioSettings({ section, draft, update }) {
  const [tuneOpen, setTuneOpen] = useRouteToggle('tune');
  if (!['music', 'sfx', 'voices'].includes(section)) {
    return null;
  }
  const field = (id, label, { min, max, step = 1, placeholder, help }) => (
    <label className="audio-setting" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode="decimal"
        value={draft[id] ?? ''}
        placeholder={placeholder}
        onChange={(event) => update({ [id]: event.target.value })}
      />
      {help && <small>{help}</small>}
    </label>
  );
  return (
    <details className="audio-settings" {...routeDetails(tuneOpen, setTuneOpen)}>
      <summary>
        Fine-tune {section === 'music' ? 'music' : section === 'sfx' ? 'sound' : 'voice'}
      </summary>
      <div className="audio-settings-grid">
        {section === 'music' && (
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
              help: 'Negative style takes effect when guidance is not 1.',
            })}
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
              />
            </label>
          </>
        )}
        {section === 'sfx' && (
          <>
            {field('soundDuration', 'Duration in seconds', {
              min: 1,
              max: 380,
              step: 0.1,
              placeholder: 'Use preset',
              help: 'Custom duration overrides the preset above.',
            })}
            {field('soundSteps', 'Generation steps', {
              min: 1,
              max: 50,
              placeholder: 'Use preset',
              help: 'Custom steps override the quality preset above.',
            })}
          </>
        )}
        {section === 'voices' &&
          field('voiceMaxTokens', 'Speech token limit', {
            min: 64,
            max: 2048,
            placeholder: '1024',
            help: 'A higher limit can allow longer speech, but may take more time.',
          })}
      </div>
    </details>
  );
}
