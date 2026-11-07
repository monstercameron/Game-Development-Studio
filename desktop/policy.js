// Only the verified local Studio belongs inside the desktop renderer.
export function isStudioUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isExternalWebUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isAllowedPermission(permission, requestingOrigin, origin) {
  return (
    requestingOrigin === origin &&
    ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)
  );
}
