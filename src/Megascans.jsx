import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ExternalLink, Plus, Search } from 'lucide-react';
import { updateSearch } from './useNav';
import { ListingDialog, ListingFormDialog } from './MegascansDialogs';
import { ImportsPanel, useImportQueue } from './MegascansImports';
import { FabCacheBar, useFabCache } from './MegascansFab';
import ModelList from './MegascansList';
import { LicencesAndTerms } from './MegascansLegal';
import {
  DEFAULT_SORT,
  FAB_SELLER_URL,
  SORTS,
  UPLOAD_ACCEPT,
  checkChosenFile,
  uploadImportFile,
} from './megascans-api';
import './megascans.css';

const SEARCH_DELAY_MS = 250;

/**
 * The Megascans page. Listings come from a local cache of Fab's public data (filled slowly and
 * only on request), plus references the user typed. Imports are files the user downloaded
 * themselves (docs/MEGASCANS.md).
 */
export default function Megascans({ project, projects = [], onSelect, onRefresh, onOpenLibrary }) {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') || '';
  const tag = params.get('tag') || '';
  const sort = SORTS.some(([id]) => id === params.get('sort')) ? params.get('sort') : DEFAULT_SORT;
  const page = Math.max(Number.parseInt(params.get('page') || '1', 10) || 1, 1);
  const listingId = params.get('listing') || '';
  const adding = params.get('add') === '1';
  const [editing, setEditing] = useState(null);
  const [searchText, setSearchText] = useState(query);
  const [tags, setTags] = useState([]);
  const [reload, setReload] = useState(0);
  const [uploads, setUploads] = useState([]);
  const [announcement, setAnnouncement] = useState('');
  const queue = useImportQueue();
  const cache = useFabCache({ onChanged: () => setReload((value) => value + 1) });
  const fileInput = useRef(null);
  const pendingListing = useRef(null);
  const uploadSequence = useRef(0);
  const aborters = useRef(new Map());
  const { refresh: refreshQueue } = queue;
  const consent = {
    downloads: cache.fab?.downloads,
    busy: cache.busy === 'confirm',
    onConfirm: cache.confirmDownloads,
    onWithdraw: cache.withdrawDownloads,
  };

  useEffect(() => {
    setSearchText(query);
  }, [query]);

  useEffect(() => {
    if (searchText === query) {
      return undefined;
    }
    const timer = setTimeout(
      () =>
        updateSearch(setParams, { q: searchText.trim() || null, page: null }, { replace: true }),
      SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [searchText, query, setParams]);

  useEffect(
    () => () => {
      for (const abort of aborters.current.values()) {
        abort();
      }
    },
    [],
  );

  const patch = useCallback(
    (changes, options) => updateSearch(setParams, changes, options),
    [setParams],
  );

  const startUpload = useCallback(
    async (file, forListingId) => {
      if (!project) {
        setAnnouncement('Choose a project before importing a file.');
        return;
      }
      const problem = checkChosenFile(file);
      const key = `upload-${++uploadSequence.current}`;
      if (problem) {
        setUploads((current) => [
          ...current,
          { key, name: file?.name || 'File', loaded: 0, total: 0, error: problem },
        ]);
        return;
      }
      setUploads((current) => [...current, { key, name: file.name, loaded: 0, total: file.size }]);
      const request = uploadImportFile({
        file,
        projectId: project.id,
        listingId: forListingId,
        onProgress: (loaded, total) =>
          setUploads((current) =>
            current.map((item) => (item.key === key ? { ...item, loaded, total } : item)),
          ),
      });
      aborters.current.set(key, request.abort);
      try {
        await request.promise;
        setUploads((current) => current.filter((item) => item.key !== key));
        setAnnouncement(`${file.name} was queued for import into ${project.name}.`);
        refreshQueue();
        setReload((value) => value + 1);
      } catch (error) {
        if (error?.name === 'AbortError') {
          setUploads((current) => current.filter((item) => item.key !== key));
        } else {
          setUploads((current) =>
            current.map((item) => (item.key === key ? { ...item, error: error.message } : item)),
          );
        }
      } finally {
        aborters.current.delete(key);
      }
    },
    [project, refreshQueue],
  );

  function chooseFile(forListing) {
    pendingListing.current = forListing?.id || null;
    fileInput.current?.click();
  }

  function handleFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      startUpload(file, pendingListing.current);
    }
  }

  return (
    <div className="page megascans-page">
      <div className="overline">
        <span className="overline-line" /> LIBRARY · FAB
      </div>
      <h1>
        Megascans<em>.</em>
      </h1>
      <p className="lead">
        Browse the free Quixel Megascans 3D models that Fab lists, then import the files you
        download into a project.
      </p>

      <section className="panel megascans-how" aria-labelledby="megascans-how-title">
        <div className="megascans-how-text">
          <span className="mini-label">FREE 3D MODELS ONLY</span>
          <h2 id="megascans-how-title">Find models here, download on Fab, import into a project</h2>
          <p>
            Forge reads the free Megascans 3D models that Fab lists, slowly and one request at a
            time, and keeps them on this computer so you can search offline. Open a model to see its
            files and download one: after you confirm Fab&apos;s license agreement once, Forge
            fetches the file, checks it, unpacks it safely and saves it in your project with its
            source, licence and attribution.
          </p>
          <ol className="megascans-steps">
            <li>Search the models below, or press Refresh or Scan catalog to read more.</li>
            <li>Open a model and press Download on a file (GLB at mid quality is recommended).</li>
            <li>Prefer to download yourself? Choose Open on Fab, then Import file.</li>
          </ol>
          <p className="helper">
            Megascans on Fab use Fab&apos;s licence. You are responsible for following the Fab and
            Epic terms for what you download and how you use it.
          </p>
        </div>
        <a
          className="primary megascans-browse"
          href={FAB_SELLER_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={16} aria-hidden="true" /> Browse Megascans on Fab
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </section>

      <div className="megascans-project">
        <label className="field-label" htmlFor="megascans-project-select">
          Import into project
        </label>
        <select
          id="megascans-project-select"
          value={project?.id || ''}
          disabled={!projects.length}
          onChange={(event) => onSelect?.(event.target.value)}
        >
          {!project && (
            <option value="">{projects.length ? 'Choose a project…' : 'No projects yet'}</option>
          )}
          {projects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChosen}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <section className="panel megascans-library" aria-labelledby="megascans-library-title">
        <div className="panel-heading">
          <div>
            <span className="mini-label">FREE MEGASCANS 3D MODELS · CACHED ON THIS COMPUTER</span>
            <h2 id="megascans-library-title">Models</h2>
          </div>
          <button type="button" className="primary" onClick={() => patch({ add: '1' })}>
            <Plus size={16} aria-hidden="true" /> Add by address
          </button>
        </div>
        <div className="megascans-toolbar" role="search">
          <div className="megascans-field megascans-search">
            <label className="field-label" htmlFor="megascans-search">
              Search models
            </label>
            <div className="megascans-search-box">
              <Search size={15} aria-hidden="true" />
              <input
                id="megascans-search"
                type="search"
                value={searchText}
                placeholder="Title, tag or note"
                autoComplete="off"
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
          </div>
          <div className="megascans-field">
            <label className="field-label" htmlFor="megascans-tag">
              Tag
            </label>
            <select
              id="megascans-tag"
              value={tag}
              onChange={(event) => patch({ tag: event.target.value || null, page: null })}
            >
              <option value="">All tags</option>
              {tag && !tags.some((item) => item.tag === tag) && <option value={tag}>{tag}</option>}
              {tags.map((item) => (
                <option key={item.tag} value={item.tag}>
                  {item.tag} ({item.count})
                </option>
              ))}
            </select>
          </div>
          <div className="megascans-field">
            <label className="field-label" htmlFor="megascans-sort">
              Sort by
            </label>
            <select
              id="megascans-sort"
              value={sort}
              onChange={(event) =>
                patch({
                  sort: event.target.value === DEFAULT_SORT ? null : event.target.value,
                  page: null,
                })
              }
            >
              {SORTS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <FabCacheBar cache={cache} query={query} />
        <ModelList
          query={query}
          tag={tag}
          sort={sort}
          initialPages={page}
          reloadKey={reload}
          cache={cache}
          canImport={Boolean(project)}
          onOpen={(id) => patch({ listing: id })}
          onImport={chooseFile}
          onPages={(pages) => patch({ page: pages > 1 ? pages : null }, { replace: true })}
          onTags={setTags}
          onRetry={() => setReload((value) => value + 1)}
          onClear={() => {
            setSearchText('');
            patch({ q: null, tag: null, page: null });
          }}
        />
      </section>

      <ImportsPanel
        queue={queue}
        uploads={uploads}
        projects={projects}
        project={project}
        onChooseFile={chooseFile}
        onDropFile={(file) => startUpload(file, null)}
        onCancelUpload={(upload) => aborters.current.get(upload.key)?.()}
        onDismissUpload={(upload) =>
          setUploads((current) => current.filter((item) => item.key !== upload.key))
        }
        onOpenLibrary={() => {
          onRefresh?.();
          onOpenLibrary?.();
        }}
        consent={consent}
      />

      <footer className="megascans-footer">
        <LicencesAndTerms headingId="megascans-footer-legal-title" />
        <p className="megascans-footnote">
          Fab data is fetched slowly and cached locally; downloads start only after you confirm
          Fab&apos;s license agreement.
        </p>
      </footer>

      {adding && (
        <ListingFormDialog
          onClose={() => patch({ add: null })}
          onSaved={(listing) => {
            patch({ add: null });
            setReload((value) => value + 1);
            setAnnouncement(`${listing.title} was saved to the library.`);
          }}
        />
      )}
      {editing && (
        <ListingFormDialog
          listing={editing}
          onClose={() => setEditing(null)}
          onSaved={(listing) => {
            setEditing(null);
            setReload((value) => value + 1);
            setAnnouncement(`${listing.title} was updated.`);
          }}
        />
      )}
      {listingId && !editing && (
        <ListingDialog
          key={listingId}
          listingId={listingId}
          project={project}
          consent={consent}
          onQueued={(file) => {
            refreshQueue();
            setAnnouncement(`${file.name} was queued for download.`);
          }}
          onClose={() => patch({ listing: null })}
          onEdit={setEditing}
          onImport={(listing) => chooseFile(listing)}
          onRemoved={() => {
            patch({ listing: null });
            setReload((value) => value + 1);
            setAnnouncement('The listing was removed from the library.');
          }}
        />
      )}
    </div>
  );
}
