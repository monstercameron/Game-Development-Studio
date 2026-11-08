import { useRouteToggle, updateSearch } from './useNav';
import { useSearchParams } from 'react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { createLog } from './app-log.js';

const log = createLog('projects');

export default function ProjectTrash({ projectId, revision, onChanged }) {
  const [open] = useRouteToggle('trash');
  const [confirm, setConfirm] = useRouteToggle('clearTrash');
  const [, setParams] = useSearchParams();
  const [items, setItems] = useState([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [actionError, setActionError] = useState(''),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(''),
    [warnings, setWarnings] = useState([]),
    [pendingCleanupIds, setPendingCleanupIds] = useState([]),
    [focusAfterRemoval, setFocusAfterRemoval] = useState(null);
  const contentRef = useRef(null),
    headingRef = useRef(null),
    confirmTriggerRef = useRef(null),
    cancelConfirmRef = useRef(null),
    wasConfirmRef = useRef(false);
  // Drop the previous project's list so a stale trash view never shows under a new project id.
  useEffect(() => {
    setItems([]);
    setMessage('');
    setPendingCleanupIds([]);
  }, [projectId]);
  useEffect(() => {
    if (!open) {
      return;
    }
    let active = true;
    if (document.activeElement?.closest?.('.project-trash-content li')) {
      headingRef.current?.focus();
    }
    setLoading(true);
    setLoadError('');
    // log-coverage: ignore -- the app-log fetch wrapper records failed /api calls
    fetch(`/api/projects/${projectId}/assets/trash`)
      .then(async (response) => {
        const responseBody = await response.json();
        if (!response.ok) {
          throw Error(responseBody.error || 'Could not load trash.');
        }
        log.debug('projects.trash.loaded', { itemCount: responseBody.items?.length ?? 0 });
        if (active) {
          setItems(responseBody.items);
          setWarnings(responseBody.warnings || []);
        }
      })
      .catch((error) => {
        log.warn('projects.trash.load.failed', { errorClass: error?.name });
        if (active) {
          setLoadError(error.message);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [open, projectId, revision]);
  // Runs before paint so focus moves to a neighbouring row before the removed button unmounts.
  useLayoutEffect(() => {
    if (focusAfterRemoval === null) {
      return;
    }
    if (busy) {
      headingRef.current?.focus();
      return;
    }
    const buttons = [...(contentRef.current?.querySelectorAll('li button:not(:disabled)') || [])];
    const target = buttons[Math.min(focusAfterRemoval, buttons.length - 1)] || headingRef.current;
    target?.focus();
    setFocusAfterRemoval(null);
  }, [items, focusAfterRemoval, busy]);
  useLayoutEffect(() => {
    if (confirm) {
      wasConfirmRef.current = true;
      cancelConfirmRef.current?.focus();
      return;
    }
    if (wasConfirmRef.current) {
      wasConfirmRef.current = false;
      if (focusAfterRemoval === null) {
        confirmTriggerRef.current?.focus();
      }
    }
  }, [confirm, focusAfterRemoval]);
  function cancelConfirmation() {
    setConfirm(false);
    confirmTriggerRef.current?.focus();
  }
  async function act(action, body) {
    setBusy(true);
    setMessage('');
    setActionError('');
    try {
      // log-coverage: ignore -- the app-log fetch wrapper records failed /api calls
      const response = await fetch(`/api/projects/${projectId}/assets/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
        body: JSON.stringify(body),
      });
      const responseBody = await response.json();
      if (!response.ok) {
        throw Error(responseBody.error || 'Could not update trash.');
      }
      const cleanupPending = action === 'restore' && responseBody.cleanupPending === true;
      if (action === 'restore') {
        log.info('projects.trash.restored', { isCleanupPending: cleanupPending });
      } else {
        log.info('projects.trash.cleared', { deletedCount: responseBody.deleted });
      }
      if (cleanupPending) {
        setPendingCleanupIds((previous) => [...new Set([...previous, body.trashId])]);
      } else if (action === 'restore' || action === 'clear-trash') {
        setFocusAfterRemoval(
          action === 'restore'
            ? Math.max(
                0,
                items.findIndex((item) => item.trashId === body.trashId),
              )
            : 0,
        );
      }
      if (!cleanupPending) {
        setItems((previous) =>
          action === 'restore' ? previous.filter((item) => item.trashId !== body.trashId) : [],
        );
      }
      setConfirm(false);
      setMessage(
        action === 'restore'
          ? cleanupPending
            ? 'Asset restored. Some trash data could not be removed and was preserved for recovery.'
            : 'Asset restored.'
          : `${responseBody.deleted} trashed files permanently deleted.`,
      );
      await onChanged();
    } catch (error) {
      log.warn('projects.trash.action.failed', { action, errorClass: error?.name });
      setActionError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-trash">
      <button
        className="outline-button"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setLoading(true);
          }
          updateSearch(setParams, { trash: open ? null : '1', clearTrash: null });
        }}
      >
        <Trash2 size={15} /> Project trash
      </button>
      {open && (
        <div ref={contentRef} className="project-trash-content">
          <h2 ref={headingRef} tabIndex={-1}>
            Project trash
          </h2>
          <p>Deleted assets stay here until you restore them or clear trash.</p>
          {loading ? (
            <p role="status">Loading project trash…</p>
          ) : loadError ? (
            <p role="alert">{loadError} Close and reopen project trash to retry.</p>
          ) : items.length > 0 ? (
            <>
              <ul>
                {items.map((item) => (
                  <li key={item.trashId}>
                    <div>
                      <strong>{item.path}</strong>
                      <small>
                        {item.deletedAt
                          ? new Date(item.deletedAt).toLocaleString()
                          : 'Deletion date unavailable'}{' '}
                        · {(item.size / 1024).toFixed(1)} KB
                      </small>
                    </div>
                    <button
                      className="outline-button"
                      disabled={busy || pendingCleanupIds.includes(item.trashId)}
                      onClick={() => act('restore', { trashId: item.trashId })}
                    >
                      {pendingCleanupIds.includes(item.trashId) ? 'Restored' : 'Restore'}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                ref={confirmTriggerRef}
                className="danger-solid"
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                Clear trash…
              </button>
            </>
          ) : warnings.length ? (
            <p>No recoverable items are available.</p>
          ) : (
            <p>Trash is empty.</p>
          )}
          {!loading &&
            !loadError &&
            warnings.map((warning) => (
              <p role="status" key={warning}>
                {warning}
              </p>
            ))}
          {confirm && !loading && !loadError && (
            <div
              className="iteration-confirm"
              role="dialog"
              aria-modal="false"
              aria-labelledby="project-trash-confirm-title"
              aria-describedby="project-trash-confirm-description"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) {
                  event.preventDefault();
                  cancelConfirmation();
                }
              }}
            >
              <strong id="project-trash-confirm-title" tabIndex={-1}>
                Permanently delete all {items.length} trashed files?
              </strong>
              <p id="project-trash-confirm-description">
                This removes the files from disk and cannot be undone. Restore any files you want to
                keep first.
              </p>
              <div>
                <button
                  ref={cancelConfirmRef}
                  className="ghost-button"
                  disabled={busy}
                  onClick={cancelConfirmation}
                >
                  Cancel
                </button>
                <button
                  className="danger-solid"
                  disabled={busy}
                  onClick={() => act('clear-trash', { confirmation: 'permanently-delete-trash' })}
                >
                  Permanently delete trash
                </button>
              </div>
            </div>
          )}
          {message && <p role="status">{message}</p>}
          {actionError && <p role="alert">{actionError}</p>}
        </div>
      )}
    </section>
  );
}
