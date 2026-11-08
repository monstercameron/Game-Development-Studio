import { fork } from 'node:child_process';

// Starts a fixture that stops at a defined point; the test kills it there.
export function startCrashWorker(t, ...args) {
  const child = fork(new URL('./crash-worker.js', import.meta.url), args, {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null) {
      child.kill();
    }
  });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(Error(`The crash worker exited early (${code}).`)));
  });
  return { child, ready };
}
