import { useEffect, useMemo, useRef, useState } from 'react';
import { AudioLines, Check, File, FolderOpen, LoaderCircle, Search, X } from 'lucide-react';
import { compatibleAssets, readLibraryFiles } from './asset-picker.js';
import useDialogFocus from './useDialogFocus';
import { createLog } from './app-log.js';
import './asset-picker.css';

const log = createLog('assets');
const sizeLabel = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes >= 1024 * 1024 ? 1 : 2)} MiB`;
export default function AssetPicker({
  projects,
  project,
  extensions,
  maxFiles = 1,
  maxBytes = 10 * 1024 * 1024,
  totalBytes = Infinity,
  title = 'Choose from asset library',
  description = 'Choose compatible files from the selected project.',
  onSelect,
  onClose,
}) {
  const [projectId, setProjectId] = useState(project?.id || projects[0]?.id || '');
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busyRef.current) {
        closeRef.current();
      }
    },
    initialFocus: '.asset-picker-close',
  });
  const abort = useRef(null),
    closeRef = useRef(onClose),
    busyRef = useRef(false);
  closeRef.current = onClose;
  busyRef.current = busy;
  const thumbnailFailuresRef = useRef(0);
  useEffect(
    () => () => {
      if (thumbnailFailuresRef.current > 0) {
        log.debug('assets.picker.thumbnails.failed', {
          failedCount: thumbnailFailuresRef.current,
        });
      }
    },
    [],
  );
  const source = projects.find((item) => item.id === projectId) || null;
  const matches = useMemo(
    () => compatibleAssets(source?.assets, extensions, query),
    [source, extensions, query],
  );
  const hasCompatibleAssets = useMemo(
    () => compatibleAssets(source?.assets, extensions).length > 0,
    [source, extensions],
  );
  const chosen = selected
    .map((id) => source?.assets.find((asset) => asset.id === id))
    .filter(Boolean);
  const selectedBytes = chosen.reduce((sum, asset) => sum + asset.size, 0);
  useEffect(() => {
    if (!projectId && projects.length) {
      setProjectId(project?.id || projects[0].id);
    }
  }, [projectId, projects, project?.id]);
  useEffect(() => () => abort.current?.abort(), []);
  function toggle(asset) {
    setError('');
    if (selected.includes(asset.id)) {
      setSelected((items) => items.filter((id) => id !== asset.id));
      return;
    }
    if (maxFiles === 1) {
      setSelected([asset.id]);
      return;
    }
    if (selected.length >= maxFiles) {
      log.debug('assets.picker.limit.reached', { reason: 'file_count' });
      setError(
        `You can select up to ${maxFiles} files in total. Remove a selection to choose another.`,
      );
      return;
    }
    if (selectedBytes + asset.size > totalBytes) {
      log.debug('assets.picker.limit.reached', { reason: 'total_bytes' });
      setError(
        'The selected files exceed the combined size limit. Remove a file or choose a smaller one.',
      );
      return;
    }
    setSelected((items) => [...items, asset.id]);
  }
  async function useAssets() {
    if (!source || !chosen.length) {
      return;
    }
    setBusy(true);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      const files = await readLibraryFiles(source, chosen, {
        maxBytes,
        totalBytes,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        onSelect(files);
        log.info('assets.picker.selected', { fileCount: chosen.length, selectedBytes });
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        log.warn('assets.picker.read.failed', { errorClass: reason?.name });
        setError(reason.message || 'Could not read the selected files.');
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }
  return (
    <div
      className="modal-backdrop asset-picker-backdrop"
      onClick={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <section
        ref={dialog}
        className="asset-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-picker-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="asset-picker-header">
          <div>
            <h2 id="asset-picker-title">{title}</h2>
            <p>{description}</p>
          </div>
          <button
            className="icon-btn asset-picker-close"
            aria-label="Close asset picker"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="asset-picker-controls">
          <label>
            Project
            <select
              value={projectId}
              disabled={busy}
              onChange={(event) => {
                setProjectId(event.target.value);
                setSelected([]);
                setError('');
              }}
            >
              {!projects.length && <option value="">No projects</option>}
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <div className="asset-picker-search">
              <Search size={16} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search names or folders"
                disabled={busy}
              />
            </div>
          </label>
        </div>
        <div className="asset-picker-info">
          <span>
            Supported: {extensions.map((value) => value.toUpperCase()).join(' / ')}.{' '}
            {sizeLabel(maxBytes)} per file
            {Number.isFinite(totalBytes) ? ` · ${sizeLabel(totalBytes)} total` : ''}
          </span>
          <span role="status" aria-live="polite" aria-atomic="true">
            {matches.length} {matches.length === 1 ? 'file' : 'files'}
          </span>
        </div>
        <div className="asset-picker-results">
          {matches.length === 0 ? (
            <div className="asset-picker-empty">
              <FolderOpen size={25} aria-hidden="true" />
              <strong>
                {source && hasCompatibleAssets ? 'No matching files' : 'No compatible files'}
              </strong>
              <span>
                {!source
                  ? 'Create a project and add a compatible file first.'
                  : !source.assets?.length
                    ? 'Add a compatible file to this project or choose another project.'
                    : hasCompatibleAssets
                      ? 'Change or clear your search, or choose another project.'
                      : 'Add a supported file to this project or choose another project.'}
              </span>
            </div>
          ) : (
            <div className="asset-picker-grid">
              {matches.map((asset) => {
                const overFileLimit = asset.size > maxBytes,
                  overTotalLimit = asset.size > totalBytes,
                  tooLarge = overFileLimit || overTotalLimit,
                  active = selected.includes(asset.id),
                  visual = ['Images', 'Masks'].includes(asset.category),
                  folder = asset.id.includes('/') ? asset.id.split('/').slice(0, -1).join('/') : '',
                  metadataId = `asset-picker-meta-${encodeURIComponent(asset.id)}`,
                  limitMessage = overFileLimit
                    ? `File is larger than the ${sizeLabel(maxBytes)} per-file limit.`
                    : `File is larger than the ${sizeLabel(totalBytes)} total selection limit.`;
                return (
                  <button
                    type="button"
                    key={asset.id}
                    className={'asset-picker-item ' + (active ? 'selected' : '')}
                    aria-pressed={active}
                    aria-label={`${active ? 'Deselect' : 'Select'} ${asset.name}`}
                    aria-describedby={metadataId}
                    disabled={busy || tooLarge}
                    onClick={() => toggle(asset)}
                    title={tooLarge ? limitMessage : undefined}
                  >
                    <span className="asset-picker-thumb">
                      {visual ? (
                        <img
                          src={asset.url}
                          alt=""
                          loading="lazy"
                          onError={() => {
                            thumbnailFailuresRef.current += 1;
                          }}
                        />
                      ) : asset.category === 'Audio' ? (
                        <AudioLines size={29} />
                      ) : (
                        <File size={29} />
                      )}
                      <span className="asset-picker-format">
                        {asset.name.split('.').pop().toUpperCase()}
                      </span>
                      <span className="asset-picker-check" aria-hidden="true">
                        {active && <Check size={15} />}
                      </span>
                    </span>
                    <span className="asset-picker-name">{asset.name}</span>
                    <small id={metadataId} className="asset-picker-meta">
                      {tooLarge ? limitMessage : sizeLabel(asset.size)}
                      <span className="asset-picker-folder">
                        {folder ? `Folder: ${folder}` : 'Project root'}
                      </span>
                    </small>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <footer className="asset-picker-footer">
          <div>
            <strong aria-live="polite" aria-atomic="true">
              {selected.length} {selected.length === 1 ? 'file' : 'files'} selected
            </strong>
            <span>{maxFiles > 1 ? `Up to ${maxFiles} files` : 'Choose one file'}</span>
          </div>
          <button className="ghost-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !chosen.length}
            aria-busy={busy}
            onClick={useAssets}
          >
            {busy && <LoaderCircle className="asset-picker-spinner" size={16} aria-hidden="true" />}
            {busy ? 'Reading files…' : selected.length === 1 ? 'Use file' : 'Use files'}
          </button>
        </footer>
        <span className="asset-picker-sr-status" role="status" aria-live="polite">
          {busy ? 'Reading selected files.' : ''}
        </span>
        {error && (
          <p className="asset-picker-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
