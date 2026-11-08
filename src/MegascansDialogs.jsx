import { useEffect, useState } from 'react';
import { Copy, Download, ExternalLink, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import useDialogFocus from './useDialogFocus';
import { DownloadConsent } from './MegascansFab';
import { LicencesAndTerms } from './MegascansLegal';
import { createLog } from './app-log.js';
import {
  describeFormats,
  describeSizeRange,
  formatAge,
  formatBytes,
  getMegascans,
  postMegascans,
  requestFailureFields,
  statusLabel,
} from './megascans-api';

const log = createLog('megascans');

function splitTags(text) {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Adds a listing reference or edits one. Only the listing id is read from the address. */
export function ListingFormDialog({ listing, onClose, onSaved }) {
  const editing = Boolean(listing);
  const [url, setUrl] = useState(listing?.url || '');
  const [title, setTitle] = useState(listing?.title || '');
  const fromFab = listing?.source === 'fab';
  const [tags, setTags] = useState(listing ? listing.userTags.join(', ') : '');
  const [notes, setNotes] = useState(listing?.notes || '');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        onClose();
      }
    },
    initialFocus: editing ? '#megascans-title' : '#megascans-url',
  });

  async function submit(event) {
    event.preventDefault();
    const fieldErrors = {};
    if (!editing && !/fab\.com\/listings\/[0-9a-f-]{36}|^[0-9a-f-]{36}$/i.test(url.trim())) {
      fieldErrors.url = 'Paste a Fab listing address such as https://www.fab.com/listings/…';
    }
    if (!title.trim()) {
      fieldErrors.title = 'Enter a title for this listing.';
    }
    setErrors(fieldErrors);
    setFormError('');
    if (Object.keys(fieldErrors).length) {
      return;
    }
    setBusy(true);
    try {
      const saved = await postMegascans('/listings', {
        url: url.trim(),
        title: title.trim(),
        tags: splitTags(tags),
        notes,
      });
      onSaved(saved.listing);
    } catch (error) {
      log.warn('megascans.listing.save.failed', requestFailureFields(error));
      setFormError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        ref={dialog}
        className="settings-modal megascans-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="megascans-form-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">MEGASCANS LIBRARY</span>
            <h2 id="megascans-form-title">{editing ? 'Edit listing' : 'Add a listing'}</h2>
            <p>
              Saved on this computer only. Forge reads just the listing id from the address you
              paste. Listings already read from Fab keep Fab's title; you can add notes and tags.
            </p>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={submit} noValidate>
          <label className="field-label" htmlFor="megascans-url">
            Fab listing address
          </label>
          <input
            id="megascans-url"
            value={url}
            readOnly={editing}
            inputMode="url"
            autoComplete="off"
            placeholder="https://www.fab.com/listings/…"
            aria-invalid={Boolean(errors.url)}
            aria-describedby={errors.url ? 'megascans-url-error' : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
          {errors.url && (
            <p id="megascans-url-error" className="settings-error" role="alert">
              {errors.url}
            </p>
          )}
          <label className="field-label" htmlFor="megascans-title">
            Title
          </label>
          <input
            id="megascans-title"
            value={title}
            readOnly={fromFab}
            maxLength={120}
            placeholder="Copy the title from the Fab page"
            aria-invalid={Boolean(errors.title)}
            aria-describedby={errors.title ? 'megascans-title-error' : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {errors.title && (
            <p id="megascans-title-error" className="settings-error" role="alert">
              {errors.title}
            </p>
          )}
          <label className="field-label" htmlFor="megascans-tags">
            Tags (separated by commas)
          </label>
          <input
            id="megascans-tags"
            value={tags}
            placeholder="wood, prop, historic"
            onChange={(event) => setTags(event.target.value)}
          />
          <label className="field-label" htmlFor="megascans-notes">
            Notes
          </label>
          <textarea
            id="megascans-notes"
            rows={3}
            maxLength={2000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          {formError && (
            <p className="settings-error" role="alert">
              {formError}
            </p>
          )}
          <div className="project-dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              <Plus size={16} aria-hidden="true" />
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add listing'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

const QUALITY_LABELS = { low: 'Low', mid: 'Mid', high: 'High', raw: 'Raw (full detail)' };

function FileRow({ file, recommended, offerDownload, disabledReason, busy, onStart }) {
  const [asking, setAsking] = useState(false);
  const size = file.size === null ? 'unknown size' : formatBytes(file.size);
  const label = file.quality ? QUALITY_LABELS[file.quality] : file.name;
  return (
    <li className="megascans-file">
      <div className="megascans-file-text">
        <strong>{label}</strong> · {size}
        {recommended && <span className="megascans-recommended"> · Recommended</span>}
        <span className="megascans-file-name">{file.name}</span>
        {file.isLarge && (
          <span className="megascans-large">Large file: {size}. It may take a while.</span>
        )}
      </div>
      {offerDownload &&
        (asking ? (
          <div className="megascans-file-actions" role="group" aria-label={`Confirm ${file.name}`}>
            <span>This is {size}. Download anyway?</span>
            <button type="button" className="primary" onClick={() => onStart(file, true)}>
              Download anyway
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                log.info('megascans.download.confirm.declined');
                setAsking(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="outline-button"
            disabled={Boolean(disabledReason) || busy}
            title={disabledReason || undefined}
            aria-label={`Download ${file.name} (${size})`}
            onClick={() => {
              if (file.isLarge) {
                log.info('megascans.download.confirm.shown');
                setAsking(true);
              } else {
                onStart(file, false);
              }
            }}
          >
            <Download size={14} aria-hidden="true" /> Download
          </button>
        ))}
    </li>
  );
}

/** The files Fab offers for a listing, grouped by format, with a Download button for each. */
function FileChoices({ listing, project, consent, onQueued }) {
  const [busyUid, setBusyUid] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const groups = listing.detail?.groups;
  if (!groups?.length) {
    return null;
  }
  const disabledReason = !consent?.downloads?.confirmed
    ? 'Tick the license confirmation first.'
    : !project
      ? 'Choose a project on the page first.'
      : '';

  async function start(file, confirmLarge) {
    setBusyUid(file.uid);
    setError('');
    setMessage('');
    try {
      await postMegascans('/downloads', {
        project: project.id,
        listing: listing.id,
        fileUid: file.uid,
        confirmLarge,
      });
      setMessage(`${file.name} is queued. Watch its progress under Downloads on the page.`);
      log.info('megascans.download.queued', { isLargeConfirmed: confirmLarge === true });
      onQueued?.(file);
    } catch (failure) {
      log.warn('megascans.download.start.failed', requestFailureFields(failure));
      setError(failure.message);
    } finally {
      setBusyUid('');
    }
  }

  const advanced = groups.filter((group) => group.advanced);
  return (
    <>
      <h3 className="megascans-subheading">Download from Fab</h3>
      <p className="helper">
        The recommended file is the GLB at mid quality: one file with its textures, and a balance of
        detail and size that suits most games. Low is smaller, high and raw are for close-ups.
      </p>
      {consent && <DownloadConsent {...consent} listing={listing} />}
      {disabledReason && <p className="helper">Downloads are off: {disabledReason}</p>}
      {groups
        .filter((group) => !group.advanced)
        .map((group) => (
          <section key={group.id} className="megascans-file-group" aria-label={group.label}>
            <h4>{group.label}</h4>
            <ul>
              {group.files.map((file) => (
                <FileRow
                  key={file.uid}
                  file={file}
                  recommended={file.uid === listing.detail.recommendedUid}
                  offerDownload={file.importable}
                  disabledReason={disabledReason}
                  busy={busyUid === file.uid}
                  onStart={start}
                />
              ))}
            </ul>
          </section>
        ))}
      {advanced.length > 0 && (
        <details className="megascans-advanced">
          <summary>Advanced: extra texture files</summary>
          <p className="settings-error">
            Warning: these files are very large (up to{' '}
            {formatBytes(
              Math.max(...advanced.flatMap((group) => group.files.map((file) => file.size || 0))),
            )}
            ) and hold textures only, no model. Forge cannot import them; download them on Fab if
            you need them.
          </p>
          <ul>
            {advanced.flatMap((group) =>
              group.files.map((file) => (
                <FileRow key={file.uid} file={file} offerDownload={false} />
              )),
            )}
          </ul>
        </details>
      )}
      {message && (
        <p className="helper" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** Details of one saved listing, with the Fab link, attribution and import action. */
export function ListingDialog({
  listingId,
  project,
  consent,
  onClose,
  onEdit,
  onImport,
  onQueued,
  onRemoved,
}) {
  const [state, setState] = useState({ status: 'loading', listing: null, imports: [], error: '' });
  const [copyMessage, setCopyMessage] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const [detailState, setDetailState] = useState({ status: 'idle', error: '' });
  const dialog = useDialogFocus({ onClose, initialFocus: '.megascans-get-on-fab' });

  useEffect(() => {
    const controller = new AbortController();
    getMegascans(`/listings/${listingId}`, { signal: controller.signal })
      .then(async (loaded) => {
        setState({ status: 'ready', listing: loaded.listing, imports: loaded.imports, error: '' });
        if (loaded.listing.source !== 'fab' || loaded.listing.detailFetchedAt) {
          return;
        }
        // The cache lacks this listing's description and file list: read them once (slowly).
        setDetailState({ status: 'loading', error: '' });
        try {
          const detailed = await postMegascans(`/listings/${listingId}/refresh`);
          if (!controller.signal.aborted) {
            setState((current) => ({ ...current, listing: detailed.listing }));
            setDetailState({ status: 'idle', error: '' });
          }
        } catch (failure) {
          if (!controller.signal.aborted) {
            log.warn('megascans.listing.detail.failed', requestFailureFields(failure));
            setDetailState({ status: 'error', error: failure.message });
          }
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          log.warn('megascans.listing.load.failed', requestFailureFields(error));
          setState({
            status: 'error',
            listing: null,
            imports: [],
            error:
              error.status === 404 ? 'This listing is no longer in the library.' : error.message,
          });
        }
      });
    return () => controller.abort();
  }, [listingId]);

  async function refreshDetails() {
    setDetailState({ status: 'loading', error: '' });
    try {
      const refreshed = await postMegascans(`/listings/${listingId}/refresh`, { force: true });
      setState((current) => ({ ...current, listing: refreshed.listing }));
      setDetailState({ status: 'idle', error: '' });
    } catch (failure) {
      log.warn('megascans.listing.refresh.failed', requestFailureFields(failure));
      setDetailState({ status: 'error', error: failure.message });
    }
  }

  async function copyAttribution() {
    try {
      await navigator.clipboard.writeText(state.listing.attribution);
      setCopyMessage('Attribution copied.');
    } catch (error) {
      log.debug('megascans.attribution.copy.failed', { errorClass: error?.name || 'Error' });
      setCopyMessage('Could not access the clipboard. Select the text and copy it.');
    }
  }

  async function remove() {
    setRemoveError('');
    try {
      await postMegascans(`/listings/${listingId}/remove`);
      log.info('megascans.listing.removed');
      onRemoved();
    } catch (error) {
      log.warn('megascans.listing.remove.failed', requestFailureFields(error));
      setRemoveError(error.message);
    }
  }

  const { listing, imports } = state;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="settings-modal megascans-dialog megascans-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="megascans-detail-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">QUIXEL MEGASCANS · FAB</span>
            <h2 id="megascans-detail-title">
              {state.status === 'loading' ? 'Loading listing…' : listing?.title || 'Listing'}
            </h2>
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {state.status === 'error' && (
          <p className="settings-error" role="alert">
            {state.error}
          </p>
        )}
        {listing && (
          <>
            <div className="megascans-detail-actions">
              <a
                className="primary megascans-get-on-fab"
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={16} aria-hidden="true" /> Open on Fab
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <button
                type="button"
                className="outline-button"
                disabled={!project}
                onClick={() => onImport(listing)}
              >
                <Upload size={15} aria-hidden="true" /> Import file
              </button>
              <button type="button" className="outline-button" onClick={() => onEdit(listing)}>
                <Pencil size={15} aria-hidden="true" /> Edit
              </button>
            </div>
            <p className="helper">
              Download the model on Fab in your browser (Fab asks you to accept its license first),
              then choose the file with Import file.
              {!project && ' Choose a project on the page to enable importing.'}
            </p>
            {listing.thumbnailUrl && (
              <img
                className="megascans-detail-image"
                src={listing.thumbnailUrl}
                alt=""
                decoding="async"
              />
            )}
            <dl className="megascans-facts">
              <div>
                <dt>Seller</dt>
                <dd>{listing.seller}</dd>
              </div>
              <div>
                <dt>License</dt>
                <dd>{listing.license}</dd>
              </div>
              <div>
                <dt>Fab address</dt>
                <dd className="megascans-url">{listing.url}</dd>
              </div>
              {listing.category && (
                <div>
                  <dt>Category</dt>
                  <dd>{listing.category}</dd>
                </div>
              )}
              {listing.formats.length > 0 && (
                <div>
                  <dt>Formats</dt>
                  <dd>
                    {describeFormats(listing)}
                    {describeSizeRange(listing) ? ` · ${describeSizeRange(listing)}` : ''}
                  </dd>
                </div>
              )}
              {listing.publishedAt && (
                <div>
                  <dt>Published</dt>
                  <dd>{new Date(listing.publishedAt).toLocaleDateString()}</dd>
                </div>
              )}
              {listing.detail?.trianglesMax > 0 && (
                <div>
                  <dt>Triangles</dt>
                  <dd>
                    {listing.detail.trianglesMin?.toLocaleString('en-US')} to{' '}
                    {listing.detail.trianglesMax.toLocaleString('en-US')} across the levels of
                    detail
                  </dd>
                </div>
              )}
              {listing.detail?.textureResolutionMax > 0 && (
                <div>
                  <dt>Textures</dt>
                  <dd>
                    {listing.detail.texturesCount ?? '?'} maps, up to{' '}
                    {listing.detail.textureResolutionMax} px
                  </dd>
                </div>
              )}
              <div>
                <dt>Tags</dt>
                <dd>{listing.tags.length ? listing.tags.join(', ') : 'None'}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd className="megascans-notes">{listing.notes || 'None'}</dd>
              </div>
              <div>
                <dt>Attribution</dt>
                <dd>
                  <span id="megascans-attribution">{listing.attribution}</span>{' '}
                  <button type="button" className="link-button" onClick={copyAttribution}>
                    <Copy size={13} aria-hidden="true" /> Copy
                  </button>
                  <span className="helper" role="status">
                    {' '}
                    {copyMessage}
                  </span>
                </dd>
              </div>
            </dl>
            {listing.source === 'fab' && listing.detailFetchedAt && (
              <p className="helper megascans-cached" role="status">
                Details cached {formatAge(listing.detailFetchedAt)}.{' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={detailState.status === 'loading'}
                  onClick={refreshDetails}
                >
                  Refresh details
                </button>
              </p>
            )}
            {detailState.status === 'loading' && (
              <p className="helper" role="status">
                Reading the description and file list from Fab…
              </p>
            )}
            {detailState.status === 'error' && (
              <p className="settings-error" role="alert">
                Could not read details from Fab: {detailState.error}
              </p>
            )}
            {listing.detail?.description && (
              <>
                <h3 className="megascans-subheading">Description (from Fab)</h3>
                <p className="megascans-notes">{listing.detail.description}</p>
              </>
            )}
            <FileChoices
              listing={listing}
              project={project}
              consent={consent}
              onQueued={onQueued}
            />
            <LicencesAndTerms listing={listing} headingId="megascans-detail-legal-title" />
            <h3 className="megascans-subheading">Imported from this listing</h3>
            {imports.length ? (
              <ul className="megascans-imported">
                {imports.map((item) => (
                  <li key={item.id}>
                    {item.filename} · {statusLabel(item.status)}
                    {item.output?.folder || item.output?.files?.[0]
                      ? ` · ${item.output.folder || item.output.files[0]}`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="helper">Nothing imported from this listing yet.</p>
            )}
            <div className="megascans-remove">
              {confirming ? (
                <>
                  <p>
                    Remove this listing from the library? Files already imported into projects stay
                    where they are.
                  </p>
                  <div className="project-dialog-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setConfirming(false)}
                    >
                      Keep it
                    </button>
                    <button type="button" className="danger-button" onClick={remove}>
                      <Trash2 size={15} aria-hidden="true" /> Remove listing
                    </button>
                  </div>
                  {removeError && (
                    <p className="settings-error" role="alert">
                      {removeError}
                    </p>
                  )}
                </>
              ) : (
                <button type="button" className="ghost-button" onClick={() => setConfirming(true)}>
                  <Trash2 size={15} aria-hidden="true" /> Remove from library…
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
