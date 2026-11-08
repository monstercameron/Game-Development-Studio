// Read-only MCP tools for the errors review. They call Forge's loopback /api/errors routes,
// which return redacted text only; nothing here sends errors to OpenAI or GitHub.
import { z } from 'zod';

export function registerErrorsTools(server, { read, readonly }) {
  server.registerTool(
    'forge_errors_list',
    {
      description:
        'List errors captured by Forge (browser, render queue, studio server and engine logs), newest first. Messages are redacted: local paths become placeholders such as <repo>, and keys, tokens and emails are removed. Use forge_error_detail for the stack trace.',
      inputSchema: {
        status: z.enum(['new', 'reviewed', 'resolved', 'verified', 'ignored']).optional(),
        source: z
          .string()
          .regex(/^(?:browser|queue|server|engine|engine:[a-z0-9-]{1,40})$/)
          .optional()
          .describe('browser, queue, server, engine (all engines) or engine:<id>.'),
        query: z.string().max(200).optional().describe('Text to find in messages and stacks.'),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: readonly,
    },
    ({ status, source, query, limit }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status) {
        params.set('status', status);
      }
      if (source) {
        params.set('source', source);
      }
      if (query) {
        params.set('q', query);
      }
      return read(`/api/errors?${params}`);
    },
  );
  server.registerTool(
    'forge_error_detail',
    {
      description:
        'Read one captured error with its redacted stack trace, context, status, note and any saved AI suggestion. Local paths stay redacted.',
      inputSchema: { id: z.number().int().min(1).describe('The error id from forge_errors_list.') },
      annotations: readonly,
    },
    ({ id }) => read(`/api/errors/${id}`),
  );
}
