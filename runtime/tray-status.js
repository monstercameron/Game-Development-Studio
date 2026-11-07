import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A fresh heartbeat means the tray is observing the queue. Browser alerts can
// then defer to native Windows alerts without suppressing fallback on failure.
export function trayStatusService({
  directory = process.env.FORGE_RUNTIME_DIR || path.join(root, '.forge-runtime'),
  now = () => Date.now(),
} = {}) {
  function attach(server) {
    server.middlewares.use('/api/tray/status', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(req.headers.host || '');
      if (req.method !== 'GET' || !match || Number(match[1]) > 65535) {
        res.statusCode = 403;
        res.end(JSON.stringify({ active: false }));
        return;
      }
      let status = { active: false };
      try {
        const file = path.join(directory, `tray-status-${Number(match[1])}.json`);
        const stat = await fs.stat(file);
        if (stat.size <= 1024 && now() - stat.mtimeMs >= 0 && now() - stat.mtimeMs < 15000) {
          const value = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
          if (typeof value.render === 'boolean' && typeof value.queue === 'boolean') {
            status = { active: true, render: value.render, queue: value.queue };
          }
        }
      } catch {
        /* Missing, stale, or unreadable heartbeats leave browser alerts enabled. */
      }
      res.end(JSON.stringify(status));
    });
  }
  return { name: 'forge-tray-status', configureServer: attach, configurePreviewServer: attach };
}
