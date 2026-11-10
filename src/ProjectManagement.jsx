import { useEffect, useState } from 'react';
import { ArchiveRestore, Trash2, X } from 'lucide-react';
import { useSearchParams } from 'react-router';
import ConfirmDialog from './ConfirmDialog';
import useDialogFocus from './useDialogFocus';
import { updateSearch } from './useNav';
import { t, useT } from './i18n/index.js';
import './project-management.css';

async function request(path, body, requestKind = 'runtime') {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forge-Request': requestKind },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Error(result.error || t('projects.manage.requestFailed', 'The project request failed.'));
  }
  return result;
}

function ProjectTrashDialog({ onClose, onRestored }) {
  const { t } = useT();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useDialogFocus({
    onClose: () => {
      if (!busy) {
        onClose();
      }
    },
    initialFocus: '.project-trash-close',
  });
  useEffect(() => {
    let active = true;
    request('/api/runtime/projects/trash').then(
      (result) => {
        if (active) {
          setProjects(result.projects);
        }
      },
      (failure) => {
        if (active) {
          setError(failure.message);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  async function restore(trashId) {
    setBusy(true);
    setError('');
    try {
      await request('/api/runtime/projects/restore', { trashId });
      await onRestored();
      setProjects((items) => items.filter((item) => item.trashId !== trashId));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        ref={dialog}
        className="settings-modal project-management-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trash-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <h2 id="project-trash-title">{t('projects.trash.title', 'Deleted projects')}</h2>
            <p>
              {t(
                'projects.trash.description',
                'Projects here retain their files on disk and can be restored.',
              )}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn project-trash-close"
            onClick={onClose}
            disabled={busy}
            aria-label={t('common.action.close', 'Close')}
          >
            <X size={20} />
          </button>
        </div>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        {!projects && !error && (
          <p role="status">{t('projects.trash.loading', 'Loading deleted projects…')}</p>
        )}
        {projects?.length === 0 && <p>{t('projects.trash.empty', 'No deleted projects.')}</p>}
        <ul className="project-management-list">
          {projects?.map((item) => (
            <li key={item.trashId}>
              <strong>{item.name}</strong>
              <button
                type="button"
                className="outline-button"
                disabled={busy}
                onClick={() => restore(item.trashId)}
              >
                <ArchiveRestore size={16} /> {t('projects.trash.restore', 'Restore project')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Manage the selected project and recover whole project folders from trash. */
export default function ProjectManagement({ project, onChanged, onRemoved }) {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const mode = params.get('projectManage');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const change = (value) => updateSearch(setParams, { projectManage: value });
  const close = () => {
    if (!busy) {
      change(null);
    }
  };
  useEffect(() => {
    setConfirmation('');
    setError('');
  }, [mode, project?.id]);
  async function removeAssets() {
    if (!project || confirmation !== project.name) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await request(
        `/api/projects/${project.id}/assets/trash-all`,
        { confirmation },
        'project',
      );
      await onChanged();
      if (result.failures.length) {
        setError(
          t(
            'projects.assets.partial',
            '{moved} assets moved; {failed} could not be moved. Check the asset library and try again.',
            { moved: result.moved, failed: result.failures.length },
          ),
        );
        setConfirmation('');
      } else {
        change(null);
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!project || confirmation !== project.name) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request('/api/runtime/projects/trash', { projectId: project.id, confirmation });
      await onRemoved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-management-actions">
      {project && (
        <button type="button" className="ghost-button" onClick={() => change('assets')}>
          <Trash2 size={16} /> {t('projects.manage.deleteAssets', 'Delete all project assets…')}
        </button>
      )}
      {project && (
        <button type="button" className="ghost-button" onClick={() => change('delete')}>
          <Trash2 size={16} /> {t('projects.manage.delete', 'Delete project…')}
        </button>
      )}
      <button type="button" className="ghost-button" onClick={() => change('trash')}>
        <ArchiveRestore size={16} /> {t('projects.manage.trash', 'Deleted projects')}
      </button>
      {mode === 'delete' && project && (
        <ConfirmDialog
          title={t('projects.delete.title', 'Delete {name}?', { name: project.name })}
          kicker={t('projects.delete.kicker', 'Whole project')}
          confirmLabel={t('projects.delete.confirm', 'Move project to trash')}
          busyLabel={t('projects.delete.busy', 'Moving project…')}
          error={error}
          busy={busy}
          tone="danger"
          confirmDisabled={confirmation !== project.name}
          onClose={close}
          onConfirm={remove}
        >
          <p>
            {t(
              'projects.delete.explanation',
              'The entire project folder, including all its files, moves to project trash. You can restore it later; it continues to use disk space.',
            )}
          </p>
          <p>
            {t(
              'projects.delete.jobs',
              'Finish or resolve the project’s renders and imports first. Model files and other projects are not affected.',
            )}
          </p>
          <label className="project-management-confirmation">
            {t('projects.delete.typeName', 'Type the exact project name to confirm')}
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
        </ConfirmDialog>
      )}
      {mode === 'assets' && project && (
        <ConfirmDialog
          title={t('projects.assets.title', 'Delete all assets in {name}?', { name: project.name })}
          kicker={t('projects.assets.kicker', 'Project assets')}
          confirmLabel={t('projects.assets.confirm', 'Move assets to trash')}
          busyLabel={t('projects.assets.busy', 'Moving assets…')}
          error={error}
          busy={busy}
          tone="danger"
          confirmDisabled={confirmation !== project.name}
          onClose={close}
          onConfirm={removeAssets}
        >
          <p>
            {t(
              'projects.assets.explanation',
              'Moves the recognized assets currently in this project to asset trash, where you can restore them. The project stays. Hidden and unsupported files are not included.',
            )}
          </p>
          <p>
            {t(
              'projects.assets.jobs',
              'Finish active renders and imports first; new files can still be added while this runs.',
            )}
          </p>
          <label className="project-management-confirmation">
            {t('projects.delete.typeName', 'Type the exact project name to confirm')}
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={busy}
            />
          </label>
        </ConfirmDialog>
      )}
      {mode === 'trash' && <ProjectTrashDialog onClose={close} onRestored={onChanged} />}
    </div>
  );
}
