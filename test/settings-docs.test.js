import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SETTING_DEFINITIONS } from '../runtime/core-settings.js';

const read = (file) =>
  fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

test('docs/SETTINGS.md lists every registered key and every environment variable', () => {
  const guide = read('docs/SETTINGS.md');
  for (const definition of SETTING_DEFINITIONS) {
    assert.ok(
      guide.includes(`\`${definition.key}\``),
      `${definition.key} is missing from SETTINGS.md`,
    );
    for (const variable of definition.environment?.variables ?? []) {
      assert.ok(guide.includes(variable), `${variable} (${definition.key}) is missing`);
    }
  }
});

test('the MCP guide and the test guide mention the settings tools and tests', () => {
  const mcp = read('docs/MCP.md');
  for (const tool of ['forge_settings_list', 'forge_settings_set', 'forge_settings_reset']) {
    assert.ok(mcp.includes(tool), `${tool} is missing from MCP.md`);
  }
  const tests = read('test/README.md');
  assert.ok(tests.includes('core-settings.test.js'));
});
