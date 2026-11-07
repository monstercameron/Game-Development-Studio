import React from 'react';
import {safeChatMarkdownHref} from './chat-output.js';

function ChatMarkdownLink({href, children}) {
  const safeHref = safeChatMarkdownHref(href);
  return safeHref
    ? React.createElement('a', {href: safeHref, target: '_blank', rel: 'noopener noreferrer'}, children)
    : React.createElement('span', null, children);
}

function ChatMarkdownPre({children}) {
  return React.createElement('pre', {tabIndex: 0, 'aria-label': 'Code block. Scroll to read the full code.'}, children);
}

export const chatMarkdownComponents = {a: ChatMarkdownLink, img: () => null, pre: ChatMarkdownPre};
export const chatMarkdownAllowedElements = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'blockquote', 'pre', 'code', 'hr', 'br', 'a'];
