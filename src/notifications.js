export const notificationSettingsKey = 'forge-notification-settings';
export const defaultNotifications = { render: true, queue: true };

// The runtime monitor dispatches this event after observing a real completion.
export function announceCompletion(detail) {
  window.dispatchEvent(new CustomEvent('forge:completion', { detail }));
}

export function showCompletionNotification(detail) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  let settings = defaultNotifications;
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(notificationSettingsKey) || '{}') }; } catch {}
  if (!['render', 'queue'].includes(detail?.type) || !settings[detail.type]) return false;
  const title = detail.type === 'queue' ? 'Render queue complete' : 'Render complete';
  new Notification(title, { body: detail.name || (detail.type === 'queue' ? 'All queued renders have finished.' : 'Your asset is ready in Forge Studio.'), tag: detail.id ? `forge-${detail.type}-${detail.id}` : undefined });
  return true;
}
