import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';

// Named appLog because startWindowsTray takes a `log` callback option.
const appLog = createLogger('tray');

// A tray crash must not affect the web host or model workers. Restart the
// lightweight helper with bounded backoff while the studio supervisor is alive.
/**
 * Starts the Windows tray helper and keeps it running until stop() is called.
 * Launch failures and unexpected exits are retried with backoff; the function
 * itself does not throw when a launch fails.
 *
 * @param {object} options
 * @param {number} options.port Studio port the tray helper connects to.
 * @param {number} options.ownerPid PID of the studio supervisor the helper monitors.
 * @param {(message: string) => void} options.log Supervisor event log callback.
 * @returns {{ stop: () => void }} stop() prevents further restarts. It does not
 *   kill a helper that is already running.
 */
export function startWindowsTray({
  port,
  ownerPid,
  log,
  launch = spawn,
  env = process.env,
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  let stopped = false;
  let child = null;
  let timer = null;
  let failures = 0;
  const executable = path.join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    fileURLToPath(new URL('./windows-tray.ps1', import.meta.url)),
    '-Port',
    String(port),
    '-OwnerPid',
    String(ownerPid),
  ];
  function schedule() {
    if (stopped || timer) {
      return;
    }
    failures++;
    const delay = Math.min(5000 * 2 ** Math.min(failures - 1, 4), 60000);
    log(`Supervisor event=tray_restart_scheduled delay_ms=${delay}`);
    appLog.warn('tray.restart.scheduled', { attempt: failures, delayMs: delay });
    timer = scheduleTimer(() => {
      timer = null;
      start();
    }, delay);
    // Unref so a pending restart timer alone does not keep the supervisor alive.
    timer.unref();
  }
  function start() {
    if (stopped || child) {
      return;
    }
    let processHandle;
    try {
      processHandle = launch(executable, args, { windowsHide: true, stdio: 'ignore', env });
    } catch (error) {
      appLog.warn('tray.process.start_failed', { errorClass: error?.name, errorCode: error?.code });
      log('Supervisor event=tray_start_failed');
      schedule();
      return;
    }
    child = processHandle;
    appLog.info('tray.process.started', { pid: processHandle.pid });
    let settled = false;
    const started = Date.now();
    function ended() {
      if (settled) {
        return;
      }
      settled = true;
      if (child === processHandle) {
        child = null;
      }
      // A helper that ran for 30 seconds is considered healthy, so the next
      // failure starts again from the shortest restart delay.
      if (Date.now() - started > 30000) {
        failures = 0;
      }
      appLog.info('tray.process.exited', {
        pid: processHandle.pid,
        durationMs: Date.now() - started,
        isStopping: stopped,
      });
      if (!stopped) {
        log('Supervisor event=tray_stopped');
        schedule();
      }
    }
    processHandle.once('error', ended);
    processHandle.once('exit', ended);
    processHandle.unref();
  }
  start();
  return {
    stop() {
      stopped = true;
      appLog.info('tray.stop.requested', { hasProcess: child !== null });
      cancelTimer(timer);
      timer = null;
    },
  };
}
