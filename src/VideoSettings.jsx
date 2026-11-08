import {
  DEFAULT_VIDEO_MAX_VRAM_GIB,
  REFERENCE_CLIP_MAX_VRAM_GIB,
  REFERENCE_DETAILS,
  VIDEO_RESOLUTIONS,
  VIDEO_SAMPLERS,
  VIDEO_SCHEDULERS,
  videoDimensions,
  videoWarnings,
} from '../runtime/video-options.js';
import { videoAspectId, videoChangedLabels, videoFramesFor } from './imageVideoInputs';

// Re-exported so the settings panel can name what was changed while it is closed.
export { videoChangedLabels };

const hasText = (value) => value !== undefined && value !== null && String(value) !== '';
// Returns the inline error for a field, or '' when the value is blank or in range.
const rangeError = (value, min, max, isWholeNumber) => {
  if (!hasText(value)) {
    return '';
  }
  const number = Number(value);
  return Number.isFinite(number) &&
    number >= min &&
    number <= max &&
    (!isWholeNumber || Number.isInteger(number))
    ? ''
    : `Enter ${isWholeNumber ? 'a whole number' : 'a number'} from ${min} to ${max}.`;
};

/**
 * Video controls inside the image/video settings panel.
 * `draft` holds the panel's unsaved settings and `update(changes)` merges changed keys into it.
 * `contentId` is the id given to the panel body. Invalid numbers show an inline error and are
 * still written to the draft as typed.
 */
export default function VideoSettings({ draft, update, contentId }) {
  const aspect = videoAspectId(draft.options?.[0]);
  const resolution = draft.videoResolution || 'standard';
  const turbo = draft.videoTurbo === true;
  const seedError = hasText(draft.seed) ? rangeError(draft.seed, 0, 2147483647, true) : '';
  const cfgError = hasText(draft.videoCfg)
    ? Number(draft.videoCfg) === 1
      ? ''
      : rangeError(draft.videoCfg, 1.1, 6, false)
    : '';
  const vramError = rangeError(draft.videoMaxVram, 4, 24, true);
  // Reference clips need more GPU memory than the engine's usual budget (see video-options.js).
  const hasReferenceClips =
    (draft.videoSource || 'references') === 'references' && (draft.videoClips?.length || 0) > 0;
  const automaticVram = hasReferenceClips
    ? REFERENCE_CLIP_MAX_VRAM_GIB
    : DEFAULT_VIDEO_MAX_VRAM_GIB;
  const warnings = videoWarnings({
    aspect,
    resolution,
    frames: videoFramesFor(draft.options?.[1]),
    cfg_scale: Number(draft.videoCfg) || (draft.videoNegative?.trim() ? 2 : 1),
    reference_detail: draft.videoRefDetail,
  });
  const size = (id) => videoDimensions(aspect, id).join(' × ');
  return (
    <div className="image-video-settings-body" id={contentId}>
      <p className="image-video-settings-intro">
        Optional. More steps can improve detail and increase render time. Reuse a seed with the same
        settings to try to repeat a result. The defaults are the combination tested on this PC.
      </p>
      <div className="image-video-settings-grid">
        <label className="image-video-settings-video-field" htmlFor="video-resolution">
          <span className="field-label">Picture size</span>
          <select
            id="video-resolution"
            aria-describedby="video-resolution-help"
            value={resolution}
            onChange={(e) => update({ videoResolution: e.target.value })}
          >
            {Object.entries(VIDEO_RESOLUTIONS).map(([id, { short }]) => (
              <option key={id} value={id}>
                {`${short} · ${size(id)}`}
              </option>
            ))}
          </select>
          <small id="video-resolution-help">
            Standard is the size tested here. Bigger pictures look sharper but take much longer and
            need more memory.
          </small>
        </label>
        <label className="image-video-settings-video-field" htmlFor="video-steps">
          <span className="field-label">Sampling steps</span>
          <select
            id="video-steps"
            aria-describedby="video-steps-help"
            value={draft.videoSteps || (turbo ? 4 : 12)}
            onChange={(e) => update({ videoSteps: Number(e.target.value) })}
          >
            {turbo && <option value={4}>4 · turbo</option>}
            {turbo && <option value={8}>8 · turbo, more detail</option>}
            {!turbo && <option value={8}>8 · faster</option>}
            {!turbo && <option value={12}>12 · balanced</option>}
            {!turbo && <option value={20}>20 · detailed</option>}
            {!turbo && <option value={30}>30 · highest</option>}
          </select>
          <small id="video-steps-help">
            Default: {turbo ? '4 steps with the turbo adapter' : '12 steps'}. Higher settings
            usually take longer.
          </small>
        </label>
        <label htmlFor="video-seed">
          <span className="field-label">
            Seed <span className="image-video-optional">Optional</span>
          </span>
          <input
            id="video-seed"
            type="number"
            inputMode="numeric"
            min="0"
            max="2147483647"
            step="1"
            placeholder="Random"
            aria-describedby={`video-seed-help${seedError ? ' video-seed-error' : ''}`}
            aria-invalid={seedError ? 'true' : undefined}
            value={draft.seed ?? ''}
            onChange={(e) => update({ seed: e.target.value })}
          />
          <small id="video-seed-help">
            Whole number from 0 to 2147483647. Blank picks a random seed and records it with the
            video.
          </small>
          {seedError && (
            <small id="video-seed-error" className="image-video-settings-error" role="alert">
              Enter a whole number from 0 to 2147483647.
            </small>
          )}
        </label>
      </div>
      <div className="image-video-settings-toggles">
        <label className="image-video-settings-check" htmlFor="video-turbo">
          <input
            id="video-turbo"
            type="checkbox"
            aria-describedby="video-turbo-help"
            checked={turbo}
            onChange={(e) =>
              update({ videoTurbo: e.target.checked, videoSteps: e.target.checked ? 4 : 12 })
            }
          />
          <span>
            <span className="field-label">Turbo adapter (experimental)</span>
            <small id="video-turbo-help">
              MiniMax&rsquo;s 4-step speed adapter (1.8 GB, already installed). Renders in 4 steps
              instead of 12 or more, with some loss of detail. Loaded on top of the model for this
              render only.
            </small>
          </span>
        </label>
        <label className="image-video-settings-check" htmlFor="video-also-mp4">
          <input
            id="video-also-mp4"
            type="checkbox"
            aria-describedby="video-also-mp4-help"
            checked={draft.videoAlsoMp4 === true}
            onChange={(e) => update({ videoAlsoMp4: e.target.checked })}
          />
          <span>
            <span className="field-label">Also save an MP4 (H.264)</span>
            <small id="video-also-mp4-help">
              WebM (VP8) is poorly supported by game engines and editors. This also saves an MP4
              with AAC sound beside it, kept as a converted copy of the WebM. You can convert any
              video later from its Convert menu.
            </small>
          </span>
        </label>
      </div>
      {warnings.length > 0 && (
        <p className="image-video-settings-warning" role="status">
          {warnings.join(' ')}
        </p>
      )}
      <details className="image-video-settings-advanced">
        <summary>Experimental sampling controls</summary>
        <p className="image-video-settings-intro">
          H3 is trained to run unguided with a fixed sampler. These are passed to the engine as
          given and have not been tuned for this model; leave them blank unless you want to
          experiment.
        </p>
        <div className="image-video-settings-grid">
          <label className="image-video-settings-wide" htmlFor="video-negative">
            <span className="field-label">
              Negative prompt <span className="image-video-optional">Optional</span>
            </span>
            <textarea
              id="video-negative"
              className="short-text"
              maxLength={4000}
              aria-describedby="video-negative-help"
              value={draft.videoNegative ?? ''}
              onChange={(e) => update({ videoNegative: e.target.value })}
              placeholder="Describe what to avoid"
              disabled={turbo}
            />
            <small id="video-negative-help">
              Turns guidance on (2 unless you set it below), which runs the model twice per step.
              MiniMax&rsquo;s own workflow uses no negative prompt, so results can look worse.
              {turbo ? ' Not available with the turbo adapter.' : ''}
            </small>
          </label>
          <label htmlFor="video-cfg">
            <span className="field-label">Guidance</span>
            <input
              id="video-cfg"
              type="number"
              min="1"
              max="6"
              step="0.1"
              placeholder="1 (off)"
              disabled={turbo}
              aria-describedby={`video-cfg-help${cfgError ? ' video-cfg-error' : ''}`}
              aria-invalid={cfgError ? 'true' : undefined}
              value={draft.videoCfg ?? ''}
              onChange={(e) => update({ videoCfg: e.target.value })}
            />
            <small id="video-cfg-help">
              1 (off, default) or 1.1 to 6. Above 1 takes about twice as long.
            </small>
            {cfgError && (
              <small id="video-cfg-error" className="image-video-settings-error" role="alert">
                {cfgError}
              </small>
            )}
          </label>
          <label htmlFor="video-sampler">
            <span className="field-label">Sampler</span>
            <select
              id="video-sampler"
              aria-describedby="video-sampler-help"
              value={draft.videoSampler || ''}
              onChange={(e) => update({ videoSampler: e.target.value })}
            >
              <option value="">Engine default</option>
              {VIDEO_SAMPLERS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <small id="video-sampler-help">MiniMax&rsquo;s workflow uses res_multistep.</small>
          </label>
          <label htmlFor="video-scheduler">
            <span className="field-label">Scheduler</span>
            <select
              id="video-scheduler"
              aria-describedby="video-scheduler-help"
              value={draft.videoScheduler || ''}
              onChange={(e) => update({ videoScheduler: e.target.value })}
            >
              <option value="">Engine default</option>
              {VIDEO_SCHEDULERS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <small id="video-scheduler-help">
              MiniMax suggests beta or normal (discrete) over simple.
            </small>
          </label>
          <label htmlFor="video-max-vram">
            <span className="field-label">GPU memory budget (GiB)</span>
            <input
              id="video-max-vram"
              type="number"
              min="4"
              max="24"
              step="1"
              placeholder={String(automaticVram)}
              aria-describedby={`video-max-vram-help${vramError ? ' video-max-vram-error' : ''}`}
              aria-invalid={vramError ? 'true' : undefined}
              value={draft.videoMaxVram ?? ''}
              onChange={(e) => update({ videoMaxVram: e.target.value })}
            />
            <small id="video-max-vram-help">
              4–24. How much GPU memory the engine may keep model weights in. Blank uses{' '}
              {automaticVram}
              {hasReferenceClips
                ? ` because this video has reference clips (${DEFAULT_VIDEO_MAX_VRAM_GIB} without them)`
                : ` (${REFERENCE_CLIP_MAX_VRAM_GIB} when the video has reference clips)`}
              . More can be faster but competes with other models.
            </small>
            {vramError && (
              <small id="video-max-vram-error" className="image-video-settings-error" role="alert">
                {vramError}
              </small>
            )}
          </label>
          <label htmlFor="video-ref-detail">
            <span className="field-label">Reference detail</span>
            <select
              id="video-ref-detail"
              aria-describedby="video-ref-detail-help"
              value={draft.videoRefDetail || ''}
              onChange={(e) => update({ videoRefDetail: e.target.value })}
            >
              <option value="">Engine default</option>
              {REFERENCE_DETAILS.map((id) => (
                <option key={id} value={id}>
                  {id === 'max' ? 'max · full size, slower' : 'match · scaled to the video'}
                </option>
              ))}
            </select>
            <small id="video-ref-detail-help">
              Full size keeps more of a character&rsquo;s identity but is much heavier.
            </small>
          </label>
        </div>
      </details>
      <p className="image-video-settings-facts">
        H3 renders at {size(resolution)} pixels and 24 frames per second (fixed by the engine), and
        the WebM includes generated stereo sound that you can steer in the scene description. Clips
        can be up to about 15 seconds, in 17 × n + 5 frame steps. Rendering is deliberately slow and
        disk-streamed, so keep other programs closed during long or large renders.
      </p>
    </div>
  );
}
