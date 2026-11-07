import TextAssetPreview from './TextAssetPreview';
import './project-gallery-refinement.css';
import './gallery-ux.css';
import { useSearchParams } from 'react-router';
import { updateSearch, useRouteToggle, routeDetails } from './useNav';
import InteractiveAssetViewer from './InteractiveAssetViewer';
import AssetThumbnail, { isVisualAsset } from './AssetThumbnail';
import AssetConverter, { canConvert } from './AssetConverter';
import ProjectTrash from './ProjectTrash.jsx';
import useDialogFocus from './useDialogFocus';
import RuntimeQueue from './RuntimeQueue';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  AudioLines,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Copy,
  FileOutput,
  FileText,
  FolderOpen,
  Image,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';

const categories = ['All', 'Images', '3D', 'Video', 'Audio', 'Masks', 'Text'];
const filesize = (size) =>
  typeof size === 'number'
    ? size < 1024
      ? `${size} B`
      : size < 1024 ** 2
        ? `${(size / 1024).toFixed(1)} KB`
        : `${(size / 1024 ** 2).toFixed(1)} MB`
    : '—';
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';
function iconFor(category) {
  return category === 'Audio'
    ? AudioLines
    : category === 'Video'
      ? Clapperboard
      : category === '3D'
        ? Box
        : category === 'Text'
          ? FileText
          : Image;
}

function AssetPreview({ asset, position, total, onClose, onStep, project, onMutate, onConverted }) {
  const [, setParams] = useSearchParams();
  const [converting, setConverting] = useRouteToggle('convert');
  const [message, setMessage] = useState('');
  const [imagePreviewFailed, setImagePreviewFailed] = useState(false);
  const [editing, setEditing] = useRouteToggle('rename');
  const [newName, setNewName] = useState(asset.sample ? asset.file.split('/').pop() : asset.title);
  const [confirmDelete, setConfirmDelete] = useRouteToggle('trashAsset');
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(null),
    ratingStarsRef = useRef(null);
  const [focusAfterRatingClear, setFocusAfterRatingClear] = useState(false);
  const dialog = useDialogFocus({
    onClose: () => {
      if (editing || confirmDelete) {
        updateSearch(setParams, { rename: null, trashAsset: null });
      } else {
        onClose();
      }
    },
    initialFocus: '.modal-close',
  });
  const separator = project?.folder.includes('\\') ? '\\' : '/';
  const localPath =
    !asset.sample && project
      ? `${project.folder}${separator}${asset.id.replaceAll('/', separator)}`
      : null;
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    setNewName(asset.sample ? asset.file.split('/').pop() : asset.title);
    setMessage('');
    setImagePreviewFailed(false);
  }, [asset.id, asset.file, asset.sample, asset.title]);
  useLayoutEffect(() => {
    if (focusAfterRatingClear && !asset.modelRating) {
      ratingStarsRef.current?.querySelector('button:not(:disabled)')?.focus();
      setFocusAfterRatingClear(false);
    }
  }, [focusAfterRatingClear, asset.modelRating]);
  useEffect(() => {
    const handle = (e) => {
      if (e.key === 'Escape') {
        if (editing || confirmDelete) {
          updateSearch(setParams, { rename: null, trashAsset: null });
        } else {
          onClose();
        }
      } else if (
        !editing &&
        !confirmDelete &&
        !e
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.matches(
                'input,select,textarea,audio,video,[contenteditable="true"],[role="slider"],[role="textbox"]',
              ),
          )
      ) {
        if (e.key === 'ArrowLeft' && position > 0) {
          onStep(-1);
        } else if (e.key === 'ArrowRight' && position < total - 1) {
          onStep(1);
        }
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [position, total, onClose, onStep, editing, confirmDelete, setParams]);
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(localPath);
      setMessage('File path copied.');
    } catch {
      setMessage('Could not copy. Select the path below instead.');
    }
  }
  async function action(type, extra = {}) {
    setBusy(true);
    setMessage('');
    try {
      const result = await onMutate(type, asset, extra);
      if (type === 'rename') {
        updateSearch(setParams, { asset: result.path, rename: null });
        setMessage('Asset renamed.');
      } else if (type === 'rating') {
        setMessage(
          asset.sample
            ? 'Sample rating saved in this browser.'
            : 'Asset rating saved to the project.',
        );
        if (extra.rating === null) {
          setFocusAfterRatingClear(true);
        }
      } else if (type === 'trash') {
        onClose();
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop gallery-backdrop" onClick={onClose}>
      <section
        ref={dialog}
        className="gallery-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${asset.title}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button ref={closeRef} className="modal-close" aria-label="Close preview" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="gallery-preview-media">
          {asset.category === 'Images' || asset.category === 'Masks' ? (
            asset.title.toLowerCase().endsWith('.tga') ? (
              <AssetThumbnail asset={asset} project={project} />
            ) : imagePreviewFailed ? (
              <div className="gallery-image-error" role="status">
                <Image size={30} />
                <strong>Preview unavailable</strong>
                <span>
                  Forge could not load this image. You can still download the file or open its
                  location below.
                </span>
              </div>
            ) : (
              <img src={asset.file} alt={asset.title} onError={() => setImagePreviewFailed(true)} />
            )
          ) : asset.category === 'Video' ? (
            <video key={asset.file} controls src={asset.file} />
          ) : asset.category === '3D' ? (
            <InteractiveAssetViewer key={asset.file} url={asset.file} name={asset.title} />
          ) : asset.category === 'Text' ? (
            <TextAssetPreview asset={asset} />
          ) : (
            <div className="gallery-audio-preview">
              <AudioLines size={50} />
              <strong>{asset.title}</strong>
              <audio key={asset.file} controls src={asset.file}>
                Your browser does not support audio playback.
              </audio>
            </div>
          )}
          {total > 1 && (
            <>
              <button
                className="preview-arrow previous"
                aria-label="Previous asset"
                disabled={position === 0}
                onClick={() => onStep(-1)}
              >
                <ChevronLeft size={22} />
              </button>
              <button
                className="preview-arrow next"
                aria-label="Next asset"
                disabled={position === total - 1}
                onClick={() => onStep(1)}
              >
                <ChevronRight size={22} />
              </button>
            </>
          )}
        </div>
        <div className="gallery-preview-details">
          <div className="gallery-preview-heading">
            <div>
              <span className="mini-label">
                {asset.sample ? 'SAMPLE ASSET' : asset.category.toUpperCase()} · {position + 1} /{' '}
                {total}
              </span>
              <h2>{asset.title}</h2>
              <p>{asset.sample ? asset.description : project?.name}</p>
            </div>
            <a
              href={asset.file}
              download={asset.sample ? asset.file.split('/').pop() : asset.title}
              className="primary"
            >
              <ArrowDownToLine size={15} /> Download
            </a>
          </div>
          <dl className="gallery-details">
            <div>
              <dt>Type</dt>
              <dd>{asset.sample ? asset.detail : asset.category}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{filesize(asset.size)}</dd>
            </div>
            <div>
              <dt>Modified</dt>
              <dd>{date(asset.modified)}</dd>
            </div>
          </dl>
          {localPath && (
            <>
              <div className="gallery-path">
                <div>
                  <span>FILE LOCATION</span>
                  <code>{localPath}</code>
                </div>
                <button
                  className="outline-button gallery-copy-path"
                  aria-label="Copy file location"
                  title="Copy file location"
                  onClick={copyPath}
                >
                  <Copy size={15} /> Copy path
                </button>
              </div>
            </>
          )}
          <div className="asset-rating">
            <div>
              <strong>Rate this asset</strong>
              <p>
                {asset.sample
                  ? 'Sample ratings are saved in this browser.'
                  : 'Ratings are saved with this project, independently of the model.'}
              </p>
            </div>
            <div className="rating-actions">
              <div
                ref={ratingStarsRef}
                className="rating-stars"
                role="group"
                aria-label="Asset rating"
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`Rate ${n} out of 5`}
                    aria-pressed={asset.modelRating === n}
                    disabled={busy}
                    onClick={() => action('rating', { rating: n })}
                  >
                    <Star
                      size={20}
                      fill={n <= (asset.modelRating || 0) ? 'currentColor' : 'none'}
                    />
                  </button>
                ))}
              </div>
              {asset.modelRating && (
                <button
                  className="rating-clear"
                  disabled={busy}
                  onClick={() => action('rating', { rating: null })}
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="asset-management">
            {!asset.sample && canConvert(asset) && (
              <button
                className="outline-button"
                disabled={busy}
                onClick={() => setConverting(!converting)}
              >
                <FileOutput size={15} /> Convert
              </button>
            )}
            <button
              className="outline-button"
              disabled={busy || asset.sample}
              title={asset.sample ? 'Sample files cannot be renamed' : ''}
              onClick={() => updateSearch(setParams, { rename: '1', trashAsset: null })}
            >
              <Pencil size={15} /> Rename
            </button>
            <button
              className="outline-button danger-button"
              disabled={busy}
              onClick={() => updateSearch(setParams, { trashAsset: '1', rename: null })}
            >
              <Trash2 size={15} /> Delete
            </button>
          </div>
          {converting && (
            <AssetConverter
              asset={asset}
              project={project}
              onSaved={onConverted}
              onClose={() => setConverting(false)}
            />
          )}
          {editing && (
            <form
              className="asset-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                action('rename', { name: newName });
              }}
            >
              <label htmlFor="asset-new-name">File name (keep its extension)</label>
              <p>The file stays in this project folder. Keep the same extension.</p>
              <input
                id="asset-new-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <div>
                <button type="button" className="ghost-button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  Save name
                </button>
              </div>
            </form>
          )}
          {confirmDelete && (
            <div className="asset-inline-form">
              <strong>
                {asset.sample
                  ? 'Sample assets cannot be deleted'
                  : 'Move this asset to project trash?'}
              </strong>
              <p>
                {asset.sample
                  ? 'Samples are shared examples.'
                  : 'The file will stay in the project’s hidden trash folder and can be restored.'}
              </p>
              <div>
                <button className="ghost-button" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                {!asset.sample && (
                  <button className="danger-solid" disabled={busy} onClick={() => action('trash')}>
                    Move to trash
                  </button>
                )}
              </div>
            </div>
          )}
          {message && (
            <p className="gallery-copy-message" role="status">
              {message}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
export default function Gallery({ project, projects, onNew, sampleAssets, loading, error }) {
  const [localProject, setLocalProject] = useState(project);
  const [trashUndo, setTrashUndo] = useState(null);
  const [trashMessage, setTrashMessage] = useState('');
  const [params, setParams] = useSearchParams();
  const scope =
    params.get('collection') === 'samples' ? 'samples' : params.get('project') || 'samples';
  const scopeRef = useRef(scope);
  const projectRequestRef = useRef(0);
  scopeRef.current = scope;
  useEffect(() => {
    projectRequestRef.current += 1;
    setLocalProject(project);
  }, [project, scope]);
  const category = categories.includes(params.get('type')) ? params.get('type') : 'All';
  const search = params.get('q') || '';
  const sort = ['newest', 'oldest', 'name'].includes(params.get('sort'))
    ? params.get('sort')
    : 'newest';
  const layout = params.get('view') === 'list' ? 'list' : 'grid';
  const previewId = params.get('asset');
  const [visibleCount, setVisibleCount] = useState(24);
  const change = (values, options) => updateSearch(setParams, values, options);
  const setCategory = (value) => change({ type: value === 'All' ? null : value, asset: null });
  const setSearch = (value) => change({ q: value || null, asset: null }, { replace: true });
  const setSort = (value) => change({ sort: value === 'newest' ? null : value });
  const setLayout = (value) => change({ view: value === 'grid' ? null : value });
  const setPreviewId = (value) =>
    change({ asset: value, convert: null, rename: null, trashAsset: null, inspect: null });
  const [queueOpen, setQueueOpen] = useRouteToggle('queue');
  const [ratings, setRatings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('forge-preview-ratings') || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => {
    setVisibleCount(24);
  }, [scope, category, search, sort]);
  const isSample = scope === 'samples';
  const items = useMemo(() => {
    const values = isSample
      ? sampleAssets.map((a) => ({ ...a, sample: true }))
      : ((localProject?.id === scope ? localProject.assets : []) || []).map((a) => ({
          ...a,
          title: a.name,
          file: a.url,
          sample: false,
        }));
    return values.map((a) => ({
      ...a,
      modelRating: a.sample ? ratings[`${scope}:${a.id}`] || null : a.rating || null,
    }));
  }, [isSample, sampleAssets, localProject, scope, ratings]);
  const count = (type) =>
    type === 'All' ? items.length : items.filter((item) => item.category === type).length;
  const filtered = useMemo(
    () =>
      items
        .filter(
          (item) =>
            (category === 'All' || item.category === category) &&
            `${item.title} ${item.id} ${item.type || ''}`
              .toLowerCase()
              .includes(search.trim().toLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title)
            : sort === 'oldest'
              ? (a.modified || '').localeCompare(b.modified || '')
              : (b.modified || '').localeCompare(a.modified || ''),
        ),
    [items, category, search, sort],
  );
  const previewIndex = filtered.findIndex((item) => item.id === previewId);
  const preview = previewIndex >= 0 ? filtered[previewIndex] : null;
  function setCollection(value) {
    change({
      collection: value === 'samples' ? 'samples' : null,
      project: value === 'samples' ? params.get('project') : value,
      type: null,
      q: null,
      asset: null,
    });
  }
  async function projectPost(action, body) {
    const response = await fetch(`/api/projects/${scope}/assets/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      throw Error(data.error || 'Could not update asset.');
    }
    return data;
  }
  async function reloadProject() {
    const requestedScope = scope;
    const request = ++projectRequestRef.current;
    const response = await fetch('/api/projects');
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    if (request === projectRequestRef.current && requestedScope === scopeRef.current) {
      setLocalProject(data.projects.find((item) => item.id === requestedScope) || null);
    }
  }
  async function changeAsset(action, asset, extra = {}) {
    if (asset.sample && action === 'rating') {
      const key = `${scope}:${asset.id}`;
      setRatings((previous) => {
        const next = { ...previous };
        if (extra.rating === null) {
          delete next[key];
        } else {
          next[key] = extra.rating;
        }
        try {
          localStorage.setItem('forge-preview-ratings', JSON.stringify(next));
        } catch {
          // Ratings still work for this session when browser storage is unavailable.
        }
        return next;
      });
      return;
    }
    if (action === 'rating') {
      await projectPost('metadata', { path: asset.id, rating: extra.rating });
      await reloadProject();
      return;
    }
    if (action === 'rename') {
      const result = await projectPost('rename', { path: asset.id, name: extra.name });
      await reloadProject();
      return result;
    }
    if (action === 'trash') {
      const result = await projectPost('trash', { path: asset.id });
      setTrashUndo({ projectId: scope, trashId: result.trashId });
      setTrashMessage('Asset moved to project trash.');
      await reloadProject().catch(() => {});
      return;
    }
    throw Error('This asset action is unavailable.');
  }
  async function undoTrash() {
    if (!trashUndo) {
      return;
    }
    try {
      const response = await fetch(`/api/projects/${trashUndo.projectId}/assets/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forge-Request': 'project' },
        body: JSON.stringify({ trashId: trashUndo.trashId }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw Error(data.error || 'Could not restore asset.');
      }
      setTrashUndo(null);
      setTrashMessage('Asset restored.');
      if (scope === trashUndo.projectId) {
        await reloadProject();
      }
    } catch (error) {
      setTrashMessage(error.message);
    }
  }

  return (
    <div className="page gallery-page">
      <div className="gallery-top">
        <div>
          <div className="overline">
            <span className="overline-line" /> YOUR COLLECTION
          </div>
          <h1>
            Asset library<em>.</em>
          </h1>
          <p className="lead">Find, preview, and download everything in your project.</p>
        </div>
        <button className="ghost-button gallery-new" onClick={onNew}>
          <Plus size={15} /> New project
        </button>
      </div>
      {error && (
        <p className="project-error" role="alert">
          {error}
        </p>
      )}
      {trashMessage && (
        <p className="iteration-message" role="status">
          {trashMessage} {trashUndo && <button onClick={undoTrash}>Undo</button>}
        </p>
      )}
      <section className="gallery-project-bar">
        <div className="gallery-project-icon">
          <FolderOpen size={19} />
        </div>
        <div className="gallery-project-info">
          <label className="mini-label" htmlFor="gallery-collection">
            Collection
          </label>
          <select
            id="gallery-collection"
            aria-label="Choose collection"
            value={scope}
            onChange={(e) => setCollection(e.target.value)}
          >
            <option value="samples">Sample collection</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="gallery-location">
          <span>{isSample ? 'EXAMPLE ASSETS' : 'PROJECT FOLDER'}</span>
          <strong>
            {isSample ? 'A few pieces to explore' : project?.folder || 'Project unavailable'}
          </strong>
        </div>
        <div className="gallery-total">
          <strong>{items.length}</strong>
          <span>{items.length === 1 ? 'ASSET' : 'ASSETS'}</span>
        </div>
      </section>
      <details className="gallery-queue" {...routeDetails(queueOpen, setQueueOpen)}>
        <summary aria-expanded={queueOpen} aria-controls="gallery-render-queue-content">
          <span className="gallery-queue-title">Render queue</span>
          <span className="gallery-queue-summary">Manage jobs across projects</span>
          <ChevronDown className="gallery-queue-chevron" size={17} aria-hidden="true" />
        </summary>
        <div id="gallery-render-queue-content" className="gallery-queue-content">
          <RuntimeQueue projects={projects} expanded />
        </div>
      </details>
      <div className="gallery-toolbar">
        <div className="gallery-search">
          <label className="sr-only gallery-control-label" htmlFor="gallery-search">
            Search
          </label>
          <Search size={17} />
          <input
            id="gallery-search"
            aria-label="Search assets"
            placeholder="Search names or paths…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button aria-label="Clear search" onClick={() => setSearch('')}>
              <X size={15} />
            </button>
          )}
        </div>
        <label className="gallery-sort">
          <span className="sr-only gallery-control-label">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort assets">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
        <div className="layout-switch" role="group" aria-label="Display layout">
          <span className="sr-only gallery-control-label">View</span>
          <button
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      <div className="gallery-filter-row">
        <div className="filter-tabs" role="group" aria-label="Asset type">
          {categories.map((c) => (
            <button
              key={c}
              className={category === c ? 'selected' : ''}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c} <span>{count(c)}</span>
            </button>
          ))}
        </div>
        <span className="gallery-results" role="status" aria-live="polite" aria-atomic="true">
          {filtered.length} {filtered.length === 1 ? 'asset' : 'assets'}
        </span>
      </div>
      {loading && !isSample ? (
        <div className="gallery-empty" role="status" aria-live="polite">
          Loading project assets…
        </div>
      ) : filtered.length === 0 ? (
        <div className="gallery-empty">
          <div className="gallery-empty-icon">
            <FolderOpen size={24} aria-hidden="true" />
          </div>
          <h2>{items.length ? 'No matching assets' : 'No assets in this collection yet.'}</h2>
          <p>
            {items.length
              ? 'Try another search or asset type.'
              : isSample
                ? 'Sample assets are unavailable.'
                : 'Add supported files to this project folder and they will appear here.'}
          </p>
          {(search || category !== 'All') && (
            <button
              className="outline-button"
              onClick={() => change({ q: null, type: null, asset: null })}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className={layout === 'grid' ? 'gallery-grid' : 'gallery-list'}>
            {filtered.slice(0, visibleCount).map((asset) => {
              const Icon = iconFor(asset.category);
              return (
                <button
                  className="gallery-card"
                  key={asset.id}
                  onClick={() => setPreviewId(asset.id)}
                >
                  <div
                    className={
                      'gallery-thumb ' +
                      (asset.category === 'Audio'
                        ? 'gallery-audio-thumb'
                        : asset.category === 'Text'
                          ? 'gallery-text-thumb'
                          : '')
                    }
                  >
                    {isVisualAsset(asset) ? (
                      <AssetThumbnail asset={asset} project={asset.sample ? null : localProject} />
                    ) : asset.category === 'Text' ? (
                      <FileText size={37} />
                    ) : (
                      <>
                        <AudioLines size={37} />
                        <div className="gallery-wave">
                          {[12, 24, 36, 20, 32, 44, 26, 37, 21, 33, 15].map((height, i) => (
                            <i key={i} style={{ height }} />
                          ))}
                        </div>
                      </>
                    )}
                    <span className="gallery-badge">
                      {asset.sample ? 'SAMPLE' : asset.category.toUpperCase()}
                    </span>
                  </div>
                  <div className="gallery-card-info">
                    <div className="gallery-card-title">
                      <strong title={asset.title}>{asset.title}</strong>
                      <Icon size={16} />
                    </div>
                    <span title={asset.sample ? asset.detail : asset.id}>
                      {asset.sample ? asset.detail : asset.id}
                    </span>
                    <small>
                      {asset.modified ? date(asset.modified) : 'Example asset'}
                      {asset.size !== null && asset.size !== undefined
                        ? ` · ${filesize(asset.size)}`
                        : ''}
                    </small>
                  </div>
                </button>
              );
            })}
          </div>
          {visibleCount < filtered.length && (
            <button
              className="outline-button gallery-more"
              onClick={() => setVisibleCount((n) => n + 24)}
            >
              Show more · {filtered.length - visibleCount} remaining
            </button>
          )}
        </>
      )}
      {!isSample && (
        <ProjectTrash
          key={scope}
          projectId={scope}
          revision={localProject}
          onChanged={async () => {
            setTrashUndo(null);
            await reloadProject();
          }}
        />
      )}
      <p className="gallery-footnote">
        {isSample
          ? 'Examples are separate from your projects.'
          : 'Project files refresh automatically. Connected renders are saved here when they finish.'}
      </p>
      {preview && (
        <AssetPreview
          asset={preview}
          position={previewIndex}
          total={filtered.length}
          project={isSample ? null : localProject}
          onMutate={changeAsset}
          onConverted={reloadProject}
          onClose={() => setPreviewId(null)}
          onStep={(offset) => setPreviewId(filtered[previewIndex + offset]?.id || previewId)}
        />
      )}
    </div>
  );
}
