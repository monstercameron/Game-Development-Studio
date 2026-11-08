import { credentialService } from './credential-service.js';
import { chatService } from './chat-service.js';
import { defineConfig } from 'vite';
import { powerService } from './power.js';
import { diagnosticsService } from './diagnostics.js';
import { projectsService } from './projects.js';
import { megascansService } from './runtime/megascans-service.js';
import { errorsService } from './runtime/errors-service.js';
import { logsService } from './runtime/logs-service.js';
import { i18nService } from './runtime/i18n-service.js';
import { settingsService } from './runtime/settings-service.js';
import { vegetationService } from './runtime/vegetation-service.js';
import { recoveryService } from './runtime/recovery-service.js';
import { runtimeService } from './runtime/supervisor.js';
import { trayStatusService } from './runtime/tray-status.js';

export default defineConfig({
  // JSX uses the automatic runtime, so components need not import React only for JSX.
  esbuild: { jsx: 'automatic' },
  plugins: [
    // First, so its request logging and trace ids cover every later /api route.
    logsService(),
    powerService(),
    trayStatusService(),
    diagnosticsService(),
    projectsService(),
    chatService(),
    credentialService(),
    megascansService(),
    errorsService(),
    i18nService(),
    settingsService(),
    vegetationService(),
    recoveryService(),
    runtimeService(),
  ],
});
