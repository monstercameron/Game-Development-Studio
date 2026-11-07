import test from 'node:test';
import assert from 'node:assert/strict';
import { chatProjectKey, chatStorageKey } from '../src/chat-project.js';

test('chat component identity and browser storage share project scope', () => {
  const projectIds = ['project-a', 'project-b'];

  for (const projectId of projectIds) {
    assert.equal(chatStorageKey(projectId), `forge-chat-v1:${chatProjectKey(projectId)}`);
  }
  assert.notEqual(chatStorageKey(projectIds[0]), chatStorageKey(projectIds[1]));
  assert.equal(chatProjectKey(null), 'unassigned');
  assert.equal(chatStorageKey(undefined), 'forge-chat-v1:unassigned');
});
