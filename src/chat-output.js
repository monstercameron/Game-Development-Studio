export function isStructuredJsonFormat(format) {
  return format === 'json' || format === 'schema';
}

/**
 * Returns the normalized URL only for absolute http(s) links. Anything else
 * (javascript:, mailto:, protocol-relative, relative, unparsable) yields undefined
 * so the markdown renderer drops the link instead of emitting an unsafe href.
 */
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

/**
 * Classifies streamed structured output for display.
 * 'unchecked': the stream has not completed, so partial JSON is not judged.
 * 'empty': the completed content is blank.
 * 'valid' or 'invalid': the result of JSON.parse on the completed content.
 */
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
