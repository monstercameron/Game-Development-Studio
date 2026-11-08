import { useRouteToggle, routeDetails } from './useNav';
import './audio-settings.css';

// Only settings implemented by the connected local workers are exposed here.
export default function AudioSettings({ section, draft, update, sourcePicker = null }) {
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

  const choice = (id, label, options, { help } = {}) => (
    <label className="audio-setting" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      <select
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={help ? `${id}-help` : undefined}
        value={draft[id] ?? ''}
        onChange={(event) => update({ [id]: event.target.value })}
      >
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {help && <small id={`${id}-help`}>{help}</small>}
    </label>
  );

  const group = (title, description, children) => (
    <fieldset className="audio-setting-group">
      <legend>{title}</legend>
      <p>{description}</p>
      <div className="audio-setting-group-fields">{children}</div>
    </fieldset>
  );

  const customKeys = {
    music: [
      'musicDuration',
      'musicSteps',
      'musicGuidance',
      'musicTitle',
      'musicNegative',
      'musicScore',
      'musicTemperature',
      'musicTopP',
      'musicTopK',
      'musicRepetition',
      'seed',
    ],
    sfx: ['soundDuration', 'soundSteps', 'soundSourceId', 'seed'],
    voices: [
      'voiceMaxTokens',
      'voiceTemperature',
      'voiceTopP',
      'voiceTopK',
      'voiceRepetition',
      'voiceDoSample',
      'voiceSubDoSample',
      'voiceSubTemperature',
      'voiceSubTopP',
      'voiceSubTopK',
      'seed',
    ],
  }[section];
  const customCount = customKeys.filter((key) => String(draft[key] ?? '').trim() !== '').length;
  const planningOff = section === 'music' && draft.options?.[1] === 'Off';
  const seedField = field('seed', 'Seed', {
    min: 0,
    max: 2147483647,
    placeholder: 'Random',
    help: 'Blank picks a random seed and records it with the asset. Reuse a seed to repeat a render.',
  });
  const label = section === 'music' ? 'music' : section === 'sfx' ? 'sound' : 'voice';
  const description =
    section === 'music'
      ? 'Optional controls for the track length, generation, and metadata.'
      : section === 'sfx'
        ? 'Optional overrides for the selected duration and quality.'
        : 'Optional controls for speech length, variation, and repeating a take.';

  return (
    <details className="audio-settings" {...routeDetails(tuneOpen, setTuneOpen)}>
      <summary aria-expanded={tuneOpen} aria-controls="audio-settings-content">
        <span className="audio-settings-heading">Fine-tune {label}</span>
        <span className="audio-settings-hint">
          {tuneOpen
            ? 'Hide optional controls'
            : customCount
              ? `${customCount} custom ${customCount === 1 ? 'setting' : 'settings'} set`
              : 'Show optional controls'}
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
                    help: 'Replaces the Duration above. Target length; the model may finish earlier.',
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
                  {seedField}
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
              {group(
                'Melody score',
                'Optional. Give YuE2 your own melody as ABC notation instead of letting it write one.',
                <label className="audio-setting audio-setting-wide" htmlFor="musicScore">
                  <span>ABC score</span>
                  <textarea
                    id="musicScore"
                    className="audio-setting-score"
                    rows={4}
                    maxLength={20000}
                    spellCheck={false}
                    value={draft.musicScore || ''}
                    onChange={(event) => update({ musicScore: event.target.value })}
                    placeholder={'X:1\nM:4/4\nL:1/8\nQ:1/4=120\nK:C\n|: C2 E2 G2 c2 | ...'}
                    aria-invalid={
                      (planningOff && String(draft.musicScore || '').trim()) || undefined
                    }
                    aria-describedby="musicScore-help"
                  />
                  <small id="musicScore-help">
                    Needs Planning set to Full arrangement or Melody. YuE2 expects two melody voices
                    (Vocal and Ins) and does not check the notation, so malformed ABC gives
                    unpredictable music. Up to 20000 characters.
                  </small>
                  {planningOff && String(draft.musicScore || '').trim() && (
                    <small className="audio-setting-error" role="alert">
                      Planning is Off, so the score would be ignored. Change Planning above or clear
                      the score.
                    </small>
                  )}
                </label>,
              )}
              {group(
                'Song sampling',
                'Optional. Leave blank to use YuE2’s own defaults (shown as placeholders).',
                <>
                  {field('musicTemperature', 'Temperature', {
                    min: 0,
                    max: 5,
                    step: 0.05,
                    placeholder: '1',
                    help: 'Lower is steadier; higher is more adventurous.',
                  })}
                  {field('musicTopP', 'Top-p', {
                    min: 0.01,
                    max: 1,
                    step: 0.01,
                    placeholder: '0.95',
                    help: 'Keeps only the likeliest choices that add up to this share.',
                  })}
                  {field('musicTopK', 'Top-k', {
                    min: 1,
                    max: 1000,
                    placeholder: '100',
                    help: 'Limits each step to this many likeliest choices.',
                  })}
                  {field('musicRepetition', 'Repetition penalty', {
                    min: 1,
                    max: 2,
                    step: 0.05,
                    placeholder: '1.2',
                    help: 'Higher discourages loops and repeated phrases.',
                  })}
                </>,
              )}
              <p className="audio-settings-unavailable">
                To continue a finished track or re-render it with a new seed, open it in Recent
                creations or the asset library and choose Extend this track or Re-synthesize. Not
                available: reference-audio covers, stems or vocal separation, and output formats
                other than FLAC (use Convert in the asset library).
              </p>
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
                  help: 'Replaces the quality preset above. Range: 1 to 50. Medium is tuned for 8 steps, so more steps cost time without always sounding better.',
                })}
                {seedField}
              </>,
            )}
          {section === 'sfx' && sourcePicker}
          {section === 'sfx' && (
            <p className="audio-settings-unavailable">
              Not available: negative prompt and guidance (the post-trained Medium model ignores
              them) and looping. Sounds save as 44.1 kHz stereo WAV (use Convert in the asset
              library for other formats).
            </p>
          )}
          {section === 'voices' && (
            <>
              {group(
                'Speech length',
                'Set the maximum amount of speech the model can generate.',
                field('voiceMaxTokens', 'Speech token limit', {
                  min: 64,
                  max: 4096,
                  placeholder: '1024',
                  help: 'About 12.5 speech tokens per second (1024 is roughly 80 seconds). Speech that reaches the limit stops mid-sentence, so raise it for long dialogue; 64 to 4096.',
                }),
              )}
              {group(
                'Variation',
                'Optional. Leave blank to use Qwen3-TTS’s own defaults (shown as placeholders).',
                <>
                  {field('voiceTemperature', 'Temperature', {
                    min: 0.05,
                    max: 2,
                    step: 0.05,
                    placeholder: '0.9',
                    help: 'Lower is steadier and more even; higher is more expressive but can wander.',
                  })}
                  {field('voiceTopP', 'Top-p', {
                    min: 0.01,
                    max: 1,
                    step: 0.01,
                    placeholder: '1',
                    help: 'Keeps only the likeliest choices that add up to this share.',
                  })}
                  {field('voiceTopK', 'Top-k', {
                    min: 1,
                    max: 1000,
                    placeholder: '50',
                    help: 'Considers only this many likeliest choices at each step.',
                  })}
                  {field('voiceRepetition', 'Repetition penalty', {
                    min: 1,
                    max: 2,
                    step: 0.01,
                    placeholder: '1.05',
                    help: 'Higher discourages stuttering and repeated sounds.',
                  })}
                  {choice(
                    'voiceDoSample',
                    'Sampling mode',
                    [
                      ['', 'Model default (sampling)'],
                      ['on', 'Sample (varied takes)'],
                      ['off', 'Greedy (most predictable)'],
                    ],
                    {
                      help: 'Greedy always picks the likeliest speech token, so temperature, top-p and top-k have no effect and the seed matters less.',
                    },
                  )}
                  {seedField}
                </>,
              )}
              {group(
                'Fine detail (sub-talker)',
                'Optional. Each speech frame is built in two stages; these settings steer the second stage, which fills in fine acoustic detail. Leave blank for the model’s own defaults.',
                <>
                  {choice(
                    'voiceSubDoSample',
                    'Fine-detail sampling',
                    [
                      ['', 'Model default (sampling)'],
                      ['on', 'Sample'],
                      ['off', 'Greedy'],
                    ],
                    { help: 'Greedy makes the fine detail repeatable but flatter.' },
                  )}
                  {field('voiceSubTemperature', 'Fine-detail temperature', {
                    min: 0.05,
                    max: 2,
                    step: 0.05,
                    placeholder: '0.9',
                    help: 'Lower is cleaner; higher adds texture and occasional artefacts.',
                  })}
                  {field('voiceSubTopP', 'Fine-detail top-p', {
                    min: 0.01,
                    max: 1,
                    step: 0.01,
                    placeholder: '1',
                    help: 'Keeps only the likeliest fine-detail choices that add up to this share.',
                  })}
                  {field('voiceSubTopK', 'Fine-detail top-k', {
                    min: 1,
                    max: 1000,
                    placeholder: '50',
                    help: 'Considers only this many likeliest fine-detail choices.',
                  })}
                </>,
              )}
              <p className="audio-settings-unavailable">
                Voice cloning and voice design use the optional Base and VoiceDesign checkpoints,
                chosen on the Voices page; the Studio guide lists the optional downloads. Not
                available: streaming playback, separate speed or pitch controls (use Voice
                direction, e.g. &ldquo;speak slowly&rdquo;), and automatic splitting of long text
                (one render holds up to 1,000 characters). Speech saves as a 24 kHz mono WAV; use
                Convert in the asset library for other formats.
              </p>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
