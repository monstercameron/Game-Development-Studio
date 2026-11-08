import { app, BrowserWindow, dialog, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureAppLog, createLogger } from '../runtime/app-log.js';
import { isAllowedPermission, isExternalWebUrl, isStudioUrl } from './policy.js';
import { createWindowActions } from './window-actions.js';

// The logger spools to <checkout>/.forge-runtime/log-spool, the folder the studio host ingests.
configureAppLog({ processName: 'desktop' });
const log = createLogger('desktop');
const startedAtMs = performance.now();

// Reports only the error class and code; message text can contain URLs or local paths.
function describeError(error) {
  const fields = { errorClass: typeof error?.name === 'string' ? error.name : 'Error' };
  if (typeof error?.code === 'string') {
    fields.errorCode = error.code;
  }
  return fields;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 5173 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log.error('desktop.config.rejected', { reason: 'invalid_port' });
  throw new Error('Invalid Studio port.');
}
const origin = `http://127.0.0.1:${port}`;
const actionIndex = process.argv.indexOf('--window-action');
const launchAction = actionIndex === -1 ? 'open' : process.argv[actionIndex + 1];
if (!['open', 'minimize', 'maximize'].includes(launchAction)) {
  log.error('desktop.config.rejected', { reason: 'invalid_window_action' });
  throw new Error('Invalid desktop window action.');
}
let window;
let quitting = false;
const windowActions = createWindowActions(() => window, launchAction);
function openOutside(url) {
  if (isExternalWebUrl(url) && !isStudioUrl(url, origin)) {
    log.info('desktop.external.open.requested');
    shell.openExternal(url).catch((error) => {
      log.warn('desktop.external.open.failed', describeError(error));
    });
    return;
  }
  log.info('desktop.external.open.refused', {
    reason: isExternalWebUrl(url) ? 'studio_origin' : 'not_web_url',
  });
}
/**
 * Confirms that the service on `port` is this checkout's Studio.
 * Resolves to the supervisor PID (or the server PID) used for the exit monitor.
 * Throws when diagnostics are unavailable, the status is not OK, or the service is another install.
 */
async function checkStudio() {
  const checkStartedAtMs = performance.now();
  const response = await fetch(`${origin}/api/diagnostics`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) {
    log.warn('desktop.studio.health.failed', {
      route: '/api/diagnostics',
      status: response.status,
      durationMs: Math.round(performance.now() - checkStartedAtMs),
      reason: 'bad_status',
    });
    throw new Error('Studio diagnostics are unavailable.');
  }
  const { server } = await response.json();
  const samePath = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    server?.port !== port ||
    typeof server.projectDirectory !== 'string' ||
    samePath(path.resolve(server.projectDirectory)) !== samePath(root)
  ) {
    log.warn('desktop.studio.health.failed', {
      route: '/api/diagnostics',
      status: response.status,
      durationMs: Math.round(performance.now() - checkStartedAtMs),
      reason: 'not_this_installation',
    });
    throw new Error('The service on this port is not this Forge Studio installation.');
  }
  log.debug('desktop.studio.health.completed', {
    route: '/api/diagnostics',
    status: response.status,
    durationMs: Math.round(performance.now() - checkStartedAtMs),
  });
  return server.supervisorPid || server.pid;
}

app.setName('Forge Studio');
app.setPath(
  'userData',
  process.env.FORGE_DESKTOP_USER_DATA ||
    path.join(app.getPath('appData'), port === 5173 ? 'Forge Studio' : `Forge Studio ${port}`),
);
log.info('desktop.process.started', {
  pid: process.pid,
  port,
  version: process.versions.electron,
  action: launchAction,
});
if (!app.requestSingleInstanceLock({ windowAction: launchAction })) {
  log.info('desktop.process.exited', { reason: 'second_instance' });
  app.quit();
} else {
  app.setAppUserModelId('ForgeStudio.GameDevelopmentStudio');
  app.on('second-instance', (_event, _commandLine, _workingDirectory, data) => {
    log.debug('desktop.instance.second.received');
    windowActions.request(data?.windowAction || 'open');
  });
  app.on('before-quit', () => {
    log.info('desktop.process.stopping');
    quitting = true;
  });
  // log-coverage: ignore -- the whole callback body is in a try/catch that logs and quits
  app.whenReady().then(async () => {
    try {
      const supervisorPid = await checkStudio();
      if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
        log.debug('desktop.supervisor.monitor.started', { pid: supervisorPid });
        const monitor = setInterval(() => {
          try {
            process.kill(supervisorPid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') {
              log.info('desktop.supervisor.exited', { pid: supervisorPid });
              quitting = true;
              app.quit();
            } else {
              // EPERM means the supervisor is alive but owned by another account.
              log.debug('desktop.supervisor.probe.failed', describeError(error));
            }
          }
        }, 5000);
        monitor.unref();
        app.once('before-quit', () => clearInterval(monitor));
      }
      session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          const requestUrl = details.requestingUrl || webContents.getURL();
          const isStudioRequest =
            isStudioUrl(webContents.getURL(), origin) && isStudioUrl(requestUrl, origin);
          const isPermissionAllowed = isAllowedPermission(permission, origin, origin);
          const isGranted = isStudioRequest && isPermissionAllowed;
          // Only names on the policy allow-list are logged; others are reported as 'other'.
          const feature = isPermissionAllowed ? permission : 'other';
          if (isGranted) {
            log.info('desktop.permission.granted', { feature });
          } else {
            log.warn('desktop.permission.denied', {
              feature,
              reason: isStudioRequest ? 'permission_not_allowed' : 'not_studio_origin',
            });
          }
          callback(isGranted);
        },
      );
      session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission, requestingOrigin) =>
          isAllowedPermission(permission, requestingOrigin, origin),
      );
      window = new BrowserWindow({
        title: 'Forge — Game Development Studio',
        icon: path.join(root, 'public', 'forge.ico'),
        width: 1500,
        height: 950,
        minWidth: 960,
        minHeight: 650,
        backgroundColor: '#17040f',
        autoHideMenuBar: true,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      log.info('desktop.window.created', {
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        log.info('desktop.navigation.blocked', { reason: 'popup_denied' });
        openOutside(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!isStudioUrl(url, origin)) {
          event.preventDefault();
          log.warn('desktop.navigation.blocked', { reason: 'not_studio_origin' });
          openOutside(url);
        }
      });
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          log.info('desktop.window.hidden', { reason: 'close_to_background' });
          window.hide();
          return;
        }
        log.info('desktop.window.closed', { reason: 'quitting' });
      });
      window.webContents.on('render-process-gone', (_event, details) => {
        log.error('desktop.renderer.crashed', {
          reason: typeof details?.reason === 'string' ? details.reason : 'unknown',
          ...(Number.isFinite(details?.exitCode) ? { exitCode: details.exitCode } : {}),
        });
      });
      window.on('unresponsive', () => {
        log.warn('desktop.renderer.unresponsive', { reason: 'unresponsive' });
      });
      window.on('responsive', () => {
        log.info('desktop.renderer.responsive', { reason: 'recovered' });
      });
      window.once('ready-to-show', () => {
        log.info('desktop.window.ready', {
          durationMs: Math.round(performance.now() - startedAtMs),
        });
        windowActions.ready();
      });
      await window.loadURL(origin);
    } catch (error) {
      log.error('desktop.startup.failed', {
        ...describeError(error),
        durationMs: Math.round(performance.now() - startedAtMs),
      });
      dialog.showErrorBox('Forge Studio could not open', error.message);
      app.quit();
    }
  });
}
