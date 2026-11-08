// Recovery service: /api/recovery on the studio host. GET returns the Recovery report (what an
// unclean stop interrupted, what was repaired, what needs the user). POST runs one explicit,
// confirmed action (dismiss, mark an interrupted job cancelled, retry a job that is provably safe
// to run again, move orphaned files to quarantine). The service also starts the periodic
// database backups.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackupManager } from './backup-manager.js';
import { backupDirectoryFor, listBackups } from './durable-db.js';
import { createLogger, routeTemplate } from './app-log.js';
import { createRecoveryManager } from './recovery-report.js';
import { defaultRuntimeDirectory, errorLogFields } from './recovery-events.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const BACKUP_NAMES = ['jobs', 'settings', 'i18n', 'keys', 'megascans'];
const log = createLogger('runtime');

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 16 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) {
      throw Object.assign(Error('Request is too large.'), { status: 413 });
    }
  }
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Error('not an object');
    }
    return value;
  } catch {
    throw Object.assign(Error('Invalid request.'), { status: 400 });
  }
}

/**
 * @param {{ runtimeDirectory?: string, projectsRoot?: string, startBackups?: boolean }} [options]
 */
export function recoveryService({
  runtimeDirectory = defaultRuntimeDirectory(),
  projectsRoot = process.env.FORGE_PROJECTS_DIR || path.join(repositoryRoot, 'projects'),
  startBackups = true,
} = {}) {
  let backups = null;
  let origin = null;

  async function callRuntime(route, { method = 'GET', body } = {}) {
    if (!origin) {
      throw Error('The studio is not listening yet.');
    }
    const template = routeTemplate(route);
    const stop = log.time('recovery.runtime.request.completed', { method, route: template });
    const response = await fetch(`${origin}${route}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers:
        method === 'GET'
          ? {}
          : {
              'Content-Type': 'application/json',
              Origin: origin,
              'X-Forge-Request': 'runtime',
            },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error) => {
      log.warn('recovery.runtime.request.failed', {
        method,
        route: template,
        ...errorLogFields(error),
      });
      throw error;
    });
    stop({ status: response.status });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(data.error || `Request failed (${response.status}).`), {
        status: response.status === 409 ? 409 : 502,
      });
    }
    return data;
  }

  const manager = createRecoveryManager({ runtimeDirectory, projectsRoot, callRuntime });

  function listAllBackups() {
    return BACKUP_NAMES.map((name) => ({
      name,
      backups: listBackups(backupDirectoryFor(name, runtimeDirectory)).map((item) => ({
        file: item.name,
        bytes: item.bytes,
        modifiedAt: item.modifiedAt,
      })),
    }));
  }

  return {
    configureServer(server) {
      const { httpServer } = server;
      // The development host (vite) may have no listening server object; the request's own
      // loopback Host header then names the origin.
      const setOrigin = (host) => {
        const address = httpServer?.address();
        if (address && typeof address === 'object') {
          origin = `http://127.0.0.1:${address.port}`;
        } else if (host) {
          origin = `http://${host}`;
        }
      };
      const start = () => {
        setOrigin();
        // The sweep deletes only stale staging files; the report keeps everything else.
        setImmediate(() => {
          try {
            manager.runStartupSweep();
          } catch (error) {
            log.warn('recovery.sweep.failed', { reason: error.code || 'error' });
          }
          manager.writeSnapshot().catch(() => {});
        });
        if (startBackups) {
          backups = createBackupManager({ runtimeDirectory, projectsRoot });
          backups.start();
        }
      };
      if (!httpServer || httpServer.listening) {
        start();
      } else {
        httpServer.once('listening', start);
      }
      // log-coverage: ignore -- rejections are logged where each refusal is returned, errors in catch
      server.middlewares.use('/api/recovery', async (req, res) => {
        try {
          const url = new URL(req.url, 'http://localhost');
          if (!LOOPBACK_HOST.test(req.headers.host || '')) {
            log.warn('recovery.request.rejected', {
              route: '/api/recovery',
              reason: 'non_loopback_host',
            });
            return json(res, 403, { error: 'Local studio requests only.' });
          }
          setOrigin(req.headers.host);
          if (req.method === 'GET') {
            if (url.pathname === '/backups') {
              return json(res, 200, { databases: listAllBackups() });
            }
            if (url.pathname !== '/') {
              return json(res, 404, { error: 'Not found.' });
            }
            return json(
              res,
              200,
              await manager.report({ rescan: url.searchParams.get('rescan') === '1' }),
            );
          }
          if (req.method !== 'POST') {
            log.warn('recovery.request.rejected', {
              route: '/api/recovery',
              reason: 'method_not_allowed',
            });
            return json(res, 405, { error: 'Method not allowed.' });
          }
          if (
            req.headers.origin !== `http://${req.headers.host}` ||
            req.headers['x-forge-request'] !== 'recovery'
          ) {
            log.warn('recovery.request.rejected', {
              route: '/api/recovery',
              reason: 'origin_or_header_mismatch',
            });
            return json(res, 403, { error: 'Local studio requests only.' });
          }
          if (url.pathname !== '/') {
            return json(res, 404, { error: 'Not found.' });
          }
          return json(res, 200, await manager.act(await readJson(req)));
        } catch (error) {
          const status = Number.isInteger(error.status) ? error.status : 500;
          if (status >= 500) {
            log.error('recovery.request.failed', { reason: error.code || 'error' });
          } else {
            // Refusals from runtime/recovery-report.js (bad input, job not found, not safe to retry).
            log.warn('recovery.request.rejected', {
              route: '/api/recovery',
              status,
              reason: 'action_refused',
            });
          }
          return json(res, status, {
            error: status >= 500 ? 'Recovery request failed. Check Diagnostics.' : error.message,
          });
        }
      });
    },
    dispose() {
      backups?.stop();
    },
    manager,
  };
}
