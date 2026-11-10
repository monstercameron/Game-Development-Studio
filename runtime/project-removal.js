// Move whole projects out of the active collection without destroying their files.
// The queue worker calls these synchronous operations so no render enqueue can interleave with
// the queue check and move. The trash stays on the same volume for an atomic directory rename.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from './app-log.js';

const log = createLogger('projects');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TRASH = '.forge-project-trash';
const RECORD = '.forge-trash-record.json';
const META = '.forge-project.json';

function realDirectory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Error('Project folder is not a real directory.');
  }
  return fs.realpathSync(folder);
}

function trashRoot(projectsRoot, create = false) {
  const root = realDirectory(projectsRoot);
  const folder = path.join(root, TRASH);
  if (create) {
    fs.mkdirSync(folder, { recursive: true });
  }
  const real = realDirectory(folder);
  if (path.dirname(real) !== root) {
    throw Error('Invalid project trash folder.');
  }
  return real;
}

function readRecord(folder) {
  const stat = fs.lstatSync(path.join(folder, RECORD));
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Error('Invalid project trash record.');
  }
  const record = JSON.parse(fs.readFileSync(path.join(folder, RECORD), 'utf8'));
  if (
    !UUID.test(record.id || '') ||
    typeof record.name !== 'string' ||
    typeof record.originalFolder !== 'string' ||
    !record.originalFolder ||
    path.basename(record.originalFolder) !== record.originalFolder ||
    ['.', '..', TRASH].includes(record.originalFolder)
  ) {
    throw Error('Invalid project trash record.');
  }
  return record;
}

/** Atomically moves a confirmed, idle project and every file in its folder to project trash. */
export function trashProject(projectsRoot, folder, projectId, confirmation) {
  if (!UUID.test(projectId || '')) {
    throw Error('A valid project ID is required.');
  }
  const root = realDirectory(projectsRoot);
  const project = realDirectory(folder);
  if (path.dirname(project) !== root || path.basename(project) === TRASH) {
    throw Error('Invalid project folder.');
  }
  const metadataPath = path.join(project, META);
  const metadataStat = fs.lstatSync(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw Error('Invalid project metadata.');
  }
  const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (meta.id !== projectId || typeof meta.name !== 'string' || confirmation !== meta.name) {
    throw Error('Type the exact project name to confirm.');
  }
  const trash = trashRoot(root, true);
  const trashId = randomUUID();
  const wrapper = path.join(trash, trashId);
  fs.mkdirSync(wrapper);
  try {
    fs.writeFileSync(
      path.join(wrapper, RECORD),
      JSON.stringify({
        id: projectId,
        name: meta.name,
        originalFolder: path.basename(project),
        trashedAt: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
    fs.renameSync(project, path.join(wrapper, 'project'));
  } catch (error) {
    // Never recursively delete on failure; retain anything unexpected for manual recovery.
    try {
      fs.unlinkSync(path.join(wrapper, RECORD));
      fs.rmdirSync(wrapper);
    } catch (cleanupError) {
      log.warn('projects.trash.cleanup.failed', { errorClass: cleanupError?.name });
    }
    throw error;
  }
  return { trashId, name: meta.name };
}

/** Lists recoverable projects; incomplete records are ignored and kept on disk. */
export function listProjectTrash(projectsRoot) {
  let trash;
  try {
    trash = trashRoot(projectsRoot);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const items = [];
  for (const entry of fs.readdirSync(trash, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID.test(entry.name)) {
      continue;
    }
    try {
      const folder = path.join(trash, entry.name);
      if (path.dirname(realDirectory(folder)) !== trash) {
        continue;
      }
      const record = readRecord(folder);
      if (path.dirname(realDirectory(path.join(folder, 'project'))) !== folder) {
        continue;
      }
      items.push({ trashId: entry.name, name: record.name, trashedAt: record.trashedAt });
    } catch (error) {
      // Keep incomplete or unreadable records on disk for manual recovery.
      log.warn('projects.trash.record.unreadable', { errorClass: error?.name });
    }
  }
  return items;
}

/** Restores a trashed project only when its original folder is still unoccupied. */
export function restoreProject(projectsRoot, trashId) {
  if (!UUID.test(trashId || '')) {
    throw Error('Invalid project trash ID.');
  }
  const root = realDirectory(projectsRoot);
  const trash = trashRoot(root);
  const wrapper = realDirectory(path.join(trash, trashId));
  if (path.dirname(wrapper) !== trash) {
    throw Error('Invalid project trash folder.');
  }
  const record = readRecord(wrapper);
  const project = realDirectory(path.join(wrapper, 'project'));
  if (path.dirname(project) !== wrapper) {
    throw Error('Invalid project trash folder.');
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(project, META), 'utf8'));
  if (metadata.id !== record.id || metadata.name !== record.name) {
    throw Error('Project identity changed.');
  }
  // Reject a duplicate project identity even if somebody copied the original folder elsewhere.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === TRASH) {
      continue;
    }
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(root, entry.name, META), 'utf8'));
      if (existing.id === record.id) {
        throw Error('A project with this identity already exists.');
      }
    } catch (error) {
      if (error.message === 'A project with this identity already exists.') {
        throw error;
      }
      log.debug('projects.trash.identity.skipped', { errorClass: error?.name });
    }
  }
  const target = path.join(root, record.originalFolder);
  try {
    fs.lstatSync(target);
    throw Error('The original project folder is already in use. Rename it before restoring.');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  fs.renameSync(project, target);
  // Failure to remove an empty record must not undo a successful restore.
  try {
    fs.unlinkSync(path.join(wrapper, RECORD));
    fs.rmdirSync(wrapper);
  } catch (error) {
    log.warn('projects.trash.cleanup.failed', { errorClass: error?.name });
  }
  return { projectId: record.id, name: record.name };
}
