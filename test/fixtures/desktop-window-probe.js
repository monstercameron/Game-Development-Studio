import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import '../../desktop/main.js';

const directory = process.env.FORGE_DESKTOP_PROBE_DIR;
const timer = setInterval(() => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) {
    return;
  }
  if (fs.existsSync(path.join(directory, 'hide'))) {
    fs.unlinkSync(path.join(directory, 'hide'));
    window.hide();
  }
  fs.writeFileSync(
    path.join(directory, 'window.json'),
    JSON.stringify({
      visible: window.isVisible(),
      minimized: window.isMinimized(),
      maximized: window.isMaximized(),
    }),
  );
  if (fs.existsSync(path.join(directory, 'stop'))) {
    app.quit();
  }
}, 100);
app.on('before-quit', () => clearInterval(timer));
