import { useEffect, useRef, useState } from 'react';
import PageErrorBoundary from './PageErrorBoundary';
import { ERRORS_CHANGED_EVENT } from './error-capture.js';
import { postErrors } from './errors-api.js';
import './error-pipeline-test.css';

// Every generated error starts with this text, so nobody mistakes it for a real fault. The
// Delete test errors action removes only rows that contain it.
const TEST_ERROR_MARKER = '[Forge test error]';
const EMIT_BODY = { confirm: 'emit-test-error' };
const DELETE_BODY = { confirm: 'delete-test-errors' };
const CAPTURE_WAIT_MS = 4000;
// Deliberately fake values, so the redaction of paths, keys, tokens and emails can be checked.
const FAKE_DETAILS =
  'file C:\\Users\\forge-test-user\\Documents\\forge-test-private\\notes.txt; ' +
  'key sk-test-FAKE0123456789abcdef0123456789; header Bearer forgeTestBearerToken0123456789; ' +
  'contact forge-test-user@example.com';

function makeTestError(label, run) {
  return new Error(`${TEST_ERROR_MARKER} ${label} (run ${run}; ${FAKE_DETAILS})`);
}

// Resolves true when the capture code reports that the studio saved a browser report.
function waitForCapture(cancels) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (isSaved) => {
      clearTimeout(timer);
      window.removeEventListener(ERRORS_CHANGED_EVENT, handleSaved);
      cancels.delete(cancel);
      resolve(isSaved);
    };
    const handleSaved = () => finish(true);
    const cancel = () => finish(false);
    cancels.add(cancel);
    timer = setTimeout(() => finish(false), CAPTURE_WAIT_MS);
    window.addEventListener(ERRORS_CHANGED_EVENT, handleSaved);
  });
}

function throwFromTimer(run) {
  window.setTimeout(function throwTestException() {
    throw makeTestError('Browser uncaught exception from a timer', run);
  }, 0);
}

function rejectWithoutHandler(run) {
  // Deliberately unhandled: the browser reports it as an unhandled promise rejection.
  Promise.reject(makeTestError('Browser unhandled promise rejection', run));
}

function BrokenTestWidget({ run }) {
  throw makeTestError('Browser React render error', run);
}

function describeFailure(reason) {
  if (reason?.status === 404) {
    return 'The studio has not loaded the test routes. Restart the studio, then try again.';
  }
  return reason?.message || 'The request failed.';
}

const SAVED_TEXT = 'Sent. The studio saved it; open the error review to see the new row.';
const UNCONFIRMED_TEXT =
  'Sent, but the studio has not confirmed saving it. Open the error review and check.';

export default function ErrorPipelineTest({ onOpenErrors }) {
  const [states, setStates] = useState({});
  const [sandbox, setSandbox] = useState({ run: 0, key: 0 });
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState('');
  const runCounter = useRef(0);
  const cancels = useRef(new Set());
  const confirmRef = useRef(null);

  useEffect(() => {
    const pending = cancels.current;
    return () => {
      for (const cancel of [...pending]) {
        cancel();
      }
    };
  }, []);

  useEffect(() => {
    if (isConfirmingDelete) {
      confirmRef.current?.focus();
    }
  }, [isConfirmingDelete]);

  const setTriggerState = (id, text, phase) =>
    setStates((current) => ({ ...current, [id]: { text, phase } }));

  async function start(id, action) {
    const run = ++runCounter.current;
    setTriggerState(id, 'Sending…', 'sending');
    try {
      const isSaved = await action(run);
      setTriggerState(id, isSaved ? SAVED_TEXT : UNCONFIRMED_TEXT, 'sent');
    } catch (reason) {
      setTriggerState(id, `Failed: ${describeFailure(reason)}`, 'failed');
    }
  }

  async function postTest(path, body = EMIT_BODY) {
    await postErrors(path, body);
    // The server wrote the row itself, so the top-bar count can refresh now.
    window.dispatchEvent(new Event(ERRORS_CHANGED_EVENT));
    return true;
  }

  const triggers = [
    {
      group: 'Browser',
      id: 'uncaught',
      label: 'Browser: uncaught exception',
      help: 'Throws inside a timer, so the window error event fires with a real stack.',
      run: async (run) => {
        const saved = waitForCapture(cancels.current);
        throwFromTimer(run);
        return saved;
      },
    },
    {
      group: 'Browser',
      id: 'rejection',
      label: 'Browser: unhandled promise rejection',
      help: 'Rejects a promise nobody handles, so the unhandledrejection event fires.',
      run: async (run) => {
        const saved = waitForCapture(cancels.current);
        rejectWithoutHandler(run);
        return saved;
      },
    },
    {
      group: 'Browser',
      id: 'render',
      label: 'Browser: React render error',
      help: 'Renders a component that throws inside the sandbox below. The page stays usable.',
      run: async (run) => {
        const saved = waitForCapture(cancels.current);
        setSandbox((current) => ({ ...current, run }));
        return saved;
      },
    },
    {
      group: 'Browser',
      id: 'api',
      label: 'Browser: failed API call',
      help: 'Calls a studio test route that answers HTTP 500, which the fetch wrapper reports.',
      run: async () => {
        const saved = waitForCapture(cancels.current);
        try {
          await postErrors('/test/api-failure', EMIT_BODY);
        } catch (reason) {
          if (reason?.status !== 500 || reason?.code !== 'test_api_failure') {
            throw reason;
          }
        }
        return saved;
      },
    },
    {
      group: 'Studio server',
      id: 'server',
      label: 'Server: thrown exception with stack',
      help: 'The host throws through three nested functions and logs the error with its stack.',
      run: () => postTest('/test/server'),
    },
    {
      group: 'Engine log',
      id: 'python',
      label: 'Engine-style Python traceback',
      help: 'Runs a small Python helper that raises a chained exception into engine-test.log.',
      run: () => postTest('/test/python', { ...EMIT_BODY, variant: 'traceback' }),
    },
    {
      group: 'Engine log',
      id: 'asgi',
      label: 'Engine-style uvicorn ASGI error',
      help: 'The same helper, logged the way uvicorn logs “Exception in ASGI application”.',
      run: () => postTest('/test/python', { ...EMIT_BODY, variant: 'asgi' }),
    },
  ];
  const groups = [...new Set(triggers.map((trigger) => trigger.group))];

  async function deleteTestErrors() {
    setDeleteStatus('Deleting…');
    try {
      const result = await postErrors('/test/delete', DELETE_BODY);
      window.dispatchEvent(new Event(ERRORS_CHANGED_EVENT));
      setDeleteStatus(
        `Deleted ${result.removed} test error${result.removed === 1 ? '' : 's'}. Real errors were kept.`,
      );
    } catch (reason) {
      setDeleteStatus(`Failed: ${describeFailure(reason)}`);
    }
    setIsConfirmingDelete(false);
  }

  return (
    <details className="panel error-test">
      <summary>
        <span className="mini-label">DEVELOPER TOOLS</span>
        <span className="error-test-title">Test the error pipeline</span>
      </summary>
      <div className="error-test-body">
        <p>
          Each button creates one real test error and sends it through the same capture path a real
          fault uses. Every test error starts with <code>{TEST_ERROR_MARKER}</code> and includes
          fake keys, an email and a home folder path, so you can check that they are redacted.
          Nothing here starts an engine, loads a model or uses the GPU.
        </p>
        {groups.map((group) => (
          <section key={group} className="error-test-group" aria-label={`${group} tests`}>
            <h3>{group}</h3>
            <ul>
              {triggers
                .filter((trigger) => trigger.group === group)
                .map((trigger) => {
                  const current = states[trigger.id];
                  return (
                    <li key={trigger.id}>
                      <button
                        type="button"
                        className="outline-button"
                        aria-describedby={`error-test-help-${trigger.id} error-test-status-${trigger.id}`}
                        disabled={current?.phase === 'sending'}
                        onClick={() => start(trigger.id, trigger.run)}
                      >
                        {trigger.label}
                      </button>
                      <p id={`error-test-help-${trigger.id}`} className="helper">
                        {trigger.help}
                      </p>
                      <p
                        id={`error-test-status-${trigger.id}`}
                        className={'error-test-status ' + (current?.phase || '')}
                        role="status"
                        aria-live="polite"
                      >
                        {current?.text || ''}
                      </p>
                    </li>
                  );
                })}
            </ul>
            {group === 'Browser' && (
              <div className="error-test-sandbox">
                <h4>Render error sandbox</h4>
                <PageErrorBoundary key={sandbox.key} name="the error test sandbox">
                  {sandbox.run ? (
                    <BrokenTestWidget run={sandbox.run} />
                  ) : (
                    <p className="helper">The sandbox is healthy. Nothing is rendered in it.</p>
                  )}
                </PageErrorBoundary>
                <button
                  type="button"
                  className="outline-button"
                  disabled={!sandbox.run}
                  onClick={() => setSandbox((current) => ({ run: 0, key: current.key + 1 }))}
                >
                  Reset sandbox
                </button>
              </div>
            )}
          </section>
        ))}
        <section className="error-test-group" aria-label="Review and clean up">
          <h3>Review and clean up</h3>
          <div className="error-test-actions">
            <button type="button" className="outline-button" onClick={onOpenErrors}>
              Open error review
            </button>
            {isConfirmingDelete ? (
              <span role="group" aria-label="Confirm deleting test errors">
                Delete every error that contains {TEST_ERROR_MARKER}? Real errors are kept.{' '}
                <button
                  ref={confirmRef}
                  type="button"
                  className="outline-button danger-button"
                  onClick={deleteTestErrors}
                >
                  Yes, delete test errors
                </button>{' '}
                <button
                  type="button"
                  className="outline-button"
                  onClick={() => setIsConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="outline-button"
                onClick={() => {
                  setDeleteStatus('');
                  setIsConfirmingDelete(true);
                }}
              >
                Delete test errors
              </button>
            )}
          </div>
          <p className="error-test-status" role="status" aria-live="polite">
            {deleteStatus}
          </p>
        </section>
      </div>
    </details>
  );
}
