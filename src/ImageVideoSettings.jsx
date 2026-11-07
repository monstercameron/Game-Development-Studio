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
  return (
    <details className="image-video-settings" {...routeDetails(tuneOpen, setTuneOpen)}>
      <summary>{image ? 'Fine-tune image' : 'Video quality'}</summary>
      {image ? (
        <div className="image-video-settings-body">
          <p>Leave a field blank to use the selected aspect ratio or quality.</p>
          <div className="image-video-settings-grid">
            <label>
              <span className="field-label">Width in pixels</span>
              <input
                type="number"
                inputMode="numeric"
                min="32"
                max="2048"
                step="32"
                placeholder={String(width)}
                value={draft.imageWidth ?? ''}
                onChange={(e) => update({ imageWidth: e.target.value })}
              />
            </label>
            <label>
              <span className="field-label">Height in pixels</span>
              <input
                type="number"
                inputMode="numeric"
                min="32"
                max="2048"
                step="32"
                placeholder={String(height)}
                value={draft.imageHeight ?? ''}
                onChange={(e) => update({ imageHeight: e.target.value })}
              />
            </label>
            <label>
              <span className="field-label">Sampling steps</span>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                placeholder={String(steps)}
                value={draft.imageSteps ?? ''}
                onChange={(e) => update({ imageSteps: e.target.value })}
              />
            </label>
          </div>
          <p>Dimensions must be multiples of 32. More steps usually take longer.</p>
          <label>
            <span className="field-label">
              Negative prompt <span>OPTIONAL</span>
            </span>
            <textarea
              className="short-text"
              maxLength={4000}
              value={draft.imageNegativePrompt ?? ''}
              onChange={(e) => update({ imageNegativePrompt: e.target.value })}
              placeholder="Describe what to avoid"
            />
          </label>
          {draft.imageNegativePrompt?.trim() && (
            <>
              <label>
                <span className="field-label">Negative prompt guidance</span>
                <input
                  type="number"
                  min="1.1"
                  max="10"
                  step="0.1"
                  placeholder="2"
                  value={draft.imageGuidance ?? ''}
                  onChange={(e) => update({ imageGuidance: e.target.value })}
                />
              </label>
              <p>
                Guidance above 1 activates the negative prompt and increases render time. Qwen
                normally runs without guidance.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="image-video-settings-body">
          <label>
            <span className="field-label">Sampling steps</span>
            <select
              value={draft.videoSteps || 12}
              onChange={(e) => update({ videoSteps: Number(e.target.value) })}
            >
              <option value={8}>8 · faster</option>
              <option value={12}>12 · balanced</option>
              <option value={20}>20 · detailed</option>
              <option value={30}>30 · highest</option>
            </select>
          </label>
          <p>
            More steps take longer. H3 renders at {videoSizes[draft.options?.[0]] || '608 × 352'}{' '}
            pixels and 24 frames per second. Its current service does not expose a seed.
          </p>
        </div>
      )}
    </details>
  );
}
