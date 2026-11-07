import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSharedHuggingFaceToken } from './sound-credentials.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = await findSharedHuggingFaceToken();
if (!token) {
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
child.once('error', (error) => {
  console.error(`Could not start DINOv3 downloader: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (code !== 0) {
    console.error(`DINOv3 downloader stopped (${code ?? signal}).`);
    process.exitCode = 1;
  }
});
child.stdin.on('error', () => {});
child.stdin.end(`${token}\n`);
