// MCP tools for Forge's core settings and toggles. They call the loopback /api/settings routes,
// which validate against the typed registry in runtime/core-settings.js and apply the same
// Origin and X-Forge-Request checks as Studio. Nothing here reaches credentials, consent
// confirmations, security checks, network binding, folders, executables or destructive actions.
import { z } from 'zod';
import { MAX_SETTING_CHANGES, SETTING_GROUPS } from './core-settings.js';

const change = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const groupId = z.enum(SETTING_GROUPS.map((group) => group.id));
const settingKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){1,4}$/)
  .max(80)
  .describe('A setting key from forge_settings_list, for example engines.autoStart.trellis.');
const settingValue = z
  .union([z.boolean(), z.number(), z.string().max(200), z.null()])
  .describe('The new value; it must match the type, allowed values and range that the list shows.');

function refusal(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function registerSettingsTools(server, { read, write, readonly }) {
  server.registerTool(
    'forge_settings_list',
    {
      description:
        'List Forge core settings and toggles with their current value, default, type and allowed values, when a change takes effect (live, next-job or restart-required), where the value comes from (default, override, environment or store), whether it is locked by an environment variable (and which one), and the last few changes. Covers engine auto-start and model auto-loading, the host-memory check, chained-render unloading, speech chunk size, the AI assist provider and model ids, the default interface language, the tray icon and keep awake. It never lists API keys, consent confirmations, security checks, network binding, folders or executables.',
      inputSchema: {
        group: groupId
          .optional()
          .describe('Only this group: ' + SETTING_GROUPS.map((item) => item.id).join(', ') + '.'),
      },
      annotations: readonly,
    },
    ({ group }) =>
      read(group ? `/api/settings?group=${encodeURIComponent(group)}` : '/api/settings'),
  );
  server.registerTool(
    'forge_settings_set',
    {
      description: `Change one setting (key and value) or up to ${MAX_SETTING_CHANGES} at once (changes). A batch is applied all or nothing: if any item is unknown, read-only, locked by an environment variable or invalid, nothing changes. Returns the old and new value, when the change takes effect and whether a restart is needed. A setting locked by an environment variable is refused with the variable's name; the environment is never overridden. Settings that start workers or load models raise memory use, and an AI assist model only names which model is used: nothing is sent to OpenAI until a person asks in Studio. Setting values never include credentials; never pass secrets here.`,
      inputSchema: {
        key: settingKey.optional(),
        value: settingValue.optional(),
        changes: z
          .array(z.object({ key: settingKey, value: settingValue }).strict())
          .min(1)
          .max(MAX_SETTING_CHANGES)
          .optional()
          .describe('Several changes to apply together. Use this or key and value, not both.'),
      },
      annotations: change,
    },
    ({ key, value, changes }) => {
      const single = key !== undefined || value !== undefined;
      if (single === (changes !== undefined)) {
        return refusal('Give either key and value, or changes, but not both.');
      }
      if (single && (key === undefined || value === undefined)) {
        return refusal('A single change needs both key and value.');
      }
      return write(
        '/api/settings',
        { changes: single ? [{ key, value }] : changes, via: 'mcp' },
        30000,
        'settings',
      );
    },
  );
  server.registerTool(
    'forge_settings_reset',
    {
      description:
        'Put one setting (key), or every changeable setting of a group, back to its default. A setting locked by an environment variable is refused for a key and skipped (and reported) for a group. It returns the old and new values and when each takes effect.',
      inputSchema: {
        key: settingKey.optional(),
        group: groupId.optional(),
      },
      annotations: change,
    },
    ({ key, group }) => {
      if ((key === undefined) === (group === undefined)) {
        return refusal('Give either key or group, but not both.');
      }
      return write(
        '/api/settings/reset',
        { ...(key ? { key } : { group }), via: 'mcp' },
        30000,
        'settings',
      );
    },
  );
}
