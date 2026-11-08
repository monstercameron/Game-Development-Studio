// A later node in the DOM is not necessarily the top dialog: Forge's asset,
// inspection, and confirmation overlays deliberately use different z-layers.
export function selectTopModal(dialogs, { visible, zIndex }) {
  let top = null;
  let highest = -Infinity;
  for (const dialog of dialogs) {
    if (!visible(dialog)) {
      continue;
    }
    const level = zIndex(dialog);
    if (level >= highest) {
      highest = level;
      top = dialog;
    }
  }
  return top;
}

export function topModal() {
  const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
  return selectTopModal(dialogs, {
    visible: (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    },
    zIndex: (element) => {
      const layer = element.closest('.modal-backdrop,.inspection-backdrop') || element;
      const value = Number.parseFloat(getComputedStyle(layer).zIndex);
      return Number.isFinite(value) ? value : 0;
    },
  });
}
