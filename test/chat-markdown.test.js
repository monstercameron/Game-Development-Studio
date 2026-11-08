import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  chatMarkdownAllowedElements,
  chatMarkdownComponents,
} from '../src/chat-markdown-config.js';
import { splitMarkdownTables } from '../src/chat-markdown-tables.js';

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
    '<img src="https://example.com/track" onerror="alert(1)">',
  ].join('\n');
  const output = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      children: markdown,
      skipHtml: true,
      allowedElements: chatMarkdownAllowedElements,
      components: chatMarkdownComponents,
    }),
  );

  assert.match(output, /<h1>Encounter notes<\/h1>/);
  assert.match(output, /<strong>bold text<\/strong>/);
  assert.match(output, /<ul>[\s\S]*<li>one item<\/li>/);
  assert.match(
    output,
    /<pre tabindex="0" aria-label="Code block\. Scroll to read the full code\."><code class="language-js">startEncounter\(\);/,
  );
  assert.match(
    output,
    /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/,
  );
  assert.match(output, /Unsafe/);
  assert.match(output, /Email/);
  assert.doesNotMatch(output, /javascript:|mailto:|onerror|<img|<script/);
});

test('code blocks get a copy button and keep their scrollable label', () => {
  const output = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      children: '```js\nconst x = 1;\n```',
      skipHtml: true,
      allowedElements: chatMarkdownAllowedElements,
      components: chatMarkdownComponents,
    }),
  );
  assert.match(
    output,
    /<div class="chat-code-block"><button[^>]*aria-label="Copy code"[^>]*>Copy<\/button>/,
  );
  assert.match(output, /<pre tabindex="0" aria-label="Code block\./);
});

test('pipe tables become table segments and fenced code is left alone', () => {
  const segments = splitMarkdownTables(
    [
      'Before',
      '',
      '| Name | Qty |',
      '|:-----|----:|',
      '| **Potion** | 3 |',
      '| Ether \\| X | 12 |',
      '',
      'After',
      '',
      '```',
      '| not | a table |',
      '|-----|---------|',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(
    segments.map((segment) => segment.type),
    ['markdown', 'table', 'markdown'],
  );
  assert.deepEqual(segments[1].header, ['Name', 'Qty']);
  assert.deepEqual(segments[1].align, ['left', 'right']);
  assert.deepEqual(segments[1].rows, [
    ['**Potion**', '3'],
    ['Ether | X', '12'],
  ]);
  assert.match(segments[2].text, /\| not \| a table \|/);
  const noSeparator = splitMarkdownTables('a | b\nc | d');
  assert.deepEqual(
    noSeparator.map((segment) => segment.type),
    ['markdown'],
  );
});

test('table cells use inline-only Markdown, so raw HTML and unsafe links stay inert', () => {
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      children: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b**',
      skipHtml: true,
      allowedElements: ['strong', 'em', 'del', 'code', 'a', 'br'],
      unwrapDisallowed: true,
      components: chatMarkdownComponents,
    }),
  );
  assert.match(html, /<strong>b<\/strong>/);
  assert.doesNotMatch(html, /<img|onerror|javascript:|<p>/);
});
