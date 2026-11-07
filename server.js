// Stable local entry point. The HTTP host and model/runtime workers are isolated
// processes so an unexpected host exit does not permanently take down the app.
import { EngineManager } from './runtime/engines.js';
import { HostSupervisor } from './runtime/host-supervisor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) {
  console.error('Usage: node server.js [--port PORT]');
  process.exit(2);
}
const port = args.length ? Number(args[1]) : 5173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Port must be between 1 and 65535.');
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
  } catch {
    // The message was already written to stderr if the log file is unavailable.
  }
}
// Optional local configuration is supplied only by the process environment, not HTTP.
const definitions = process.env.FORGE_ENGINE_CONFIG
  ? JSON.parse(process.env.FORGE_ENGINE_CONFIG)
  : undefined;
if (definitions !== undefined && !Array.isArray(definitions)) {
  console.error('FORGE_ENGINE_CONFIG must be an array.');
  process.exit(2);
}
const engines = new EngineManager({ ...(definitions ? { definitions } : {}), logger: log });
const supervisor = new HostSupervisor({
  port,
  engines,
  log,
  onStopped: () => process.exit(0),
  onFatal: () => process.exit(1),
});
process.on('SIGINT', () => supervisor.stop());
process.on('SIGTERM', () => supervisor.stop());
supervisor.start();
