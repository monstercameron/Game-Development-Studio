import { app, BrowserWindow, dialog, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedPermission, isExternalWebUrl, isStudioUrl } from './policy.js';
import { createWindowActions } from './window-actions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 5173 : Number(process.argv[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid Studio port.');
}
const origin = `http://127.0.0.1:${port}`;
const actionIndex = process.argv.indexOf('--window-action');
const launchAction = actionIndex === -1 ? 'open' : process.argv[actionIndex + 1];
if (!['open', 'minimize', 'maximize'].includes(launchAction)) {
  throw new Error('Invalid desktop window action.');
}
let window;
let quitting = false;
const windowActions = createWindowActions(() => window, launchAction);
function openOutside(url) {
  if (isExternalWebUrl(url) && !isStudioUrl(url, origin)) {
    shell.openExternal(url).catch(() => {});
  }
}
async function checkStudio() {
  const response = await fetch(`${origin}/api/diagnostics`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error('Studio diagnostics are unavailable.');
  }
  const { server } = await response.json();
  const samePath = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    server?.port !== port ||
    typeof server.projectDirectory !== 'string' ||
    samePath(path.resolve(server.projectDirectory)) !== samePath(root)
  ) {
    throw new Error('The service on this port is not this Forge Studio installation.');
  }
  return server.supervisorPid || server.pid;
}

app.setName('Forge Studio');
app.setPath(
  'userData',
  process.env.FORGE_DESKTOP_USER_DATA ||
    path.join(app.getPath('appData'), port === 5173 ? 'Forge Studio' : `Forge Studio ${port}`),
);
if (!app.requestSingleInstanceLock({ windowAction: launchAction })) {
  app.quit();
} else {
  app.setAppUserModelId('ForgeStudio.GameDevelopmentStudio');
  app.on('second-instance', (_event, _commandLine, _workingDirectory, data) => {
    windowActions.request(data?.windowAction || 'open');
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.whenReady().then(async () => {
    try {
      const supervisorPid = await checkStudio();
      if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
        const monitor = setInterval(() => {
          try {
            process.kill(supervisorPid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') {
              quitting = true;
              app.quit();
            }
          }
        }, 5000);
        monitor.unref();
        app.once('before-quit', () => clearInterval(monitor));
      }
      session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          const requestUrl = details.requestingUrl || webContents.getURL();
          callback(
            isStudioUrl(webContents.getURL(), origin) &&
              isStudioUrl(requestUrl, origin) &&
              isAllowedPermission(permission, origin, origin),
          );
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
      window.webContents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (!isStudioUrl(url, origin)) {
          event.preventDefault();
          openOutside(url);
        }
      });
      window.on('close', (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.once('ready-to-show', () => windowActions.ready());
      await window.loadURL(origin);
    } catch (error) {
      dialog.showErrorBox('Forge Studio could not open', error.message);
      app.quit();
    }
  });
}
