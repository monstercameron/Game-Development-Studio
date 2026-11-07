import test from 'node:test';
import assert from 'node:assert/strict';
import {checkJsonSyntax, isStructuredJsonFormat, safeChatMarkdownHref} from '../src/chat-output.js';

test('structured JSON formats are identified without treating text as JSON', () => {
  assert.equal(isStructuredJsonFormat('json'), true);
  assert.equal(isStructuredJsonFormat('schema'), true);
  assert.equal(isStructuredJsonFormat('text'), false);
  assert.equal(isStructuredJsonFormat(undefined), false);
});

test('Markdown links accept absolute HTTP(S) destinations only', () => {
  assert.equal(safeChatMarkdownHref('https://example.com/path'), 'https://example.com/path');
  assert.equal(safeChatMarkdownHref('HTTP://example.com'), 'http://example.com/');
  assert.equal(safeChatMarkdownHref('javascript:alert(1)'), undefined);
  assert.equal(safeChatMarkdownHref('mailto:hello@example.com'), undefined);
  assert.equal(safeChatMarkdownHref('//example.com/path'), undefined);
  assert.equal(safeChatMarkdownHref('/relative/path'), undefined);
});

test('JSON syntax is checked only after a nonempty response completes', () => {
  assert.equal(checkJsonSyntax('{"name":', 'streaming'), 'unchecked');
  assert.equal(checkJsonSyntax('{"name":', 'failed'), 'unchecked');
  assert.equal(checkJsonSyntax('', 'streaming'), 'unchecked');
  assert.equal(checkJsonSyntax('', 'complete'), 'empty');
  assert.equal(checkJsonSyntax('{"name":"Mira"}', 'complete'), 'valid');
  assert.equal(checkJsonSyntax('[1,2,3]', 'complete'), 'valid');
  assert.equal(checkJsonSyntax('{name:"Mira"}', 'complete'), 'invalid');
});
