import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './mcp-server.js';

serveStdio(()=>createMcpServer(),{legacy:'reject'});
