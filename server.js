// Stable local entry point. The HTTP host and model/runtime workers are isolated
// processes so an unexpected host exit does not permanently take down the app.
import { getSetting } from './runtime/core-settings.js';
import { EngineManager } from './runtime/engines.js';
import { HostSupervisor } from './runtime/host-supervisor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWindowsTray } from './runtime/tray-supervisor.js';
import { createStudioLifecycle } from './runtime/studio-lifecycle.js';
import { startRecoveryNeededServer } from './runtime/recovery-needed-server.js';
import { createLogger } from './runtime/app-log.js';

const appLog = createLogger('supervisor');

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) {
  console.error('Usage: node server.js [--port PORT]');
  appLog.warn('supervisor.config.rejected', { reason: 'usage' });
  process.exit(2);
}
const port = args.length ? Number(args[1]) : 5173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Port must be between 1 and 65535.');
  appLog.warn('supervisor.config.rejected', { reason: 'port_invalid' });
  process.exit(2);
}
const logDir =
  process.env.FORGE_RUNTIME_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '.forge-runtime');
function log(message) {
  console.error(message);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'service-supervisor.log'),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch (error) {
    appLog.debug('supervisor.log.file.failed', {
      errorClass: error?.name,
      errorCode: error?.code,
    });
    // The message was already written to stderr if the log file is unavailable.
  }
}
// Optional local configuration is supplied only by the process environment, not HTTP.
const definitions = process.env.FORGE_ENGINE_CONFIG
  ? JSON.parse(process.env.FORGE_ENGINE_CONFIG)
  : undefined;
if (definitions !== undefined && !Array.isArray(definitions)) {
  console.error('FORGE_ENGINE_CONFIG must be an array.');
  appLog.warn('supervisor.config.rejected', { reason: 'engine_config_invalid' });
  process.exit(2);
}
const engines = new EngineManager({ ...(definitions ? { definitions } : {}), logger: log });
// The lifecycle owns the clean-shutdown marker, the stop signals and the shutdown deadline; the
// supervisor and tray are looked up lazily because they are created below.
let supervisor = null;
let tray = null;
const lifecycle = createStudioLifecycle({
  port,
  supervisor: { stop: () => supervisor.stop() },
  tray: { stop: () => tray?.stop() },
  log,
  runtimeDirectory: logDir,
});
supervisor = new HostSupervisor({
  port,
  engines,
  log,
  runtimeDirectory: logDir,
  onStopped: () => lifecycle.stopped(),
  onFatal: () => lifecycle.fatal(),
  // After repeated crashes the supervisor stops restarting; answer on the port with a clear
  // "Recovery needed" page instead of leaving a dead port.
  onCrashLoop: (loop) => {
    startRecoveryNeededServer({
      port,
      component: 'studio host',
      count: loop.count,
      windowMs: loop.windowMs,
    }).catch((error) => {
      appLog.warn('supervisor.recovery.page.failed', {
        errorClass: error?.name,
        errorCode: error?.code,
      });
    });
  },
});
// The tray has its own Windows message loop and exits when this supervisor exits.
// A tray failure must never stop the web host or model workers. The tray.enabled setting is read
// once here (FORGE_DISABLE_TRAY=1 still turns it off), so a change applies after a restart.
tray =
  process.platform === 'win32' && getSetting('tray.enabled')
    ? startWindowsTray({ port, ownerPid: process.pid, log })
    : null;
appLog.info('supervisor.process.started', { port, pid: process.pid });
lifecycle.start();
supervisor.start();
