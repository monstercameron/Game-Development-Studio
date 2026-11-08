// Only the verified local Studio belongs inside the desktop renderer.
export function isStudioUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    // log-coverage: ignore -- not a valid URL is an expected result; logging it would leak the URL
    return false;
  }
}

export function isExternalWebUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    // log-coverage: ignore -- not a valid URL is an expected result; logging it would leak the URL
    return false;
  }
}

/**
 * Decides whether a renderer permission request may be granted.
 * Only the Studio's own origin is allowed, and only for the listed permissions.
 *
 * @param {string} permission Electron permission name, such as 'media'.
 * @param {string} requestingOrigin Origin that made the request.
 * @param {string} origin Origin of the verified local Studio.
 * @returns {boolean} true only when the origins match and the permission is allowlisted.
 */
export function isAllowedPermission(permission, requestingOrigin, origin) {
  return (
    requestingOrigin === origin &&
    ['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)
  );
}
