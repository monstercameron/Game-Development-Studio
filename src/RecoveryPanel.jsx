import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, Copy, RefreshCw } from 'lucide-react';
import { copyToClipboard } from './error-copy.js';
import { useT } from './i18n/index.js';
import { getRecovery, postRecovery } from './recovery-api.js';
import { ageParts, sizeParts } from './recovery-format.js';
import { createLog } from './app-log.js';
import './recovery-panel.css';

const log = createLog('runtime');
const POLL_MS = 20000;
const RESOLVE_CONFIRMATION = 'engine-job-not-running';
const QUARANTINE_CONFIRMATION = 'quarantine-orphans';

// Says what the runtime knows about a job's outcome. An unknown outcome is never described as
// safe to queue again, because the engine may already have accepted the render.
function describeJobOutcome(job, t) {
  if (job.kind === 'unknown_outcome') {
    return job.hasRemoteId
      ? t(
          'diagnostics.recovery.unknownAccepted',
          'The engine accepted this render before the studio stopped. Whether it finished is unknown.',
        )
      : t(
          'diagnostics.recovery.unknownSubmitted',
          'The studio stopped while submitting this render. Whether the engine accepted it is unknown.',
        );
  }
  if (job.type === 'vegetation') {
    return t(
      'diagnostics.recovery.vegetation',
      'Vegetation runs on this computer only and gives the same plant each time, so running it again is safe.',
    );
  }
  if (job.safeToRetry) {
    return t(
      'diagnostics.recovery.preparedOnly',
      'Preparation stopped before anything was submitted to an engine.',
    );
  }
  return t(
    'diagnostics.recovery.reconnectFailed',
    'The engine could not be reconnected for a render it had accepted.',
  );
}

// Describes an engine from the report. An unavailable engine is never shown as running.
function describeEngineState(engine, t) {
  if (engine.status === 'unavailable') {
    if (engine.reason === 'timeout') {
      return t(
        'diagnostics.recovery.engineHung',
        'accepts connections but does not answer; it may be hung.',
      );
    }
    return t('diagnostics.recovery.engineDown', 'is not running.');
  }
  if (engine.ownership === 'unresolved') {
    return t(
      'diagnostics.recovery.engineUnresolved',
      'is running, but the studio could not confirm it owns it.',
    );
  }
  if (engine.ownership === 'recovered') {
    return t('diagnostics.recovery.engineAdopted', 'was found running and re-adopted.');
  }
  return t('diagnostics.recovery.engineUnverified', 'answered, but is not verified.');
}

// Engines worth a line: found running, unverified, or hung. A plain "not running" engine is not.
function isEngineToReport(engine) {
  return (
    engine.status !== 'unavailable' ||
    engine.reason === 'timeout' ||
    engine.ownership === 'unresolved'
  );
}

function JobItem({ job, busy, checked, onCheck, onResolve, onRetry }) {
  const { t } = useT();
  const canResolve = job.status === 'interrupted';
  const statusLabel =
    job.status === 'interrupted'
      ? t('diagnostics.recovery.statusInterrupted', 'Interrupted')
      : t('diagnostics.recovery.statusNeedsAttention', 'Needs attention');
  const explanation = describeJobOutcome(job, t);
  const details = [job.stage, job.error].filter(Boolean).join('\n');
  const [copyStatus, setCopyStatus] = useState('');
  const checkboxId = `recovery-confirm-${job.id}`;
  return (
    <li className="recovery-job">
      <div className="recovery-job-head">
        <strong className="recovery-job-type">{job.type}</strong>
        <span className="recovery-badge">
          <CircleAlert size={13} aria-hidden="true" />
          {statusLabel}
        </span>
        {job.project ? <span className="recovery-muted">{job.project}</span> : null}
      </div>
      <p>{explanation}</p>
      {job.savedOutput === 'valid' || job.savedOutput === 'unverified' ? (
        <p>
          {job.savedOutput === 'valid'
            ? t(
                'diagnostics.recovery.savedValid',
                'A complete output file for this render is in the project. It stays there whatever you decide.',
              )
            : t(
                'diagnostics.recovery.savedUnverified',
                'An output file for this render is in the project, but its end could not be checked. It stays there whatever you decide.',
              )}
        </p>
      ) : null}
      {job.savedOutput === 'invalid' ? (
        <p>
          {t(
            'diagnostics.recovery.savedDamaged',
            'A partly written output file was found for this render. It is kept, not removed.',
          )}
        </p>
      ) : null}
      {details ? (
        <div className="recovery-details">
          <pre>{details}</pre>
          <button
            type="button"
            className="recovery-link"
            onClick={async () => {
              setCopyStatus(await copyToClipboard(details, 'Details'));
            }}
          >
            <Copy size={13} aria-hidden="true" />
            {t('diagnostics.recovery.copyDetails', 'Copy details')}
          </button>
          <span className="recovery-muted" role="status" aria-live="polite">
            {copyStatus}
          </span>
        </div>
      ) : null}
      <div className="recovery-job-actions">
        {canResolve ? (
          <>
            <label className="recovery-check" htmlFor={checkboxId}>
              <input
                id={checkboxId}
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={(event) => onCheck(job.id, event.target.checked)}
              />
              {t(
                'diagnostics.recovery.confirmNotRendering',
                'I checked that the engine is not rendering this job',
              )}
            </label>
            <button
              type="button"
              className="recovery-button"
              disabled={!checked || busy}
              onClick={() => onResolve(job.id)}
            >
              {t('diagnostics.recovery.markCancelled', 'Mark as cancelled')}
            </button>
          </>
        ) : null}
        {job.safeToRetry ? (
          <button
            type="button"
            className="recovery-button"
            disabled={busy}
            onClick={() => onRetry(job.id)}
          >
            {t('diagnostics.recovery.retry', 'Queue again')}
          </button>
        ) : null}
        {!job.safeToRetry && canResolve ? (
          <span className="recovery-muted">
            {t(
              'diagnostics.recovery.noRetry',
              'It cannot be queued again from here: that could repeat work the engine already did.',
            )}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Shown only when the studio found something that needs a decision after an unclean stop, a
 * repaired database or a supervisor that stopped restarting. Every action is explicit and
 * confirmed; nothing is retried or removed automatically.
 */
export default function RecoveryPanel() {
  const { t } = useT();
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [checked, setChecked] = useState({});
  const [errorCopyStatus, setErrorCopyStatus] = useState('');
  const latest = useRef(0);
  const isLoadFailing = useRef(false);
  const wasNeedingAttention = useRef(false);

  const load = useCallback(async (signal) => {
    const request = ++latest.current;
    try {
      const next = await getRecovery({ signal });
      isLoadFailing.current = false;
      if (request === latest.current) {
        setReport(next);
        // Logged on change only: the report is polled every 20 seconds.
        const needsAttention = Boolean(next?.needsAttention);
        if (needsAttention !== wasNeedingAttention.current) {
          wasNeedingAttention.current = needsAttention;
          log.info('recovery.attention.changed', {
            needsAttention,
            jobItemCount: next?.jobs?.items?.length ?? 0,
            orphanItemCount: next?.orphans?.items?.length ?? 0,
          });
        }
      }
    } catch (error) {
      // An unreachable or older studio has no report to show; the connection message covers it.
      // Aborts happen on unmount and are not failures.
      if (!isLoadFailing.current && !signal?.aborted) {
        isLoadFailing.current = true;
        log.debug('recovery.report.failed', { error });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    // log-coverage: ignore -- poll tick only; failures and state changes are logged inside load
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        load(controller.signal);
      }
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);

  async function run(body, doneMessage) {
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await postRecovery(body);
      log.info('recovery.action.completed', {
        action: body.action,
        jobId: body.jobId,
        count: body.ids?.length,
      });
      setNotice(doneMessage);
      await load();
    } catch (error) {
      log.warn('recovery.action.failed', {
        action: body.action,
        jobId: body.jobId,
        count: body.ids?.length,
        error,
      });
      setActionError(error.message);
      setErrorCopyStatus('');
    } finally {
      setBusy(false);
    }
  }

  if (!report?.needsAttention) {
    return null;
  }
  const jobs = (report.jobs?.items || []).filter((job) => job.kind !== 'continuing');
  const orphans = report.orphans?.items || [];
  const problems = report.orphans?.projectProblems || [];
  const databases = (report.databases || []).filter((database) => database.state !== 'ok');
  const engines = report.engines || [];
  // An engine that is simply not running needs no decision, so it is left out of the list.
  const reportedEngines = engines.filter(isEngineToReport);
  const notRunningCount = engines.length - reportedEngines.length;
  const lastAlive = report.previous?.lastAliveAt
    ? new Date(report.previous.lastAliveAt).toLocaleString()
    : null;
  const crashLoop = report.recoveryNeeded;

  return (
    <section className="recovery-panel" aria-labelledby="recovery-title">
      <div className="recovery-head">
        <h2 id="recovery-title">{t('diagnostics.recovery.title', 'Recovery needed')}</h2>
        <div className="recovery-head-actions">
          <button
            type="button"
            className="recovery-button"
            disabled={busy}
            onClick={() =>
              run({ action: 'rescan' }, t('diagnostics.recovery.rescanned', 'Checked again.'))
            }
          >
            <RefreshCw size={14} aria-hidden="true" />
            {t('diagnostics.recovery.rescan', 'Check again')}
          </button>
          <button
            type="button"
            className="recovery-button"
            disabled={busy}
            onClick={() =>
              run({ action: 'dismiss' }, t('diagnostics.recovery.dismissed', 'Dismissed.'))
            }
          >
            {t('diagnostics.recovery.dismiss', 'Dismiss')}
          </button>
        </div>
      </div>
      <p className="recovery-lead">
        {report.unclean
          ? lastAlive
            ? t(
                'diagnostics.recovery.uncleanSince',
                'The studio did not shut down in an orderly way. It was last known to be running at {time}. Nothing was changed without a record; the items below need a decision.',
                { time: lastAlive },
              )
            : t(
                'diagnostics.recovery.unclean',
                'The studio did not shut down in an orderly way. Nothing was changed without a record; the items below need a decision.',
              )
          : t(
              'diagnostics.recovery.attention',
              'The studio found items that need a decision. Nothing was changed without a record.',
            )}
      </p>
      {crashLoop ? (
        <p className="recovery-alert" role="alert">
          {t(
            'diagnostics.recovery.crashLoop',
            'The {component} crashed {count} times in {minutes} minutes, so the studio stopped restarting it. Your queue and projects were not changed. Fix the cause shown in Diagnostics, then restart the studio.',
            {
              component: crashLoop.component,
              count: crashLoop.count,
              minutes: Math.max(1, Math.round(crashLoop.windowMs / 60000)),
            },
          )}
        </p>
      ) : null}

      {jobs.length ? (
        <div className="recovery-group">
          <h3>{t('diagnostics.recovery.jobsTitle', 'Renders that need a decision')}</h3>
          <ul className="recovery-list">
            {jobs.map((job) => (
              <JobItem
                key={job.id}
                job={job}
                busy={busy}
                checked={checked[job.id] === true}
                onCheck={(id, value) => setChecked((previous) => ({ ...previous, [id]: value }))}
                onResolve={(jobId) =>
                  run(
                    { action: 'resolve-job', jobId, confirm: RESOLVE_CONFIRMATION },
                    t('diagnostics.recovery.resolved', 'The job was marked as cancelled.'),
                  )
                }
                onRetry={(jobId) =>
                  run(
                    { action: 'retry-job', jobId },
                    t('diagnostics.recovery.retried', 'The job was queued again.'),
                  )
                }
              />
            ))}
          </ul>
        </div>
      ) : null}

      {orphans.length ? (
        <div className="recovery-group">
          <h3>
            {t('diagnostics.recovery.orphansTitle', 'Files left by an interrupted operation')}
          </h3>
          <p>
            {t(
              'diagnostics.recovery.orphansBody',
              'These files were found and left in place. Moving them to quarantine keeps them in a folder you can open; nothing is erased.',
            )}
          </p>
          <ul className="recovery-list">
            {orphans.map((item) => {
              const size = sizeParts(item.bytes);
              const age = ageParts(item.ageHours);
              return (
                <li key={item.id} className="recovery-orphan">
                  <code>{item.path}</code>
                  <span className="recovery-muted">
                    {item.project?.name ? `${item.project.name} · ` : ''}
                    {t('diagnostics.recovery.orphanMeta', '{size} {unit}, {age} {ageUnit} old', {
                      size: size.value,
                      unit: size.unit,
                      age: age.value,
                      ageUnit: age.unit,
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="recovery-button"
            disabled={busy}
            onClick={() =>
              run(
                {
                  action: 'quarantine-orphans',
                  ids: orphans.map((item) => item.id),
                  confirm: QUARANTINE_CONFIRMATION,
                },
                t('diagnostics.recovery.quarantined', 'The files were moved to quarantine.'),
              )
            }
          >
            {t('diagnostics.recovery.quarantine', 'Move to quarantine')}
          </button>
        </div>
      ) : null}

      {problems.length ? (
        <div className="recovery-group">
          <h3>{t('diagnostics.recovery.projectsTitle', 'Project folders to check')}</h3>
          <ul className="recovery-list">
            {problems.map((problem) => (
              <li key={problem.folder}>
                <code>{problem.folder}</code>{' '}
                <span className="recovery-muted">
                  {problem.kind === 'project_folder_empty'
                    ? t('diagnostics.recovery.projectEmpty', 'Empty folder with no project record.')
                    : t(
                        'diagnostics.recovery.projectUnreadable',
                        'The project record is missing or unreadable. The files were not changed.',
                      )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {databases.length ? (
        <div className="recovery-group">
          <h3>{t('diagnostics.recovery.databasesTitle', 'Databases that were repaired')}</h3>
          <ul className="recovery-list">
            {databases.map((database) => (
              <li key={database.name}>
                <strong>{database.name}</strong>{' '}
                {database.state === 'started_fresh'
                  ? t(
                      'diagnostics.recovery.dbFresh',
                      'was damaged and started empty. The damaged file was kept.',
                    )
                  : database.state === 'restored'
                    ? t(
                        'diagnostics.recovery.dbRestored',
                        'was damaged and restored from a backup. Changes after the backup were lost.',
                      )
                    : t(
                        'diagnostics.recovery.dbQuarantined',
                        'was damaged and set aside. The damaged file was kept.',
                      )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {reportedEngines.length ? (
        <div className="recovery-group">
          <h3>{t('diagnostics.recovery.enginesTitle', 'Engines')}</h3>
          <ul className="recovery-list">
            {reportedEngines.map((engine) => (
              <li key={engine.id}>
                <strong>{engine.name || engine.id}</strong> {describeEngineState(engine, t)}
              </li>
            ))}
          </ul>
          {notRunningCount > 0 ? (
            <p className="recovery-muted">
              {t(
                'diagnostics.recovery.enginesNotRunning',
                '{count} other engines are not running and need no decision, so they are not listed.',
                { count: notRunningCount },
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="recovery-feedback">
        <p className="recovery-muted" role="status" aria-live="polite">
          {notice}
        </p>
        {actionError ? (
          <div className="recovery-error" role="alert">
            <span>{actionError}</span>
            <button
              type="button"
              className="recovery-link"
              onClick={async () => {
                setErrorCopyStatus(await copyToClipboard(actionError, 'Error'));
              }}
            >
              <Copy size={13} aria-hidden="true" />
              {t('diagnostics.recovery.copyError', 'Copy error')}
            </button>
            <span className="recovery-muted" role="status" aria-live="polite">
              {errorCopyStatus}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
