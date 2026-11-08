import { useLayoutEffect, useRef } from 'react';
import { topModal } from './modal-layer.js';

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(dialog) {
  return [...dialog.querySelectorAll(FOCUSABLE)].filter(
    (element) =>
      !element.matches(':disabled') &&
      element.getClientRects().length &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]'),
  );
}

/** Keeps keyboard focus inside a modal and returns it to the opener when closed. */
export default function useDialogFocus({ onClose, initialFocus, fallbackFocus } = {}) {
  const dialog = useRef(null);
  const onCloseRef = useRef(onClose);
  const initialFocusRef = useRef(initialFocus);
  const fallbackFocusRef = useRef(fallbackFocus);
  onCloseRef.current = onClose;
  fallbackFocusRef.current = fallbackFocus;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    const previous = document.activeElement;
    const focusInitial = () => {
      const selector = initialFocusRef.current;
      const preferred = selector && element.querySelector(selector);
      const target =
        (preferred &&
          !preferred.matches(':disabled,[hidden],[inert]') &&
          preferred.getClientRects().length &&
          preferred) ||
        focusableWithin(element)[0] ||
        element;
      target.focus();
    };
    focusInitial();

    // Only the topmost modal reacts, so stacked dialogs do not both close on one Escape.
    const isTopmost = () => topModal() === element;
    const handleKeyDown = (event) => {
      if (!isTopmost()) {
        return;
      }
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const controls = focusableWithin(element);
      if (!controls.length) {
        event.preventDefault();
        element.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !element.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      // The opener may have been unmounted or hidden while the dialog was open, so only
      // restore focus to a connected, visible, focusable candidate.
      const canRestore = (candidate) =>
        candidate?.isConnected &&
        candidate !== document.body &&
        candidate !== document.documentElement &&
        typeof candidate.focus === 'function' &&
        (candidate.matches(FOCUSABLE) ||
          candidate.hasAttribute('tabindex') ||
          candidate.isContentEditable) &&
        !candidate.matches(':disabled,[hidden],[inert]') &&
        candidate.getClientRects().length &&
        !candidate.closest('[hidden],[inert],[aria-hidden="true"]');
      if (canRestore(previous)) {
        previous.focus();
        if (document.activeElement === previous) {
          return;
        }
      }
      const fallback = fallbackFocusRef.current;
      const preferred =
        typeof fallback === 'function'
          ? fallback()
          : typeof fallback === 'string'
            ? document.querySelector(fallback)
            : fallback;
      if (canRestore(preferred)) {
        preferred.focus();
        if (document.activeElement === preferred) {
          return;
        }
      }
      const scope = previous?.closest?.('[role="dialog"],aside,section,form');
      const nearby = scope && focusableWithin(scope).find(canRestore);
      if (canRestore(nearby)) {
        nearby.focus();
      }
    };
  }, []);

  return dialog;
}
