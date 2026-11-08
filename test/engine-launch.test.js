import test from 'node:test';
import assert from 'node:assert/strict';
import { engineDefinitions } from '../runtime/engines.js';
import {
  consoleLauncher,
  resolveEngineLaunch,
  venvBaseInterpreter,
} from '../runtime/engine-launch.js';

const launcher = 'C:\\Forge\\.venv\\Scripts\\python.exe';
const base = 'C:\\Python312\\python.exe';
const cfg = 'C:\\Forge\\.venv\\pyvenv.cfg';
const config = `home = C:\\Python312\r\nversion = 3.12.10\r\nexecutable = ${base}\r\n`;
const fakeFs = (files, present = [base]) => ({
  exists: (file) => file in files || present.includes(file),
  read: (file) => files[file],
  size: (file) => files[file].length,
});
const win = { platform: 'win32' };

test('a venv launcher is replaced by its base interpreter with the launcher hint', () => {
  const plan = resolveEngineLaunch({ command: launcher }, ['-u', 'worker.py'], {
    ...win,
    ...fakeFs({ [cfg]: config }),
  });
  assert.equal(plan.command, base);
  assert.deepEqual(plan.args, ['-u', 'worker.py']);
  assert.deepEqual(plan.env, { __PYVENV_LAUNCHER__: launcher });
});

test('the launcher is kept when the venv cannot be resolved safely', () => {
  const unchanged = (command, files, present) =>
    assert.deepEqual(
      resolveEngineLaunch({ command }, ['x'], { ...win, ...fakeFs(files, present) }),
      {
        command,
        args: ['x'],
        env: {},
      },
    );
  unchanged(launcher, {}, []);
  unchanged(launcher, { [cfg]: 'home = C:\\Python312\r\n' });
  unchanged(launcher, { [cfg]: `${config}executable = ${base}\r\n` });
  unchanged(launcher, { [cfg]: config }, []);
  unchanged(launcher, { [cfg]: 'executable = python.exe\r\n' });
  unchanged(launcher, { [cfg]: 'executable = C:\\Python312\\pythonw.exe\r\n' });
  unchanged(launcher, { [cfg]: `executable = ${launcher}\r\n` }, [launcher]);
  unchanged('C:\\Embedded\\python.exe', { 'C:\\Embedded\\pyvenv.cfg': config });
  unchanged('C:\\Forge\\engine.exe', {});
  assert.equal(venvBaseInterpreter('relative\\Scripts\\python.exe'), null);
  assert.equal(venvBaseInterpreter(undefined), null);
});

test('non-Windows launches are untouched', () => {
  const plan = resolveEngineLaunch({ command: launcher, consoleLauncher: true }, ['-u', 'a.py'], {
    platform: 'linux',
    ...fakeFs({ [cfg]: config }),
  });
  assert.deepEqual(plan, { command: launcher, args: ['-u', 'a.py'], env: {} });
});

test('external engines run behind the hidden-console launcher after interpreter flags', () => {
  const definition = { command: 'C:\\Rt\\python.exe', consoleLauncher: true };
  assert.deepEqual(
    resolveEngineLaunch(definition, ['-u', '-m', 'pkg.app', '--port', '1'], win).args,
    ['-u', consoleLauncher, '-m', 'pkg.app', '--port', '1'],
  );
  assert.deepEqual(resolveEngineLaunch(definition, ['-u', 'C:\\Lab\\bootstrap.py'], win).args, [
    '-u',
    consoleLauncher,
    'C:\\Lab\\bootstrap.py',
  ]);
  assert.match(consoleLauncher, /runtime[\\/]console_launch\.py$/);
});

test('every Python engine either runs a Forge worker or goes through the console launcher', () => {
  const pythons = engineDefinitions.filter((item) => item.command.endsWith('python.exe'));
  assert.ok(pythons.length >= 10);
  for (const definition of pythons) {
    const forgeWorker = definition.args.some((arg) => /[\\/]runtime[\\/][\w-]+\.py$/.test(arg));
    assert.notEqual(
      forgeWorker,
      !!definition.consoleLauncher,
      `${definition.id} needs exactly one of a Forge worker script or consoleLauncher`,
    );
    const plan = resolveEngineLaunch(definition, definition.args, win);
    assert.equal(plan.args.includes(consoleLauncher), !!definition.consoleLauncher);
  }
});
