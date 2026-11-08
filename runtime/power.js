import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger } from './app-log.js';

const log = createLogger('power');

let activeControl = null;

/**
 * The keep-awake controller of this process's power service, or null before it is attached.
 * The settings registry (runtime/core-settings.js) uses it so keep awake has one owner.
 */
export function powerControl() {
  return activeControl;
}

export function powerService({ spawnProcess = spawn, platform = process.platform } = {}) {
  let child = null,
    starting = null,
    lastError = null,
    disposed = false;
  const script = fileURLToPath(new URL('../keep-awake.ps1', import.meta.url));
  function stop() {
    if (child) {
      log.info('power.awake.released', { pid: child.pid });
      child.kill();
      child = null;
    }
  }
  function dispose() {
    disposed = true;
    stop();
  }
  async function start() {
    if (disposed) {
      throw new Error('The keep-awake service has stopped.');
    }
    if (child) {
      return;
    }
    if (starting) {
      return starting;
    }
    if (platform !== 'win32') {
      throw new Error('Keep awake is available on Windows only.');
    }
    starting = new Promise((resolve, reject) => {
      const helper = spawnProcess(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-ParentProcessId',
          String(process.pid),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let settled = false,
        errors = '';
      const timer = setTimeout(
        () => fail('The keep-awake helper did not respond.', 'no_response'),
        10000,
      );
      function fail(message, reason) {
        if (settled) {
          return;
        }
        settled = true;
        log.warn('power.helper.failed', { reason });
        clearTimeout(timer);
        helper.kill();
        lastError = message;
        reject(new Error(message));
      }
      helper.stderr.on('data', (data) => {
        errors += data.toString();
      });
      helper.stdout.on('data', (data) => {
        if (!settled && data.toString().includes('READY')) {
          settled = true;
          clearTimeout(timer);
          if (disposed) {
            helper.kill();
            reject(new Error('The keep-awake service has stopped.'));
            return;
          }
          child = helper;
          log.info('power.helper.started', { pid: helper.pid });
          lastError = null;
          resolve();
        }
      });
      helper.on('error', (error) => fail(error.message, 'spawn_error'));
      helper.on('exit', (exitCode, signal) => {
        log.info('power.helper.exited', { exitCode, signal });
        if (!settled) {
          fail(errors.trim() || 'The keep-awake helper exited.', 'exited_early');
        } else if (child === helper) {
          child = null;
          lastError = errors.trim() || 'The keep-awake helper stopped.';
        }
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  }
  async function setAwake(enabled) {
    log.info('power.awake.requested', { enabled });
    if (enabled) {
      await start();
    } else {
      if (starting) {
        await starting;
      }
      stop();
      lastError = null;
    }
    return { awake: !!child, error: lastError };
  }
  function attach(server) {
    activeControl = { status: () => ({ awake: !!child, error: lastError }), setAwake };
    server.middlewares.use('/api/power', async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'GET') {
        res.end(JSON.stringify({ awake: !!child, error: lastError }));
        return;
      }
      const origin = req.headers.origin,
        host = req.headers.host;
      const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '');
      if (
        req.method !== 'POST' ||
        !localHost ||
        origin !== `http://${host}` ||
        req.headers['x-forge-request'] !== 'power'
      ) {
        log.warn('power.request.rejected', { route: '/api/power', reason: 'not_local_studio' });
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'Local studio requests only.' }));
        return;
      }
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1000) {
            throw new Error('Request too large.');
          }
        }
        const input = JSON.parse(body);
        if (typeof input.enabled !== 'boolean') {
          throw new Error('Expected an enabled setting.');
        }
        res.end(JSON.stringify(await setAwake(input.enabled)));
      } catch (error) {
        log.warn('power.request.failed', { route: '/api/power', errorClass: error.name });
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    server.httpServer?.once('close', () => {
      if (activeControl?.setAwake === setAwake) {
        activeControl = null;
      }
      dispose();
    });
  }
  process.once('exit', () => {
    log.debug('power.service.stopped', { isAwake: !!child });
    dispose();
  });
  return { name: 'forge-power-service', configureServer: attach, configurePreviewServer: attach };
}
