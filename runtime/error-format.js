// Plain-text and Markdown renderings of a captured error. Pure, so the studio's copy buttons,
// the GitHub issue body and the "copy all" export produce identical text from the same row.
// Callers pass rows that the errors service has already redacted.

export const STATUS_LABELS = Object.freeze({
  new: 'New',
  reviewed: 'Reviewed',
  resolved: 'Resolved',
  verified: 'Fixed (verified)',
  ignored: 'Ignored',
});

export const FIX_SOURCE_LABELS = Object.freeze({
  self: 'Fixed by the user',
  ai: 'Fixed with the AI suggestion',
  both: 'Fixed by the user with help from the AI suggestion',
});

/** Human label for a persisted source id such as engine:segmentation. */
export function sourceLabel(source) {
  if (source === 'browser') {
    return 'Browser';
  }
  if (source === 'queue') {
    return 'Render queue';
  }
  if (source === 'server') {
    return 'Studio server';
  }
  if (typeof source === 'string' && source.startsWith('engine:')) {
    return `Engine ${source.slice('engine:'.length)}`;
  }
  return 'Unknown source';
}

// A fence longer than any backtick run inside the text, so a stack cannot close the block.
export function fence(text, language = 'text') {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}${language}\n${text}\n${marks}`;
}

function capText(text, limit) {
  const value = String(text || '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… [truncated]`;
}

function contextLines(error) {
  const context = error.context || {};
  const lines = [];
  if (error.page) {
    lines.push(`Page: ${error.page}`);
  }
  if (error.jobId) {
    lines.push(`Job: ${error.jobId}${context.jobType ? ` (${context.jobType})` : ''}`);
  }
  if (context.jobStatus) {
    lines.push(`Job status: ${context.jobStatus}`);
  }
  if (context.log) {
    lines.push(`Log: ${context.log}`);
  }
  if (context.kind) {
    lines.push(`Kind: ${context.kind}`);
  }
  if (context.path) {
    lines.push(
      `Request: ${context.method || 'GET'} ${context.path} (${context.status ?? 'network'})`,
    );
  }
  return lines;
}

export function formatErrorText(error) {
  return [
    `[${sourceLabel(error.source)}] ${error.message}`,
    `Status: ${STATUS_LABELS[error.status] || error.status}`,
    `Seen ${error.count} time${error.count === 1 ? '' : 's'}: first ${error.firstSeen}, last ${error.lastSeen}`,
    ...contextLines(error),
    `Fingerprint: ${error.fingerprint}`,
    '',
    error.stack || '(no stack trace)',
  ].join('\n');
}

export function formatErrorMarkdown(error) {
  return [
    `### ${sourceLabel(error.source)}: ${String(error.message).split('\n')[0].slice(0, 200)}`,
    '',
    `- Status: ${STATUS_LABELS[error.status] || error.status}`,
    `- Seen: ${error.count} time${error.count === 1 ? '' : 's'} (first ${error.firstSeen}, last ${error.lastSeen})`,
    ...contextLines(error).map((line) => `- ${line}`),
    `- Fingerprint: \`${error.fingerprint}\``,
    '',
    '**Message**',
    '',
    fence(error.message),
    '',
    '**Stack trace**',
    '',
    fence(error.stack || '(no stack trace)'),
  ].join('\n');
}

export function formatStackOnly(error) {
  return error.stack || error.message || '';
}

/** Several errors as one Markdown document, for "Copy all new". */
export function formatErrorsMarkdown(errors) {
  if (!errors.length) {
    return 'No errors.';
  }
  return [`# Forge errors (${errors.length})`, '', ...errors.map(formatErrorMarkdown)].join('\n\n');
}

/** A ready-made prompt to paste into another assistant. Nothing is sent by Forge. */
export function formatFixPrompt(error) {
  const parts = [
    'I am debugging Forge, a local React 19 + Vite studio with a Node 24 backend and Python model workers.',
    'Paths are redacted: <repo> is the repository root, <projects> the projects folder, <runtime> the runtime state folder.',
    'Explain the error, the likely root cause, and suggest a fix as a unified diff. Say how confident you are and what I should check.',
    '',
    formatErrorMarkdown(error),
  ];
  if (error.suggestion) {
    parts.push('', '**Earlier AI suggestion (unverified)**', '', error.suggestion);
  }
  return parts.join('\n');
}

export const ISSUE_LIMITS = Object.freeze({
  title: 120,
  stack: 12000,
  note: 4000,
  suggestion: 8000,
  body: 60000,
});

/**
 * Builds the GitHub issue title and body for a verified fix.
 *
 * @param {object} error A redacted error row.
 * @param {{appVersion: string, platform: string, arch: string, nodeVersion: string}} environment
 */
export function buildIssueContent(error, environment) {
  const firstLine = String(error.message).split('\n')[0].trim();
  const title = `[${error.source}] ${firstLine}`.slice(0, ISSUE_LIMITS.title);
  const engine = error.source.startsWith('engine:') ? error.source.slice(7) : 'none';
  const fixLines = [];
  if (error.fixSource) {
    fixLines.push(
      `**How it was fixed:** ${FIX_SOURCE_LABELS[error.fixSource] || error.fixSource}.`,
    );
  }
  if (error.fixNote) {
    fixLines.push(
      '',
      "**User's note on what fixed it:**",
      '',
      capText(error.fixNote, ISSUE_LIMITS.note),
    );
  }
  if (error.suggestion && error.fixSource !== 'self') {
    fixLines.push(
      '',
      `**AI-generated suggestion (${error.suggestionModel || 'unknown model'}, ${error.suggestionAt || 'unknown time'}). It was produced by a language model and may be wrong:**`,
      '',
      fence(capText(error.suggestion, ISSUE_LIMITS.suggestion), 'markdown'),
    );
  }
  if (!fixLines.length) {
    fixLines.push('The reporter marked this fix as working but did not add a note.');
  }
  const body = [
    '## Summary',
    '',
    `${firstLine.slice(0, 500)}`,
    '',
    `Reported from Forge's error review after the fix was confirmed to work. Seen ${error.count} time${error.count === 1 ? '' : 's'}.`,
    '',
    '## Environment',
    '',
    `- Forge version: ${environment.appVersion}`,
    `- OS: ${environment.platform} ${environment.arch}`,
    `- Node: ${environment.nodeVersion}`,
    `- Source: ${sourceLabel(error.source)} (\`${error.source}\`)`,
    `- Engine id: ${engine}`,
    ...(error.context?.jobType ? [`- Job type: ${error.context.jobType}`] : []),
    '',
    '## Error',
    '',
    fence(capText(error.stack || error.message, ISSUE_LIMITS.stack)),
    '',
    '## Root cause / fix that worked',
    '',
    ...fixLines,
    '',
    '## Fingerprint',
    '',
    `- Fingerprint: \`${error.fingerprint}\``,
    `- Count: ${error.count}`,
    `- First seen: ${error.firstSeen}`,
    `- Last seen: ${error.lastSeen}`,
    '',
    '_Local paths, user names, keys, tokens and email addresses were redacted by Forge. Prompts are never included._',
  ].join('\n');
  return {
    title,
    body:
      body.length <= ISSUE_LIMITS.body
        ? body
        : `${body.slice(0, ISSUE_LIMITS.body)}\n… [truncated]`,
  };
}
