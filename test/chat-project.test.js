import test from 'node:test';
import assert from 'node:assert/strict';
import { chatProjectKey, chatStorageKey, normalizeSavedChats } from '../src/chat-project.js';

test('chat component identity and browser storage share project scope', () => {
  const projectIds = ['project-a', 'project-b'];

  for (const projectId of projectIds) {
    assert.equal(chatStorageKey(projectId), `forge-chat-v1:${chatProjectKey(projectId)}`);
  }
  assert.notEqual(chatStorageKey(projectIds[0]), chatStorageKey(projectIds[1]));
  assert.equal(chatProjectKey(null), 'unassigned');
  assert.equal(chatStorageKey(undefined), 'forge-chat-v1:unassigned');
});

test('saved streams are restored as interrupted and remain reusable', () => {
  const chats = normalizeSavedChats([
    {
      id: 'chat-1',
      messages: [
        { role: 'user', content: 'Continue this idea' },
        { role: 'assistant', content: 'Partial reply', streamStatus: 'streaming' },
        { role: 'assistant', content: 'Finished reply', streamStatus: 'complete' },
      ],
    },
  ]);

  assert.equal(chats[0].messages[1].streamStatus, 'interrupted');
  assert.equal(chats[0].messages[2].streamStatus, 'complete');
  assert.equal(chats[0].messages[0].content, 'Continue this idea');
});
