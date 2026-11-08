import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Github } from 'lucide-react';
import { createLog } from './app-log.js';
import { postErrors } from './errors-api.js';

const log = createLog('errors');

/**
 * GitHub issue for a fix the user confirmed. The preview shows exactly what will be published,
 * and Create or Comment must be pressed every time; it runs through the user's own `gh` login.
 */
export default function ErrorIssuePanel({ error, onUpdated, onStatus }) {
  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [failure, setFailure] = useState('');
  const heading = useRef(null);

  useEffect(() => {
    setPreview(null);
    setPhase('idle');
    setFailure('');
  }, [error.id, error.status]);

  useEffect(() => {
    if (phase === 'preview') {
      heading.current?.focus();
    }
  }, [phase]);

  async function loadPreview() {
    setFailure('');
    setPhase('loading');
    try {
      const previewResult = await postErrors(`/${error.id}/issue-preview`);
      setPreview(previewResult);
      log.info('errors.issue.previewed', {
        errorId: error.id,
        isAvailable: previewResult.available,
        duplicateCount: previewResult.duplicates?.length,
      });
      setPhase('preview');
    } catch (reason) {
      log.warn('errors.issue.preview.failed', {
        errorId: error.id,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setFailure(reason.message);
      setPhase('idle');
    }
  }

  async function publish(mode, issueNumber) {
    setPhase('posting');
    setFailure('');
    try {
      const publishResult = await postErrors(`/${error.id}/issue`, {
        digest: preview.digest,
        mode,
        ...(issueNumber ? { number: issueNumber } : {}),
      });
      onUpdated(publishResult.error);
      log.info('errors.issue.posted', { errorId: error.id, mode });
      setPreview(null);
      setPhase('idle');
      onStatus(
        mode === 'comment'
          ? `Comment added to issue #${publishResult.issue.number}.`
          : `GitHub issue #${publishResult.issue.number} created.`,
      );
    } catch (reason) {
      log.warn('errors.issue.post.failed', {
        errorId: error.id,
        mode,
        errorClass: reason?.name,
        errorCode: reason?.code,
      });
      setFailure(reason.message);
      setPhase('preview');
    }
  }

  if (error.status !== 'verified') {
    return (
      <section className="errors-panel" aria-label="GitHub issue">
        <h4>
          <Github size={15} aria-hidden="true" /> GitHub issue
        </h4>
        <p className="errors-hint">
          After a fix works, choose “Fix worked” above. Then you can share the fix as a GitHub
          issue.
        </p>
        {error.issueUrl && <IssueLink error={error} />}
      </section>
    );
  }
  return (
    <section className="errors-panel" aria-labelledby={`issue-heading-${error.id}`}>
      <h4 id={`issue-heading-${error.id}`}>
        <Github size={15} aria-hidden="true" /> GitHub issue
      </h4>
      {error.issueUrl && <IssueLink error={error} />}
      {!preview && (
        <button
          type="button"
          className="outline-button"
          disabled={phase === 'loading'}
          onClick={loadPreview}
        >
          {phase === 'loading' ? 'Preparing preview…' : 'Create GitHub issue'}
        </button>
      )}
      {preview && (
        <div className="errors-preview" role="region" aria-label="GitHub issue preview">
          <h5 ref={heading} tabIndex={-1}>
            What will be published
          </h5>
          {preview.available ? (
            <p className="errors-notice">{preview.notice}</p>
          ) : (
            <p className="settings-error" role="alert">
              {preview.message}
              {preview.code === 'gh_unauthenticated' && ' Then choose Create GitHub issue again.'}
            </p>
          )}
          <dl className="errors-facts">
            <dt>Repository</dt>
            <dd>{preview.repo || 'Unknown'}</dd>
            <dt>Title</dt>
            <dd>{preview.title}</dd>
            <dt>Labels</dt>
            <dd>{preview.labels.length ? preview.labels.join(', ') : 'None'}</dd>
          </dl>
          <pre className="errors-code" tabIndex={0} aria-label="Issue body">
            {preview.body}
          </pre>
          {preview.duplicates.length > 0 && (
            <div className="errors-duplicates">
              <p>
                Issues that already mention this fingerprint. Comment on one instead of creating a
                duplicate:
              </p>
              <ul>
                {preview.duplicates.map((issue) => (
                  <li key={issue.number}>
                    <a href={issue.url} target="_blank" rel="noopener noreferrer">
                      #{issue.number} {issue.title} ({issue.state.toLowerCase()})
                    </a>{' '}
                    <button
                      type="button"
                      className="outline-button"
                      disabled={phase === 'posting'}
                      onClick={() => publish('comment', issue.number)}
                    >
                      Comment on #{issue.number}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="errors-actions">
            {preview.available && (
              <button
                type="button"
                className="outline-button"
                disabled={phase === 'posting'}
                onClick={() => publish('create')}
              >
                {phase === 'posting'
                  ? 'Posting…'
                  : preview.duplicates.length
                    ? 'Create a new issue anyway'
                    : 'Create issue'}
              </button>
            )}
            <button
              type="button"
              className="ghost-button"
              disabled={phase === 'posting'}
              onClick={() => {
                log.info('errors.issue.cancelled', { errorId: error.id });
                setPreview(null);
                setPhase('idle');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {failure && (
        <p className="settings-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

function IssueLink({ error }) {
  return (
    <p className="errors-ok">
      Shared on GitHub:{' '}
      <a href={error.issueUrl} target="_blank" rel="noopener noreferrer">
        {error.issueNumber ? `issue #${error.issueNumber}` : 'open issue'}{' '}
        <ExternalLink size={12} aria-hidden="true" />
      </a>
    </p>
  );
}
