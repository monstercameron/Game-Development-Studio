// Read-only MCP tools for the structured studio log (docs/LOGGING.md). They call the loopback
// /api/logs routes, which return redacted, allow-listed records only: no prompts, typed text,
// file contents, absolute paths or keys. Output is capped.
import { z } from 'zod';
import { createLogger } from './app-log.js';
import { LOG_COMPONENTS, LOG_LEVEL_NAMES } from './log-fields.js';

export const MAX_TOOL_OUTPUT_CHARS = 60_000;
const log = createLogger('mcp');

const filterSchema = {
  level: z
    .enum(LOG_LEVEL_NAMES)
    .optional()
    .describe('Minimum severity: trace, debug, info, warn or error.'),
  components: z
    .array(z.enum(LOG_COMPONENTS))
    .max(20)
    .optional()
    .describe('Only these components, for example ["queue", "engine"].'),
  event: z
    .string()
    .regex(/^[a-z0-9_.-]{1,96}$/)
    .optional()
    .describe('Event id prefix, for example "job." or "engine.start".'),
  text: z.string().max(200).optional().describe('Words to find in event ids and messages.'),
  sinceMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 365)
    .optional()
    .describe('Only records from the last N minutes.'),
  jobId: z
    .string()
    .regex(/^[A-Za-z0-9._:+/-]{1,128}$/)
    .optional(),
  traceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
};

function toSearchParams({ level, components, event, text, sinceMinutes, jobId, traceId }, now) {
  const params = new URLSearchParams();
  if (level) {
    params.set('level', level);
  }
  if (components?.length) {
    params.set('component', components.join(','));
  }
  if (event) {
    params.set('event', event);
  }
  if (text) {
    params.set('text', text);
  }
  if (sinceMinutes) {
    params.set('since', String(now() - sinceMinutes * 60_000));
  }
  if (jobId) {
    params.set('jobId', jobId);
  }
  if (traceId) {
    params.set('traceId', traceId);
  }
  return params;
}

function capText(text) {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… output truncated; narrow the filters.`
    : text;
}

// One compact line per record keeps more history inside the output cap than pretty JSON.
export function formatLogRows(rows) {
  return rows
    .map((row) => {
      const parts = [
        new Date(row.ts).toISOString(),
        row.level.toUpperCase(),
        row.component,
        row.event,
      ];
      if (row.count > 1) {
        parts.push(`x${row.count}`);
      }
      if (row.jobId) {
        parts.push(`job=${row.jobId}`);
      }
      if (row.traceId) {
        parts.push(`trace=${row.traceId}`);
      }
      if (row.durationMs !== null && row.durationMs !== undefined) {
        parts.push(`${row.durationMs}ms`);
      }
      if (row.message) {
        parts.push(`"${row.message}"`);
      }
      if (row.fields && Object.keys(row.fields).length) {
        parts.push(JSON.stringify(row.fields));
      }
      parts.push(`[${row.process}:${row.pid} #${row.id}]`);
      return parts.join(' ');
    })
    .join('\n');
}

export function registerLogsTools(server, { base, readonly, now = () => Date.now() }) {
  async function getJson(path) {
    try {
      const response = await fetch(new URL(path, base), {
        headers: { 'X-Forge-Request': 'logs' },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      const body = await response.text();
      if (!response.ok) {
        log.warn('mcp.logs.request.failed', { route: '/api/logs', status: response.status });
        return { error: `Forge returned ${response.status}: ${body.slice(0, 500)}` };
      }
      return { value: JSON.parse(body) };
    } catch (error) {
      log.warn('mcp.logs.request.failed', { route: '/api/logs', error });
      return { error: `Cannot reach Forge Studio: ${error.message}` };
    }
  }

  server.registerTool(
    'forge_logs_query',
    {
      description:
        'Search the structured studio log (every Forge process, the browser and Python engines), newest first. Records hold event ids, ids, counts, durations, states and redacted error classes and messages; never prompts, typed text, file contents, paths or keys. Use traceId to follow one request or job across processes, and cursor to page back. For raw engine console output use forge_logs.',
      inputSchema: {
        ...filterSchema,
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z
          .string()
          .regex(/^\d{1,15}_\d{1,15}$/)
          .optional()
          .describe('nextCursor from a previous call, to read older records.'),
      },
      annotations: readonly,
    },
    async (input) => {
      const params = toSearchParams(input, now);
      params.set('limit', String(input.limit ?? 50));
      if (input.cursor) {
        params.set('cursor', input.cursor);
      }
      const result = await getJson(`/api/logs?${params}`);
      if (result.error) {
        return { isError: true, content: [{ type: 'text', text: result.error }] };
      }
      const { rows, nextCursor } = result.value;
      const header = `${rows.length} record(s)${nextCursor ? `; older: cursor=${nextCursor}` : ''}`;
      return {
        content: [{ type: 'text', text: capText(`${header}\n${formatLogRows(rows)}`) }],
      };
    },
  );

  server.registerTool(
    'forge_logs_summary',
    {
      description:
        'Summarize the structured studio log: record counts by level and component, the most frequent events, dropped and collapsed record counters, database size, retention limits and ingest backlog. Accepts the same filters as forge_logs_query.',
      inputSchema: filterSchema,
      annotations: readonly,
    },
    async (input) => {
      const result = await getJson(`/api/logs/summary?${toSearchParams(input, now)}`);
      if (result.error) {
        return { isError: true, content: [{ type: 'text', text: result.error }] };
      }
      return {
        content: [{ type: 'text', text: capText(JSON.stringify(result.value, null, 2)) }],
      };
    },
  );
}
