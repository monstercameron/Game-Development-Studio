import {credentialService} from './credential-service.js';
import { chatService } from './chat-service.js';
import { defineConfig } from 'vite';
import { powerService } from './power.js';
import { diagnosticsService } from './diagnostics.js';
import { projectsService } from './projects.js';
import { runtimeService } from './runtime/supervisor.js';

export default defineConfig({ plugins: [powerService(), diagnosticsService(), projectsService(), chatService(), credentialService(), runtimeService()] });
