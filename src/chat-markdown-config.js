import React, { useState } from 'react';
import { createLog } from './app-log.js';
import { safeChatMarkdownHref } from './chat-output.js';

const log = createLog('chat');

function ChatMarkdownLink({ href, children }) {
  const safeHref = safeChatMarkdownHref(href);
  return safeHref
    ? React.createElement(
        'a',
        { href: safeHref, target: '_blank', rel: 'noopener noreferrer' },
        children,
      )
    : React.createElement('span', null, children);
}

// The plain text of a rendered code block, for the copy button.
export function textOfNode(node) {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOfNode).join('');
  }
  return node?.props ? textOfNode(node.props.children) : '';
}

function ChatMarkdownPre({ children }) {
  const [state, setState] = useState('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textOfNode(children).replace(/\n$/, ''));
      setState('copied');
    } catch (error) {
      log.debug('chat.clipboard.write.failed', { errorClass: error?.name || 'Error' });
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1800);
  };
  let label = 'Copy';
  if (state === 'copied') {
    label = 'Copied';
  } else if (state === 'failed') {
    label = 'Copy failed';
  }
  return React.createElement(
    'div',
    { className: 'chat-code-block' },
    React.createElement(
      'button',
      { type: 'button', className: 'chat-code-copy', 'aria-label': 'Copy code', onClick: copy },
      label,
    ),
    React.createElement(
      'span',
      { className: 'sr-only', role: 'status' },
      state === 'idle' ? '' : label,
    ),
    React.createElement(
      'pre',
      { tabIndex: 0, 'aria-label': 'Code block. Scroll to read the full code.' },
      children,
    ),
  );
}

export const chatMarkdownComponents = {
  a: ChatMarkdownLink,
  img: () => null,
  pre: ChatMarkdownPre,
};
export const chatMarkdownAllowedElements = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'del',
  'blockquote',
  'pre',
  'code',
  'hr',
  'br',
  'a',
];
