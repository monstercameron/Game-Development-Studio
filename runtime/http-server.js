import { credentialService } from '../credential-service.js';
import { chatService } from '../chat-service.js';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powerService } from '../power.js';
import { diagnosticsService } from '../diagnostics.js';
import { projectsService } from '../projects.js';
import { runtimeService } from './supervisor.js';
import { createMcpServer } from './mcp-server.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { EngineBroker } from './engine-broker.js';
import { attachAsrStreamProxy } from './asr-stream-proxy.js';
import { trayStatusService } from './tray-status.js';
import { megascansService } from './megascans-service.js';
import { errorsService } from './errors-service.js';
import { i18nService } from './i18n-service.js';
import { vegetationService } from './vegetation-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid service port.');
  process.exit(78);
}
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('Studio build is missing. Run npm run build first.');
  process.exit(78);
}

const app = express();
app.disable('x-powered-by');
const httpServer = http.createServer(app);
attachAsrStreamProxy(httpServer);
const logger = {
  info: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
app.use((req, res, next) => {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) {
    return res.status(403).json({ error: 'Local studio requests only.' });
  }
  next();
});
const host = { middlewares: app, httpServer, config: { logger } };
const engineBroker = process.env.FORGE_ENGINE_BROKER === '1' ? new EngineBroker() : null;
for (const service of [
  powerService(),
  trayStatusService(),
  diagnosticsService(),
  projectsService(),
  chatService(),
  credentialService(),
  megascansService(),
  errorsService(),
  i18nService(),
  vegetationService(),
  runtimeService({ engineBroker }),
]) {
  service.configureServer(host);
}
app.use('/mcp', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) {
    return res.status(403).json({ error: 'Local studio requests only.' });
  }
  next();
});
// The SDK's per-request handler serves the current 2026 protocol only.
// Host and Origin are checked above, and request size remains bounded.
const mcpHandler = createMcpHandler(() => createMcpServer(`http://127.0.0.1:${port}`), {
  legacy: 'reject',
});
app.all(
  '/mcp',
  toNodeHandler(mcpHandler, {
    maxRequestBodySize: 256 * 1024,
    onerror: (error) => logger.error(`MCP request failed: ${error.message}`),
  }),
);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(dist, { index: false, fallthrough: true, redirect: false, maxAge: 0 }));
app.use((req, res) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.accepts('html')) {
    return res.sendFile(path.join(dist, 'index.html'));
  }
  return res.status(404).json({ error: 'Not found.' });
});
app.use((error, _req, res, _next) => {
  logger.error(`HTTP request failed: ${error.message}`);
  if (!res.headersSent) {
    res.status(error.status === 400 || error.status === 413 ? error.status : 500).json({
      error:
        error.status === 400
          ? 'Invalid request.'
          : error.status === 413
            ? 'Request too large.'
            : 'Request failed. Check Diagnostics.',
    });
  } else {
    res.destroy();
  }
});
httpServer.on('error', (error) => {
  logger.error(`Studio could not listen: ${error.message}`);
  process.exit(error.code === 'EADDRINUSE' ? 78 : 1);
});
httpServer.listen(port, '127.0.0.1', () => {
  logger.info(`Forge Studio is running at http://127.0.0.1:${port}`);
  process.send?.({ type: 'ready', pid: process.pid });
});
let closing = false;
function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  mcpHandler.close().catch(() => {});
  httpServer.close(() => process.exit(0));
  httpServer.closeAllConnections?.();
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('message', (message) => {
  if (message?.type === 'shutdown') {
    shutdown();
  }
});
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
