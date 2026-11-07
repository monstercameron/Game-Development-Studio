import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultModelsRoot, managedModels } from './model-inventory.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeErrorCode = (error) =>
  typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/i.test(error.code) ? error.code : 'UNKNOWN';

async function checkedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw Error('Model storage contains a link or unexpected directory.');
  }
}
async function ensureNoLinks(directory) {
  const stack = [directory];
  while (stack.length) {
    const dir = stack.pop();
    await checkedDirectory(dir);
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name),
        stat = await fs.lstat(item);
      if (stat.isSymbolicLink()) {
        throw Error('Model folder contains a link. Remove or review the link before deleting.');
      }
      if (stat.isDirectory()) {
        stack.push(item);
      } else if (!stat.isFile()) {
        throw Error('Model folder contains an unsupported file type.');
      }
    }
  }
}
async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

// A fixed manifest defines both the target and the service. The journal is
// written before the atomic rename, so a process crash can only resume a
// previously authorized staged deletion, never delete a newly installed model.
export class ModelRemoval {
  constructor({
    root = defaultModelsRoot,
    stateDir,
    models = managedModels,
    checkStopped = async () => {},
    remove = fs.rm,
    rename = fs.rename,
    logger = () => {},
  }) {
    this.root = path.resolve(root);
    this.stateDir = path.resolve(stateDir);
    this.models = models;
    this.checkStopped = checkStopped;
    this.remove = remove;
    this.rename = rename;
    this.log = logger;
    this.active = new Set();
    this.operations = new Map();
    this.ready = this.recover();
    // A damaged journal must not crash the service before a caller can report it.
    this.ready.catch((error) => this.log(`Model removal recovery unavailable: ${error.message}`));
  }
  model(id) {
    const value = this.models.find((model) => model.id === id);
    if (
      !value ||
      value.removable === false ||
      id === 'sam3-base' ||
      !/^[-a-z0-9]+$/.test(id) ||
      typeof value.folder !== 'string' ||
      value.folder === '.' ||
      value.folder === '..' ||
      path.basename(value.folder) !== value.folder
    ) {
      throw Error('This model is not available for managed removal.');
    }
    return value;
  }
  journal(id) {
    return path.join(this.stateDir, `${id}.json`);
  }
  staged(id, operation) {
    return path.join(this.root, `.forge-deleting-${id}-${operation}`);
  }
  isActive(id) {
    return this.active.has(id);
  }
  status(id) {
    const value = this.operations.get(id);
    return value ? { ...value } : null;
  }
  async writeJournal(value) {
    await fs.mkdir(this.stateDir, { recursive: true });
    await checkedDirectory(this.stateDir);
    const dest = this.journal(value.id),
      temp = path.join(this.stateDir, `.${value.id}-${randomUUID()}.tmp`);
    const file = await fs.open(temp, 'wx');
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(temp, dest);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  async recover() {
    let names;
    try {
      names = await fs.readdir(this.stateDir);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await checkedDirectory(this.stateDir);
    await checkedDirectory(this.root);
    for (const name of names) {
      if (!/^[-a-z0-9]+\.json$/.test(name)) {
        continue;
      }
      try {
        const journalPath = path.join(this.stateDir, name),
          stat = await fs.lstat(journalPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          continue;
        }
        const item = JSON.parse(await fs.readFile(journalPath, 'utf8'));
        this.model(item.id);
        if (
          name !== `${item.id}.json` ||
          !uuid.test(item.operation) ||
          !['prepared', 'deleting', 'failed', 'complete', 'cancelled'].includes(item.state)
        ) {
          continue;
        }
        this.operations.set(item.id, item);
        if (['complete', 'cancelled'].includes(item.state)) {
          continue;
        }
        const staged = this.staged(item.id, item.operation);
        if (await exists(staged)) {
          this.active.add(item.id);
          this.purge(item, staged).catch((error) =>
            this.log(`Model removal recovery: ${error.message}`),
          );
        } else {
          const original = path.join(this.root, this.model(item.id).folder);
          item.state = (await exists(original)) ? 'cancelled' : 'complete';
          item.error =
            item.state === 'cancelled'
              ? 'Removal was interrupted before files were staged. Retry if needed.'
              : null;
          await this.writeJournal(item);
        }
      } catch (error) {
        this.log(`Ignoring invalid model removal journal ${name}: ${error.message}`);
      }
    }
  }
  async begin(id) {
    await this.ready;
    const model = this.model(id);
    if (this.active.has(id)) {
      throw Error('This model is already being removed.');
    }
    const previous = this.operations.get(id);
    if (previous?.state === 'failed') {
      throw Error('A previous removal needs cleanup before this model can be removed again.');
    }
    this.active.add(id);
    let staged = false,
      item;
    try {
      await this.checkStopped(id);
      await checkedDirectory(this.root);
      const target = path.join(this.root, model.folder);
      await checkedDirectory(target);
      await ensureNoLinks(target);
      const operation = randomUUID();
      item = { id, operation, state: 'prepared', error: null, startedAt: new Date().toISOString() };
      await this.writeJournal(item);
      this.operations.set(id, item);
      const temporary = this.staged(id, operation);
      await this.rename(target, temporary);
      staged = true;
      item.state = 'deleting';
      this.operations.set(id, { ...item });
      // The prepared journal already proves authorization if this update fails.
      await this.writeJournal(item).catch((error) =>
        this.log(`Model removal journal update: ${error.message}`),
      );
      this.purge(item, temporary).catch((error) => this.log(`Model removal: ${error.message}`));
      return { ...item };
    } catch (error) {
      if (!staged && item) {
        item = { ...item, state: 'cancelled', error: String(error.message).slice(0, 500) };
        this.operations.set(id, item);
        await this.writeJournal(item).catch((journalError) =>
          this.log(`Model removal journal update: ${journalError.message}`),
        );
      }
      throw error;
    } finally {
      if (!staged) {
        this.active.delete(id);
      }
    }
  }
  async purge(item, staged) {
    try {
      await checkedDirectory(this.root);
      await checkedDirectory(staged);
      await ensureNoLinks(staged);
      await this.remove(staged, { recursive: true, force: false });
      item = { ...item, state: 'complete', error: null, finishedAt: new Date().toISOString() };
    } catch (error) {
      item = { ...item, state: 'failed', error: String(error.message).slice(0, 500) };
      try {
        this.log(`WARN operation=model_remove stage=purge error_code=${safeErrorCode(error)}`);
      } catch {
        // A logger failure must not prevent the failed removal state from persisting.
      }
    }
    this.operations.set(item.id, item);
    try {
      await this.writeJournal(item);
    } catch (error) {
      this.log(`Model removal journal update: ${error.message}`);
    } finally {
      this.active.delete(item.id);
    }
  }
  async retry(id) {
    await this.ready;
    this.model(id);
    if (this.active.has(id)) {
      throw Error('This model is already being removed.');
    }
    const item = this.operations.get(id);
    if (item?.state !== 'failed' || !uuid.test(item.operation)) {
      throw Error('There is no failed removal to retry.');
    }
    this.active.add(id);
    let started = false;
    try {
      const staged = this.staged(id, item.operation);
      await this.checkStopped(id);
      await checkedDirectory(this.root);
      await checkedDirectory(staged);
      const next = { ...item, state: 'deleting', error: null };
      this.operations.set(id, next);
      await this.writeJournal(next).catch((error) =>
        this.log(`Model removal journal update: ${error.message}`),
      );
      this.purge(next, staged).catch((error) => this.log(`Model removal: ${error.message}`));
      started = true;
      return { ...next };
    } finally {
      if (!started) {
        this.active.delete(id);
      }
    }
  }
}
