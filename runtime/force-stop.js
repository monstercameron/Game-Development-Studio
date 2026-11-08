import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';

const log = createLogger('engine');

const helper = fileURLToPath(new URL('./force-stop-windows.ps1', import.meta.url));
const shell = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

export function forceStopWindows(identity) {
  if (process.platform !== 'win32') {
    log.warn('engine.force_stop.rejected', { reason: 'unsupported_platform' });
    return Promise.reject(Error('Force stop is currently available on Windows only.'));
  }
  if (
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid <= 0 ||
    !/^[1-9][0-9]{14,20}$/.test(identity.creationTicks || '') ||
    !path.win32.isAbsolute(identity.executable || '')
  ) {
    log.warn('engine.force_stop.rejected', { reason: 'identity_unavailable' });
    return Promise.reject(Error('The engine process identity is unavailable.'));
  }
  const targetPid = identity.pid;
  const startedAt = performance.now();
  log.info('engine.force_stop.requested', { targetPid });
  return new Promise((resolve, reject) => {
    const child = spawn(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    log.info('engine.force_stop.spawned', { targetPid, pid: child.pid });
    let output = '',
      done = false;
    // The reason is a fixed code for the failure path; the error message is never logged.
    const finish = (error, value, failureReason) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startedAt);
      if (error) {
        log.warn('engine.force_stop.failed', {
          targetPid,
          reason: failureReason || 'unknown',
          errorClass: error.name,
          durationMs,
        });
      } else {
        log.info('engine.force_stop.completed', { targetPid, durationMs });
      }
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        Error('Force-stop timed out. Check the engine and queue before continuing.'),
        null,
        'timeout',
      );
    }, 25000);
    child.on('error', () =>
      finish(Error('Could not start the Windows force-stop helper.'), null, 'spawn_failed'),
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4096) {
        child.kill();
        finish(Error('Invalid force-stop response.'), null, 'output_too_large');
      }
    });
    child.stderr.resume();
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(
          Error(
            'The process tree could not be verified or stopped. Check Diagnostics before retrying.',
          ),
          null,
          'helper_failed',
        );
      }
      try {
        const result = JSON.parse(output);
        if (result.stopped !== true) {
          throw Error();
        }
        finish(null, result);
      } catch (error) {
        log.debug('engine.force_stop.result.unreadable', { errorClass: error?.name });
        finish(Error('The force-stop result could not be verified.'), null, 'result_invalid');
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(identity));
  });
}
