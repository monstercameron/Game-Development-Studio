const ACTIONS = new Set(['open', 'minimize', 'maximize']);

// Queue the latest tray request until the window exists and is ready to show.
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
