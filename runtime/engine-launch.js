// Decides the exact command, arguments and environment used to start an engine.
// Engines are spawned detached so they outlive the studio host, which on
// Windows means they have no console. Anything console-based they start would
// then open its own visible console (a Windows Terminal window), so:
//  * a venv's python.exe is only a redirector that starts the base interpreter
//    in a new console; the base interpreter is started directly instead, with
//    the same __PYVENV_LAUNCHER__ hint the redirector would have set, and
//  * Forge's Python workers allocate a hidden console on startup
//    (hidden_console.py) which every descendant then inherits, and workers
//    whose entry point is not ours are started through console_launch.py.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';

const log = createLogger('engine');

export const consoleLauncher = fileURLToPath(new URL('./console_launch.py', import.meta.url));

const isVenvLauncher = (command) =>
  path.win32.basename(command).toLowerCase() === 'python.exe' &&
  path.win32.basename(path.win32.dirname(command)).toLowerCase() === 'scripts';

/**
 * Returns the base interpreter that a venv launcher redirects to, read from the venv's
 * pyvenv.cfg. Returns null when the command is not a venv launcher, the config is missing,
 * oversized or malformed, or the base is missing or is the launcher itself. The caller then
 * keeps the command as given.
 *
 * @param {string} command Absolute Windows path to the launcher.
 * @param {object} [fsOptions] Injectable existsSync, readFileSync and size readers for tests.
 * @returns {string | null} The base python.exe path, or null.
 */
export function venvBaseInterpreter(
  command,
  { exists = existsSync, read = readFileSync, size = (file) => statSync(file).size } = {},
) {
  if (typeof command !== 'string' || !path.win32.isAbsolute(command) || !isVenvLauncher(command)) {
    return null;
  }
  try {
    const configPath = path.win32.join(
      path.win32.dirname(path.win32.dirname(command)),
      'pyvenv.cfg',
    );
    if (!exists(configPath) || size(configPath) > 16384) {
      return null;
    }
    const values = String(read(configPath, 'utf8'))
      .split(/\r?\n/)
      .map((line) => /^\s*executable\s*=\s*(.*?)\s*$/i.exec(line)?.[1])
      .filter(Boolean);
    const base = values[0];
    if (
      values.length !== 1 ||
      !path.win32.isAbsolute(base) ||
      base.includes('\0') ||
      path.win32.basename(base).toLowerCase() !== 'python.exe' ||
      path.win32.normalize(base).toLowerCase() === path.win32.normalize(command).toLowerCase() ||
      !exists(base)
    ) {
      return null;
    }
    return base;
  } catch (error) {
    // An unreadable or missing pyvenv.cfg keeps the launcher as given; not a launch failure.
    log.debug('engine.interpreter.resolve.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
    });
    return null;
  }
}

/**
 * Returns the command, arguments and environment used to spawn an engine. Off Windows the
 * definition command and arguments are returned unchanged. On Windows, a console launcher gets
 * console_launch.py inserted after the interpreter flags, and a venv launcher is replaced by its
 * base interpreter with __PYVENV_LAUNCHER__ set, as the redirector would have done.
 */
export function resolveEngineLaunch(
  definition,
  args,
  { platform = process.platform, ...fsOptions } = {},
) {
  const plan = { command: definition.command, args, env: {} };
  if (platform !== 'win32') {
    return plan;
  }
  if (definition.consoleLauncher && Array.isArray(args)) {
    // Keep the interpreter flags (such as -u) ahead of the launcher script.
    const scriptStart = args.findIndex((arg) => !/^-[A-Za-z]$/.test(arg) || arg === '-m');
    const flags = scriptStart < 0 ? args : args.slice(0, scriptStart);
    plan.args = [...flags, consoleLauncher, ...(scriptStart < 0 ? [] : args.slice(scriptStart))];
  }
  const base = venvBaseInterpreter(definition.command, fsOptions);
  if (base) {
    plan.command = base;
    plan.env.__PYVENV_LAUNCHER__ = definition.command;
  }
  return plan;
}
