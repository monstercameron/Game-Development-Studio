// Crash-recovery building blocks. This module never starts or stops a process.
// A journal belongs to the current Windows user, and its entire payload is
// authenticated/encrypted with DPAPI; consumers must still verify the worker.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./ownership-windows.ps1', import.meta.url));
const lockHelper = fileURLToPath(new URL('./ownership-lock.ps1', import.meta.url));
const powershell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const secretPattern = /^[a-f0-9]{64}$/;
const ticksPattern = /^[1-9][0-9]{14,20}$/;
const norm = (value) => path.win32.normalize(value).toLowerCase();
function validId(id) {
  return typeof id === 'string' && idPattern.test(id);
}
function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
}
function validPath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 1024 &&
    path.win32.isAbsolute(value) &&
    !value.includes('\0')
  );
}
function samePaths(a, b) {
  return a.length === b.length && a.every((value, index) => norm(value) === norm(b[index]));
}
async function regular(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw Error('Ownership file is not a regular file.');
  }
  return info;
}

async function invokeWindows(request) {
  if (process.platform !== 'win32') {
    throw Error('Windows ownership verification is unavailable on this platform.');
  }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 131072) {
    throw Error('Ownership request is too large.');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '',
      finished = false;
    const finish = (error, value) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Error('Windows ownership operation timed out.'));
    }, 12000);
    child.on('error', () => finish(Error('Windows ownership operation could not start.')));
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 131072) {
        child.kill();
        finish(Error('Windows ownership response was too large.'));
      }
    });
    // Never relay stderr: a runtime or shell could include sensitive input.
    child.stderr.resume();
    child.on('close', (code) =>
      finish(code === 0 ? null : Error('Windows ownership operation failed.'), stdout),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function expectedEngineExecutables(launcher) {
  if (!validPath(launcher)) {
    throw Error('Engine executable must be an absolute Windows path.');
  }
  const canonical = await fs.realpath(launcher);
  await regular(canonical);
  const expected = [canonical];
  // Python venv launchers on Windows can spawn the base interpreter, which
  // becomes the actual TCP listener. The only extra path allowed comes from
  // this launcher's own pyvenv.cfg and is pinned into the prepared journal.
  if (
    path.basename(canonical).toLowerCase() === 'python.exe' &&
    path.basename(path.dirname(canonical)).toLowerCase() === 'scripts'
  ) {
    const cfg = path.join(path.dirname(path.dirname(canonical)), 'pyvenv.cfg');
    try {
      const info = await regular(cfg);
      if (info.size > 16384) {
        throw Error('Python environment configuration is too large.');
      }
      const values = (await fs.readFile(cfg, 'utf8'))
        .split(/\r?\n/)
        .map((line) => /^\s*executable\s*=\s*(.*?)\s*$/i.exec(line)?.[1])
        .filter(Boolean);
      if (
        values.length !== 1 ||
        !validPath(values[0]) ||
        path.win32.basename(values[0]).toLowerCase() !== 'python.exe'
      ) {
        throw Error('Python environment executable is invalid.');
      }
      const base = await fs.realpath(values[0]);
      await regular(base);
      if (norm(base) !== norm(canonical)) {
        expected.push(base);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return expected;
}

function checkRecord(value, id) {
  if (
    !value ||
    value.version !== 1 ||
    value.id !== id ||
    !validId(value.id) ||
    !validPort(value.port) ||
    !secretPattern.test(value.token || '') ||
    !secretPattern.test(value.nonce || '') ||
    !['prepared', 'running'].includes(value.state) ||
    !Array.isArray(value.executables) ||
    value.executables.length < 1 ||
    value.executables.length > 2 ||
    value.executables.some((file) => !validPath(file))
  ) {
    throw Error('Invalid engine ownership record.');
  }
  if (value.state === 'prepared' && (value.pid !== null || value.creationTicks !== null)) {
    throw Error('Invalid prepared ownership record.');
  }
  if (
    value.state === 'running' &&
    (!validPid(value.pid) ||
      typeof value.creationTicks !== 'string' ||
      !ticksPattern.test(value.creationTicks))
  ) {
    throw Error('Invalid running ownership record.');
  }
  return value;
}

export class EngineOwnershipJournal {
  constructor({ directory }) {
    if (!directory) {
      throw Error('A runtime directory is required.');
    }
    this.root = path.resolve(directory);
    this.directory = path.join(this.root, 'engine-ownership');
    this.ready = null;
    this.lock = null;
    this.lockPromise = null;
  }
  initialize() {
    if (this.ready) {
      return this.ready;
    }
    this.ready = (async () => {
      let created = false;
      try {
        await fs.mkdir(this.directory);
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
      const stat = await fs.lstat(this.directory),
        actual = await fs.realpath(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || norm(actual) !== norm(this.directory)) {
        throw Error('Ownership directory is invalid.');
      }
      const marker = path.join(this.directory, '.forge-ownership');
      if (!created) {
        await regular(marker);
        if ((await fs.readFile(marker, 'utf8')) !== 'forge-engine-ownership-v1\n') {
          throw Error('Ownership directory marker is invalid.');
        }
      }
      await invokeWindows({ operation: 'secure-directory', path: this.directory });
      if (created) {
        await fs.writeFile(marker, 'forge-engine-ownership-v1\n', { flag: 'wx' });
      }
    })();
    return this.ready;
  }
  async acquireLock() {
    await this.initialize();
    if (this.lock?.held) {
      return this.lock;
    }
    if (this.lock) {
      throw Error('The ownership lock was lost or released; create a new journal instance.');
    }
    if (this.lockPromise) {
      return this.lockPromise;
    }
    this.lockPromise = (async () => {
      const file = path.join(this.directory, '.supervisor.lock');
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw Error('Ownership lock file is invalid.');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      return await new Promise((resolve, reject) => {
        const child = spawn(
          powershell,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            lockHelper,
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        let acquired = false,
          done = false,
          buffer = '',
          releaseRequested = false,
          finishLost,
          nextId = 0;
        const pending = new Map();
        const lost = new Promise((resolveLost) => {
          finishLost = resolveLost;
        });
        const lock = {
          held: false,
          lost,
          mutate: (command) => {
            if (!lock.held) {
              return Promise.reject(Error('The engine ownership lock is not held.'));
            }
            return new Promise((resolveCommand, rejectCommand) => {
              const id = ++nextId,
                timer = setTimeout(() => {
                  pending.delete(id);
                  child.kill();
                  rejectCommand(
                    Error(
                      'Ownership mutation outcome is unknown; reread the journal after reacquiring the lock.',
                    ),
                  );
                }, 15000);
              pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
              child.stdin.write(JSON.stringify({ ...command, id }) + '\n', (error) => {
                if (error && pending.has(id)) {
                  clearTimeout(timer);
                  pending.delete(id);
                  child.kill();
                  rejectCommand(
                    Error(
                      'Ownership mutation outcome is unknown; reread the journal after reacquiring the lock.',
                    ),
                  );
                }
              });
            });
          },
          release: async () => {
            if (!lock.held) {
              return await lost;
            }
            if (pending.size) {
              throw Error('Wait for ownership mutations to finish before releasing the lock.');
            }
            releaseRequested = true;
            child.stdin.end();
            const timer = setTimeout(() => child.kill(), 5000);
            try {
              return await lost;
            } finally {
              clearTimeout(timer);
            }
          },
        };
        const fail = () => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          child.kill();
          reject(Error('Another supervisor holds the ownership lock, or the lock is unavailable.'));
        };
        const timer = setTimeout(fail, 12000);
        child.stderr.resume();
        child.stdin.on('error', () => {});
        child.on('error', fail);
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.length > 131072) {
            child.kill();
            return fail();
          }
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n'),
              line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            let value;
            try {
              value = JSON.parse(line);
            } catch {
              child.kill();
              return fail();
            }
            if (!acquired) {
              if (value?.type !== 'locked') {
                return fail();
              }
              acquired = true;
              done = true;
              clearTimeout(timer);
              lock.held = true;
              this.lock = lock;
              resolve(lock);
              continue;
            }
            if (value?.type !== 'reply' || !Number.isSafeInteger(value.id)) {
              continue;
            }
            const item = pending.get(value.id);
            if (!item) {
              continue;
            }
            clearTimeout(item.timer);
            pending.delete(value.id);
            if (value.ok === true) {
              item.resolve();
            } else {
              const error = Error(
                value.code === 'conflict'
                  ? 'Ownership record changed or already exists.'
                  : 'Ownership mutation failed.',
              );
              if (value.code === 'conflict') {
                error.code = 'EEXIST';
              }
              item.reject(error);
            }
          }
        });
        child.on('close', () => {
          if (!acquired) {
            fail();
            return;
          }
          lock.held = false;
          for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(Error('Ownership lock was lost; mutation outcome is unknown.'));
          }
          pending.clear();
          finishLost({ state: releaseRequested ? 'released' : 'lost' });
        });
        child.stdin.write(JSON.stringify({ path: file }) + '\n');
      });
    })();
    try {
      return await this.lockPromise;
    } finally {
      this.lockPromise = null;
    }
  }
  assertHeld() {
    if (!this.lock?.held) {
      throw Error('The engine ownership lock is not held.');
    }
  }
  file(id) {
    if (!validId(id)) {
      throw Error('Invalid engine ID.');
    }
    return path.join(this.directory, `${id}.json`);
  }
  async sealed(record) {
    return await invokeWindows({ operation: 'protect', value: JSON.stringify(record) });
  }
  async put(record, exclusive, expected = null) {
    await this.initialize();
    this.assertHeld();
    checkRecord(record, record.id);
    const cipher = await this.sealed(record);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cipher) || cipher.length > 65536) {
      throw Error('Invalid protected ownership record.');
    }
    this.assertHeld();
    await this.lock.mutate({
      operation: exclusive ? 'create' : 'replace',
      file: `${record.id}.json`,
      content: JSON.stringify({ version: 1, ciphertext: cipher }),
      ...(exclusive ? {} : { expected }),
    });
  }
  async prepare({ id, port, executable, nonce, token }) {
    const executables = await expectedEngineExecutables(executable);
    const record = checkRecord(
      {
        version: 1,
        id,
        state: 'prepared',
        port,
        executables,
        nonce,
        token,
        pid: null,
        creationTicks: null,
      },
      id,
    );
    await this.put(record, true);
    return record;
  }
  async readSealed(id) {
    await this.initialize();
    const file = this.file(id);
    let info;
    try {
      info = await regular(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    if (info.size > 100000) {
      throw Error('Ownership record is too large.');
    }
    let wrapper, raw;
    try {
      raw = await fs.readFile(file, 'utf8');
      wrapper = JSON.parse(raw);
    } catch {
      throw Error('Ownership record is malformed.');
    }
    if (
      wrapper?.version !== 1 ||
      typeof wrapper.ciphertext !== 'string' ||
      wrapper.ciphertext.length > 65536 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(wrapper.ciphertext)
    ) {
      throw Error('Ownership record is malformed.');
    }
    const clear = await invokeWindows({ operation: 'unprotect', value: wrapper.ciphertext });
    let record;
    try {
      record = JSON.parse(clear);
    } catch {
      throw Error('Ownership record is malformed.');
    }
    return { record: checkRecord(record, id), raw };
  }
  async read(id) {
    const value = await this.readSealed(id);
    return value?.record || null;
  }
  async bind(id, nonce, { pid, creationTicks }) {
    this.assertHeld();
    const saved = await this.readSealed(id),
      record = saved?.record;
    if (!record || record.state !== 'prepared' || record.nonce !== nonce) {
      throw Error('Prepared ownership record does not match.');
    }
    const next = checkRecord({ ...record, state: 'running', pid, creationTicks }, id);
    await this.put(next, false, saved.raw);
    return next;
  }
  async clear(id, nonce) {
    this.assertHeld();
    const saved = await this.readSealed(id),
      record = saved?.record;
    this.assertHeld();
    if (!record) {
      return false;
    }
    if (record.nonce !== nonce) {
      throw Error('Ownership instance does not match.');
    }
    await this.lock.mutate({ operation: 'remove', file: `${id}.json`, expected: saved.raw });
    return true;
  }
}

export async function inspectWindowsProcess(pid, port) {
  if (!validPid(pid) || !validPort(port)) {
    throw Error('Invalid engine process or port.');
  }
  const raw = await invokeWindows({ operation: 'inspect', pid, port });
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw Error('Invalid Windows ownership response.');
  }
  if (
    value?.pid !== pid ||
    typeof value.creationTicks !== 'string' ||
    !ticksPattern.test(value.creationTicks) ||
    !validPath(value.executable) ||
    !Array.isArray(value.listeners) ||
    value.listeners.some((item) => typeof item !== 'string')
  ) {
    throw Error('Invalid Windows ownership response.');
  }
  return value;
}

// Only OS-confirmed process absence or a different creation time establishes
// that the original PID is gone. Permission/API failures remain indeterminate.
export async function probeWindowsProcess({ pid, creationTicks, executable }) {
  if (
    !validPid(pid) ||
    typeof creationTicks !== 'string' ||
    !ticksPattern.test(creationTicks) ||
    !validPath(executable)
  ) {
    return { state: 'indeterminate' };
  }
  try {
    const result = await invokeWindows({ operation: 'process', pid });
    if (result === 'absent') {
      return { state: 'exited_or_reused' };
    }
    const [state, actualTicks, actualExecutable, ...extra] = result.split('\n');
    if (
      state !== 'alive' ||
      extra.length ||
      !ticksPattern.test(actualTicks || '') ||
      !validPath(actualExecutable)
    ) {
      return { state: 'indeterminate' };
    }
    if (actualTicks !== creationTicks) {
      return { state: 'exited_or_reused' };
    }
    if (norm(actualExecutable) !== norm(executable)) {
      return { state: 'indeterminate' };
    }
    return { state: 'alive' };
  } catch {
    return { state: 'indeterminate' };
  }
}

async function identity(record) {
  const response = await fetch(`http://127.0.0.1:${record.port}/api/forge/identity`, {
    headers: { 'X-Forge-Engine-Token': record.token },
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    throw Error('Identity challenge failed.');
  }
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.length;
      if (length > 4096) {
        await reader.cancel().catch(() => {});
        throw Error('Identity response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('Identity response is invalid.');
  }
  if (body?.engine !== record.id || body.nonce !== record.nonce || !validPid(body.pid)) {
    throw Error('Identity challenge failed.');
  }
  return body.pid;
}

export async function verifyEngineOwnership(record, { id, port, executable }) {
  try {
    checkRecord(record, id);
    if (record.port !== port) {
      throw Error('Endpoint changed.');
    }
    const expected = await expectedEngineExecutables(executable);
    if (!samePaths(record.executables, expected)) {
      throw Error('Engine configuration changed.');
    }
    const pid = await identity(record);
    if (record.state === 'running' && record.pid !== pid) {
      throw Error('Process changed.');
    }
    const first = await inspectWindowsProcess(pid, port);
    if (
      !expected.some((item) => norm(item) === norm(first.executable)) ||
      first.listeners.length !== 1 ||
      first.listeners[0] !== `127.0.0.1:${pid}` ||
      (record.state === 'running' && record.creationTicks !== first.creationTicks)
    ) {
      throw Error('Process identity changed.');
    }
    if ((await identity(record)) !== pid) {
      throw Error('Endpoint changed.');
    }
    const second = await inspectWindowsProcess(pid, port);
    if (
      second.creationTicks !== first.creationTicks ||
      norm(second.executable) !== norm(first.executable) ||
      second.listeners.length !== 1 ||
      second.listeners[0] !== `127.0.0.1:${pid}`
    ) {
      throw Error('Process identity changed.');
    }
    return {
      verified: true,
      pid,
      creationTicks: first.creationTicks,
      executable: first.executable,
    };
  } catch {
    return { verified: false };
  }
}
