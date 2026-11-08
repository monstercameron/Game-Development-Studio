const ACTIONS = new Set(['open', 'minimize', 'maximize']);

/**
 * Applies tray or launch requests to the main window.
 *
 * Only the latest request is kept while the window is missing, destroyed or not yet ready,
 * because repeated tray clicks should not replay a stale sequence of show/minimize actions.
 * An unknown `initial` value falls back to 'open'.
 *
 * @param {() => import('electron').BrowserWindow | null | undefined} getWindow
 *   Returns the current window; called on every request so a recreated window is used.
 * @param {string} [initial='open'] Action to run once `ready()` is called.
 * @returns {{ request(action: string): void, ready(): void }}
 */
export function createWindowActions(getWindow, initial = 'open') {
  let ready = false;
  let pending = ACTIONS.has(initial) ? initial : 'open';
  function apply(action) {
    const window = getWindow();
    if (!ready || !window || window.isDestroyed()) {
      pending = action;
      return;
    }
    if (action === 'minimize') {
      if (!window.isVisible()) {
        window.show();
      }
      window.minimize();
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    if (action === 'maximize') {
      window.maximize();
    }
    window.focus();
  }
  return {
    request(action) {
      if (ACTIONS.has(action)) {
        apply(action);
      }
    },
    ready() {
      ready = true;
      const action = pending;
      pending = null;
      if (action) {
        apply(action);
      }
    },
  };
}
