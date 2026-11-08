import { createLog } from './app-log.js';
import { sanitizeSwitches } from './storage-tolerance.js';

export const notificationSettingsKey = 'forge-notification-settings';
export const defaultNotifications = { render: true, queue: true };

const log = createLog('ui');

// The runtime monitor dispatches this event after observing a real completion.
export function announceCompletion(detail) {
  window.dispatchEvent(new CustomEvent('forge:completion', { detail }));
}

export function showCompletionNotification(detail) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    log.debug('ui.notification.skipped', {
      reason: 'permission_not_granted',
      isSupported: 'Notification' in window,
    });
    return false;
  }
  let settings = defaultNotifications;
  try {
    settings = sanitizeSwitches(
      JSON.parse(localStorage.getItem(notificationSettingsKey) || '{}'),
      defaultNotifications,
    );
  } catch (error) {
    // Invalid or unavailable browser storage leaves notification defaults in place.
    log.debug('ui.settings.read.failed', {
      settingKey: notificationSettingsKey,
      errorClass: error?.name || 'Error',
    });
  }
  if (!['render', 'queue'].includes(detail?.type) || !settings[detail.type]) {
    log.debug('ui.notification.skipped', { reason: 'disabled_or_unknown_type' });
    return false;
  }
  const title = detail.type === 'queue' ? 'Render queue complete' : 'Render complete';
  new Notification(title, {
    body:
      detail.name ||
      (detail.type === 'queue'
        ? 'All queued renders have finished.'
        : 'Your asset is ready in Forge Studio.'),
    tag: detail.id ? `forge-${detail.type}-${detail.id}` : undefined,
  });
  log.info('ui.notification.shown', { type: detail.type });
  return true;
}
