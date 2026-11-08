import ReactMarkdown from 'react-markdown';
import { chatMarkdownAllowedElements, chatMarkdownComponents } from './chat-markdown-config.js';
import { splitMarkdownTables } from './chat-markdown-tables.js';
import './chat-markdown-extras.css';

const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code', 'a', 'br'];

function Inline({ text }) {
  return (
    <ReactMarkdown
      skipHtml
      allowedElements={INLINE_ELEMENTS}
      unwrapDisallowed
      components={chatMarkdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
}

function ChatTable({ header, align, rows }) {
  return (
    <div
      className="chat-table-wrap"
      role="region"
      tabIndex={0}
      aria-label="Table. Scroll to read the full table."
    >
      <table>
        <thead>
          <tr>
            {header.map((cell, column) => (
              <th key={column} scope="col" style={{ textAlign: align[column] || undefined }}>
                <Inline text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => (
                <td key={column} style={{ textAlign: align[column] || undefined }}>
                  <Inline text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ChatMarkdown({ content }) {
  return (
    <div className="chat-markdown">
      {splitMarkdownTables(content).map((segment, index) =>
        segment.type === 'table' ? (
          <ChatTable key={index} {...segment} />
        ) : (
          <ReactMarkdown
            key={index}
            skipHtml
            allowedElements={chatMarkdownAllowedElements}
            components={chatMarkdownComponents}
          >
            {segment.text}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}
