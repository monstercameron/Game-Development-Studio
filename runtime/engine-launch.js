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

export const consoleLauncher = fileURLToPath(new URL('./console_launch.py', import.meta.url));

const isVenvLauncher = (command) =>
  path.win32.basename(command).toLowerCase() === 'python.exe' &&
  path.win32.basename(path.win32.dirname(command)).toLowerCase() === 'scripts';

// Returns the base interpreter recorded in the venv's own pyvenv.cfg, or null.
export function venvBaseInterpreter(
  command,
  { exists = existsSync, read = readFileSync, size = (file) => statSync(file).size } = {},
) {
  if (typeof command !== 'string' || !path.win32.isAbsolute(command) || !isVenvLauncher(command)) {
    return null;
  }
  try {
    const cfg = path.win32.join(path.win32.dirname(path.win32.dirname(command)), 'pyvenv.cfg');
    if (!exists(cfg) || size(cfg) > 16384) {
      return null;
    }
    const values = String(read(cfg, 'utf8'))
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
  } catch {
    return null;
  }
}

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
    const split = args.findIndex((arg) => !/^-[A-Za-z]$/.test(arg) || arg === '-m');
    const flags = split < 0 ? args : args.slice(0, split);
    plan.args = [...flags, consoleLauncher, ...(split < 0 ? [] : args.slice(split))];
  }
  const base = venvBaseInterpreter(definition.command, fsOptions);
  if (base) {
    plan.command = base;
    plan.env.__PYVENV_LAUNCHER__ = definition.command;
  }
  return plan;
}
