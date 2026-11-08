import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './app-log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = createLogger('tray');

// A fresh heartbeat means the tray is observing the queue. Browser alerts can
// then defer to native Windows alerts without suppressing fallback on failure.
/**
 * Vite plugin factory that serves `/api/tray/status` for the dev and preview servers.
 * The tray writes `tray-status-<port>.json` into `directory`; the route answers
 * `{ active: false }` whenever that heartbeat is missing, stale, oversized or invalid,
 * so browser alerts stay enabled.
 *
 * @param {{ directory?: string, now?: () => number }} [options]
 * @returns {{ name: string, configureServer: Function, configurePreviewServer: Function }}
 */
export function trayStatusService({
  directory = process.env.FORGE_RUNTIME_DIR || path.join(root, '.forge-runtime'),
  now = () => Date.now(),
} = {}) {
  function attach(server) {
    // Only the first failure of each kind is logged: the browser polls this route.
    let lastReadFailureReason = '';
    server.middlewares.use('/api/tray/status', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(req.headers.host || '');
      if (req.method !== 'GET' || !match || Number(match[1]) > 65535) {
        const reason = req.method === 'GET' ? 'untrusted_host' : 'method_not_allowed';
        log.warn('tray.request.rejected', { route: '/api/tray/status', reason });
        res.statusCode = 403;
        res.end(JSON.stringify({ active: false }));
        return;
      }
      let status = { active: false };
      try {
        const file = path.join(directory, `tray-status-${Number(match[1])}.json`);
        const stat = await fs.stat(file);
        // The tray rewrites the heartbeat every few seconds. Anything older than 15 s, or
        // larger than 1 KiB, is treated as not observing (size cap bounds the read).
        if (stat.size <= 1024 && now() - stat.mtimeMs >= 0 && now() - stat.mtimeMs < 15000) {
          const heartbeat = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
          if (typeof heartbeat.render === 'boolean' && typeof heartbeat.queue === 'boolean') {
            status = { active: true, render: heartbeat.render, queue: heartbeat.queue };
          }
        }
        lastReadFailureReason = '';
      } catch (error) {
        // Missing, stale, or unreadable heartbeats leave browser alerts enabled.
        const reason = error?.code === 'ENOENT' ? 'heartbeat_missing' : 'heartbeat_unreadable';
        if (reason !== lastReadFailureReason) {
          lastReadFailureReason = reason;
          log.debug('tray.status.read.failed', { error, reason });
        }
      }
      res.end(JSON.stringify(status));
    });
  }
  return { name: 'forge-tray-status', configureServer: attach, configurePreviewServer: attach };
}
