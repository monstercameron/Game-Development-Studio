import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import {renderToStaticMarkup} from 'react-dom/server';
import {chatMarkdownAllowedElements, chatMarkdownComponents} from '../src/chat-markdown-config.js';

test('chat Markdown renders CommonMark while dropping HTML and unsafe destinations', () => {
  const markdown = [
    '# Encounter notes',
    '',
    'Use **bold text** and:',
    '',
    '- one item',
    '- another item',
    '',
    '```js',
    'startEncounter();',
    '```',
    '',
    '[Docs](https://example.com/docs) [Unsafe](javascript:alert(1)) [Email](mailto:dev@example.com)',
    '',
    '<img src="https://example.com/track" onerror="alert(1)">'
  ].join('\n');
  const output = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    children: markdown,
    skipHtml: true,
    allowedElements: chatMarkdownAllowedElements,
    components: chatMarkdownComponents
  }));

  assert.match(output, /<h1>Encounter notes<\/h1>/);
  assert.match(output, /<strong>bold text<\/strong>/);
  assert.match(output, /<ul>[\s\S]*<li>one item<\/li>/);
  assert.match(output, /<pre tabindex="0" aria-label="Code block\. Scroll to read the full code\."><code class="language-js">startEncounter\(\);/);
  assert.match(output, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/);
  assert.match(output, /Unsafe/);
  assert.match(output, /Email/);
  assert.doesNotMatch(output, /javascript:|mailto:|onerror|<img|<script/);
});
