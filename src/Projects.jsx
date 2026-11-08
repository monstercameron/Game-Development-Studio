import AssetThumbnail, { isVisualAsset } from './AssetThumbnail';
import './project-gallery-refinement.css';
import './projects-ux.css';
import { useState } from 'react';
import useDialogFocus from './useDialogFocus';
import {
  ArrowRight,
  AudioLines,
  Box,
  Clapperboard,
  FileText,
  FolderOpen,
  Image,
  LoaderCircle,
  Plus,
  X,
} from 'lucide-react';

function projectAssetIcon(category, size = 13) {
  const Icon =
    category === 'Audio'
      ? AudioLines
      : category === '3D'
        ? Box
        : category === 'Text'
          ? FileText
          : category === 'Video'
            ? Clapperboard
            : Image;
  return <Icon size={size} />;
}

export function RecentProjects({ projects, loading, onNew, onOpen, onViewAll }) {
  const visibleProjectCount = Math.min(projects.length, 6);
  const projectLayout =
    visibleProjectCount === 1 ? 'single' : visibleProjectCount === 2 ? 'pair' : 'collection';

  return (
    <section className="recent-projects">
      <div className="section-title">
        <div>
          <span className="mini-label">YOUR PROJECTS</span>
          <h2>Recent projects</h2>
          <p>Keep each game’s assets together in its own project.</p>
        </div>
        <div className="recent-projects-actions">
          <button className="ghost-button recent-projects-all" onClick={onViewAll}>
            <FolderOpen size={15} /> View project assets
          </button>
          <button className="primary" onClick={onNew}>
            <Plus size={16} /> New project
          </button>
        </div>
      </div>
      {loading ? (
        <div className="project-empty">
          <LoaderCircle size={16} className="motion-spinner" />
          <span>Loading projects…</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="project-empty">
          <div className="project-empty-icon">
            <FolderOpen size={22} />
          </div>
          <div>
            <strong>Start with a project.</strong>
            <span>Its folder keeps assets for this game together on your computer.</span>
          </div>
          <button className="outline-button" onClick={onNew}>
            Create project <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <div
          className={'project-grid project-grid--' + projectLayout}
          data-project-count={visibleProjectCount}
        >
          {projects.slice(0, 6).map((project, index) => (
            <button className="project-card" key={project.id} onClick={() => onOpen(project)}>
              <div className={'project-cover project-cover-' + (index % 3)}>
                {project.assets.find((a) => isVisualAsset(a)) ? (
                  <AssetThumbnail
                    asset={project.assets.find((a) => isVisualAsset(a))}
                    project={project}
                  />
                ) : (
                  <>
                    <div className="project-orbit" />
                    <span className="project-cover-icon">
                      <FolderOpen size={26} />
                    </span>
                  </>
                )}
                <div className="project-arrow">
                  <ArrowRight size={16} />
                </div>
              </div>
              <div className="project-content">
                <div>
                  <strong title={project.name}>{project.name}</strong>
                  <span>Updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                </div>
                <small>
                  {project.assets.length} {project.assets.length === 1 ? 'asset' : 'assets'}
                </small>
              </div>
              <div className="project-assets">
                {project.assets.length ? (
                  project.assets.slice(0, 3).map((asset) => (
                    <span key={asset.id} title={asset.name}>
                      {projectAssetIcon(asset.category)} {asset.name}
                    </span>
                  ))
                ) : (
                  <span>
                    <Plus size={13} /> Ready for your first asset
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function NewProjectDialog({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        onClose();
      }
    },
    initialFocus: '#project-name',
  });
  async function submit(event) {
    event.preventDefault();
    if (!name.trim()) {
      setError('Enter a project name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onCreate(name.trim());
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        ref={dialog}
        className="settings-modal new-project-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create project"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="mini-label">PROJECT SETUP</span>
            <h2>Create a project</h2>
            <p>Keep a game’s assets together in one place.</p>
          </div>
          <button
            className="icon-btn"
            aria-label="Close project dialog"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="project-name">
            Project name
          </label>
          <input
            id="project-name"
            maxLength={80}
            placeholder="e.g. Tales of the Mistwood"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="helper">
            Forge creates a project folder and asset subfolders on this computer.
          </p>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
          <div className="project-dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              <Plus size={16} />
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function ProjectAssets({ project, projects, onSelect, onNew, onPreview }) {
  return (
    <section className="project-library">
      <div className="project-library-heading">
        <div>
          <span className="mini-label">YOUR PROJECT</span>
          <h2>{project ? project.name : 'Choose a project'}</h2>
          <p>
            {project ? project.folder : 'Create or select a project to keep its files together.'}
          </p>
        </div>
        <div className="project-library-controls">
          <select
            aria-label="Choose project"
            value={project?.id || ''}
            onChange={(e) => onSelect(e.target.value || null)}
          >
            <option value="">Select a project</option>
            {projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="outline-button" onClick={onNew}>
            <Plus size={15} /> New project
          </button>
        </div>
      </div>
      {!project ? (
        <div className="project-library-empty">
          <FolderOpen size={20} />
          <span>Your project's files will appear here.</span>
        </div>
      ) : project.assets.length === 0 ? (
        <div className="project-library-empty">
          <FolderOpen size={20} />
          <span>No assets yet. Files added to this project's folders will appear here.</span>
        </div>
      ) : (
        <div className="asset-grid project-asset-grid">
          {project.assets.map((asset) => (
            <button
              className="asset-card"
              key={asset.id}
              onClick={() =>
                onPreview({
                  title: asset.name,
                  category: asset.category,
                  file: asset.url,
                  type: asset.category,
                  detail: asset.id,
                  description: `Saved in ${project.name}`,
                  sample: false,
                })
              }
            >
              <div
                className={'asset-thumbnail ' + (asset.category === 'Audio' ? 'audio-thumb' : '')}
              >
                {isVisualAsset(asset) ? (
                  <AssetThumbnail asset={asset} project={project} />
                ) : asset.category === 'Audio' ? (
                  <AudioLines size={46} />
                ) : (
                  projectAssetIcon(asset.category, 46)
                )}
              </div>
              <div className="asset-copy">
                <span>PROJECT ASSET</span>
                <strong>{asset.name}</strong>
                <small>{asset.id}</small>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
