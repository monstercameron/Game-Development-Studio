import { credentialService } from './credential-service.js';
import { chatService } from './chat-service.js';
import { defineConfig } from 'vite';
import { powerService } from './power.js';
import { diagnosticsService } from './diagnostics.js';
import { projectsService } from './projects.js';
import { runtimeService } from './runtime/supervisor.js';
import { trayStatusService } from './runtime/tray-status.js';

export default defineConfig({
  // JSX uses the automatic runtime, so components need not import React only for JSX.
  esbuild: { jsx: 'automatic' },
  plugins: [
    powerService(),
    trayStatusService(),
    diagnosticsService(),
    projectsService(),
    chatService(),
    credentialService(),
    runtimeService(),
  ],
});
