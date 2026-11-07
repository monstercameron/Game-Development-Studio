import React from 'react';
import ReactMarkdown from 'react-markdown';
import {chatMarkdownAllowedElements, chatMarkdownComponents} from './chat-markdown-config.js';

export default function ChatMarkdown({content}) {
  return <div className="chat-markdown"><ReactMarkdown skipHtml allowedElements={chatMarkdownAllowedElements} components={chatMarkdownComponents}>{content}</ReactMarkdown></div>;
}
