import { useT } from './i18n/index.js';
import './drama3-controls.css';

/** Controls that the native Drama 3 engine accepts, without Qwen-specific voice settings. */
export default function Drama3Controls({ draft, update }) {
  const { t } = useT();
  const fields = [
    {
      key: 'dramaMaxTokens',
      label: t('voices.drama3.maxTokens', 'Maximum audio tokens'),
      help: t(
        'voices.drama3.maxTokensHelp',
        'Limits the generated audio frames. Increase it if a take ends early.',
      ),
      min: 1,
      max: 2048,
      step: 1,
      placeholder: '500',
    },
    {
      key: 'dramaTemperature',
      label: t('voices.drama3.temperature', 'Temperature'),
      help: t(
        'voices.drama3.temperatureHelp',
        'Higher values make delivery more varied; zero is more predictable.',
      ),
      min: 0,
      max: 2,
      step: 0.05,
      placeholder: '1.0',
    },
    {
      key: 'dramaTopP',
      label: t('voices.drama3.topP', 'Top-p'),
      help: t(
        'voices.drama3.topPHelp',
        'Limits the range of choices at each step. Lower values make results less varied.',
      ),
      min: 0.01,
      max: 1,
      step: 0.01,
      placeholder: '0.9',
    },
    {
      key: 'dramaSeed',
      label: t('voices.drama3.seed', 'Seed'),
      help: t(
        'voices.drama3.seedHelp',
        'Leave blank for a new seed; reuse a seed to repeat the same settings.',
      ),
      min: 0,
      max: 2147483647,
      step: 1,
      placeholder: t('voices.drama3.random', 'Random'),
    },
  ];
  return (
    <section className="drama3-controls" aria-labelledby="drama3-controls-title">
      <div>
        <h3 id="drama3-controls-title">{t('voices.drama3.title', 'Shape the performance')}</h3>
        <p>
          {t(
            'voices.drama3.intro',
            'Use directions like [whisper] or [laughs] in the dialogue. The model generates a new voice for the take.',
          )}
        </p>
      </div>
      <p className="drama3-license">
        {t(
          'voices.drama3.experimental',
          'Experimental: a short CUDA render succeeded; speed and memory needs vary. Forge stops the render if Windows-available memory falls too low. Restart Forge after updating to activate this model.',
        )}
      </p>
      <div className="drama3-fields">
        {fields.map((field) => (
          <label key={field.key} htmlFor={field.key}>
            <span>{field.label}</span>
            <input
              id={field.key}
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              placeholder={field.placeholder}
              value={draft[field.key] ?? ''}
              onChange={(event) => update({ [field.key]: event.target.value })}
              aria-describedby={`${field.key}-help`}
            />
            <small id={`${field.key}-help`}>{field.help}</small>
          </label>
        ))}
      </div>
      <p className="drama3-license">
        {t(
          'voices.drama3.license',
          'Drama 3 uses the Fish Audio Community License. Commercial use and hosted services have separate conditions.',
        )}
      </p>
    </section>
  );
}
