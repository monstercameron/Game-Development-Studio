export function isStructuredJsonFormat(format) {
  return format === 'json' || format === 'schema';
}

export function safeChatMarkdownHref(href) {
  if (typeof href !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
    // log-coverage: ignore -- pure check called during render; an unparsable link is normal.
  } catch {
    return undefined;
  }
}

export function checkJsonSyntax(content, streamStatus) {
  if (streamStatus !== 'complete') {
    return 'unchecked';
  }
  if (!content?.trim()) {
    return 'empty';
  }
  try {
    JSON.parse(content);
    return 'valid';
    // log-coverage: ignore -- pure check called during render; invalid JSON is a result.
  } catch {
    return 'invalid';
  }
}
