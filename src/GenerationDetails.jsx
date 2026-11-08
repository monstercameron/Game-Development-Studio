import { useEffect, useId, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import {
  describeSettings,
  describeSource,
  formatSeconds,
  modelLabel,
  negativeLabel,
  reusePlan,
  secondaryLabel,
} from './generation-details';
import { createLog } from './app-log.js';
import './ux-metadata.css';

const log = createLog('ui');
// Characters shown before a long prompt is clamped behind a "Show more" button.
const PROMPT_PREVIEW = 280;
const formatDateTime = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';

// Loads one asset's generation details. A failed load is reported separately from
// "nothing was recorded" so the empty state is never shown for a service error.
export function useGenerationDetails(projectId, assetId) {
  const [state, setState] = useState({ key: '', status: 'loading', metadata: null });
  const key = projectId && assetId ? `${projectId}\n${assetId}` : '';
  useEffect(() => {
    if (!key) {
      return undefined;
    }
    const controller = new AbortController();
    fetch(
      `/api/projects/${encodeURIComponent(projectId)}/assets/details?path=${encodeURIComponent(assetId)}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw Error(body.error || 'Could not load generation details.');
        }
        log.debug('ui.generation.loaded', { isUnavailable: body.unavailable === true });
        setState({
          key,
          status: body.unavailable ? 'error' : 'ready',
          metadata: body.metadata || null,
        });
      })
      .catch((error) => {
        if (error.name !== 'AbortError') {
          log.warn('ui.generation.failed', { errorClass: error?.name });
          setState({ key, status: 'error', metadata: null });
        } else {
          log.debug('ui.generation.cancelled');
        }
      });
    return () => controller.abort();
  }, [key, projectId, assetId]);
  return state.key === key ? state : { key, status: 'loading', metadata: null };
}

function Prompt({ label, value, id }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > PROMPT_PREVIEW;
  return (
    <div className="generation-block">
      <span className="generation-label" id={`${id}-label`}>
        {label}
      </span>
      <p id={id} className="generation-text" aria-labelledby={`${id}-label`}>
        {isLong && !expanded ? `${value.slice(0, PROMPT_PREVIEW).trimEnd()}…` : value}
      </p>
      {isLong && (
        <button
          type="button"
          className="generation-link"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// What each creation page is called in the sidebar.
const pageNames = {
  images: 'Images',
  video: 'Video',
  music: 'Music',
  sfx: 'Sound effects',
  voices: 'Voices',
  '3d': '3D models',
  motion: 'Motion',
  segmentation: 'Segmentation',
  world: 'Worlds',
};

export default function GenerationDetails({ project, asset, onReuse, compact = false }) {
  const id = useId();
  const state = useGenerationDetails(asset?.sample ? '' : project?.id, asset?.id);
  const [copied, setCopied] = useState('');
  // A different asset must not show the previous copy confirmation.
  useEffect(() => setCopied(''), [asset?.id]);
  if (!project || !asset || asset.sample) {
    return null;
  }
  const meta = state.metadata;
  const plan = meta ? reusePlan(meta) : null;
  const settings = meta ? describeSettings(meta) : [];
  const references = meta?.references || [];
  const model = modelLabel(meta);
  const took = formatSeconds(meta?.timing?.seconds);
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(meta.prompt.text);
      setCopied('Prompt copied.');
    } catch (error) {
      log.warn('ui.clipboard.failed', { errorClass: error?.name });
      setCopied('Clipboard unavailable. Select the prompt and copy it manually.');
    }
  }
  return (
    <section
      className={'generation-details' + (compact ? ' is-compact' : '')}
      aria-labelledby={`${id}-heading`}
    >
      <h3 id={`${id}-heading`} className="generation-heading">
        Generation details
      </h3>
      {state.status === 'loading' ? (
        <p className="generation-empty" role="status">
          Loading generation details…
        </p>
      ) : state.status === 'error' ? (
        <p className="generation-empty" role="status">
          Generation details are unavailable right now.
        </p>
      ) : !meta ? (
        <p className="generation-empty">No generation details recorded for this file.</p>
      ) : (
        <>
          <dl className="generation-facts">
            {(asset.name || asset.title) && (
              <div>
                <dt>File name</dt>
                <dd className="generation-file-name">{asset.name || asset.title}</dd>
              </div>
            )}
            {model && (
              <div>
                <dt>Model</dt>
                <dd>
                  {model}
                  {meta.model?.version && meta.model.version !== model ? (
                    <small> · {meta.model.version}</small>
                  ) : null}
                </dd>
              </div>
            )}
            <div>
              <dt>Origin</dt>
              <dd>{describeSource(meta)}</dd>
            </div>
            {meta.asset?.createdAt && (
              <div>
                <dt>Created</dt>
                <dd>{formatDateTime(meta.asset.createdAt)}</dd>
              </div>
            )}
            {took && (
              <div>
                <dt>Render time</dt>
                <dd>{took}</dd>
              </div>
            )}
            {meta.output && (
              <>
                <div>
                  <dt>Triangles</dt>
                  <dd>{meta.output.triangles.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Vertices</dt>
                  <dd>{meta.output.vertices.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>Textures</dt>
                  <dd>
                    {meta.output.textures
                      ? `${meta.output.textures} map${meta.output.textures === 1 ? '' : 's'}`
                      : 'None'}
                  </dd>
                </div>
                <div>
                  <dt>File size</dt>
                  <dd>
                    {(meta.output.bytes / 1048576).toFixed(meta.output.bytes < 1048576 ? 2 : 1)} MiB
                  </dd>
                </div>
              </>
            )}
          </dl>
          {meta.prompt?.text ? (
            <>
              <Prompt label="Prompt" value={meta.prompt.text} id={`${id}-prompt`} />
              <div className="generation-actions">
                <button type="button" className="outline-button" onClick={copyPrompt}>
                  {copied === 'Prompt copied.' ? <Check size={15} /> : <Copy size={15} />} Copy
                  prompt
                </button>
              </div>
            </>
          ) : (
            <p className="generation-empty">This type of render does not use a text prompt.</p>
          )}
          {meta.prompt?.negative && (
            <Prompt
              label={negativeLabel(meta)}
              value={meta.prompt.negative}
              id={`${id}-negative`}
            />
          )}
          {meta.prompt?.secondary && (
            <Prompt
              label={secondaryLabel(meta)}
              value={meta.prompt.secondary}
              id={`${id}-secondary`}
            />
          )}
          {meta.prompt?.title && (
            <div className="generation-block">
              <span className="generation-label">Title</span>
              <p className="generation-text">{meta.prompt.title}</p>
            </div>
          )}
          {settings.length > 0 && (
            <dl className="generation-settings" aria-label="Settings">
              {settings.map((item) => (
                <div key={item.key}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {references.length > 0 && (
            <div className="generation-block">
              <span className="generation-label">References</span>
              <ul className="generation-references">
                {references.map((reference, index) => (
                  <li key={`${reference.id || reference.path || reference.name}-${index}`}>
                    {reference.path || reference.name || reference.id}
                    {reference.size ? (
                      <small> · {Math.ceil(reference.size / 1024)} KB</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {meta.job?.id && (
            <p className="generation-job">
              Render {meta.job.id}
              {meta.backfilled ? ' · recovered from render history' : ''}
            </p>
          )}
          {onReuse && plan && (
            <div className="generation-reuse">
              <button type="button" className="outline-button" onClick={() => onReuse(meta)}>
                <RotateCcw size={15} /> Reuse settings
              </button>
              <p>
                Opens the {pageNames[plan.section] || plan.section} page with these settings filled
                in.
                {references.length > 0 || ['segmentation', '3d'].includes(plan.section)
                  ? ' Reference files are not attached automatically; choose them again.'
                  : ''}
              </p>
            </div>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {copied}
          </p>
          {copied && copied !== 'Prompt copied.' && <p className="generation-job">{copied}</p>}
        </>
      )}
    </section>
  );
}
