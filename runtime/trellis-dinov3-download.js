import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';
import { findSharedHuggingFaceToken } from './sound-credentials.js';

const log = createLogger('three-d');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = await findSharedHuggingFaceToken();
if (!token) {
  log.warn('three-d.dinov3.download.rejected', { reason: 'missing_token' });
  console.error('No shared Hugging Face token was found.');
  process.exit(1);
}
const python = path.join(root, '.forge-runtime', 'trellis2-venv', 'Scripts', 'python.exe');
// Pass the credential through stdin rather than exposing it in process arguments.
const child = spawn(python, ['-u', path.join(root, 'runtime', 'trellis-dinov3-download.py')], {
  cwd: root,
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
});
log.info('three-d.process.spawned', { kind: 'dinov3-download', pid: child.pid });
const stopProcess = log.time('three-d.process.exited', {
  kind: 'dinov3-download',
  pid: child.pid,
});
child.once('error', (error) => {
  log.error('three-d.dinov3.download.failed', {
    errorClass: error.name,
    errorCode: error.code,
    reason: 'spawn_failed',
  });
  console.error(`Could not start DINOv3 downloader: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  const durationMs = stopProcess({ exitCode: code, signal });
  if (signal) {
    log.warn('three-d.dinov3.download.cancelled', { signal, durationMs });
  }
  if (code !== 0) {
    console.error(`DINOv3 downloader stopped (${code ?? signal}).`);
    process.exitCode = 1;
  }
});
child.stdin.on('error', () => {});
child.stdin.end(`${token}\n`);
