import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { topModal } from '../modal-layer';
import './field-help.css';

/*
 * Field help is injected inline: a small "?" button sits in normal layout flow right after each
 * label's text. Nothing is positioned or measured on scroll, resize or animation, so the buttons
 * cannot lag or drift. Discovery runs on a short debounce and only when elements are added,
 * removed or toggled; the tooltip is placed once, when it opens.
 */

const SLOT_CLASS = 'field-help-slot';
const DISCOVERY_DELAY = 150;
const CONTROL_SELECTOR =
  'input:not([type="hidden"]),select,textarea,button[aria-pressed],button[role="switch"],[role="slider"]';

const clean = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(OPTIONAL|REQUIRED(?: FOR (?:A TEST|RENDER|3D|VIDEO|SEGMENTATION))?)\s*$/i, '')
    .trim();

function labelText(label) {
  const clone = label.cloneNode(true);
  clone
    .querySelectorAll(`input,select,textarea,button,svg,small,option,p,.${SLOT_CLASS}`)
    .forEach((node) => node.remove());
  return clean(clone.textContent);
}

function isVisible(element) {
  if (!element?.isConnected) {
    return false;
  }
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ visibilityProperty: true });
  }
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** The last piece of visible label text, after which the help button is placed. */
function lastLabelText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue.trim() &&
        !node.parentElement?.closest(`select,textarea,button,small,svg,option,p,.${SLOT_CLASS}`)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let last = null;
  while (walker.nextNode()) {
    last = walker.currentNode;
  }
  return last;
}

/** Creates (or reuses) the slot that follows an anchor's text, or null when it has no text. */
function slotFor(anchor, existing) {
  const root = anchor.classList?.contains('upload-box')
    ? anchor.querySelector('strong') || anchor
    : anchor;
  const text = lastLabelText(root);
  if (!text) {
    return null;
  }
  // Put the slot after a wrapping element such as the "REQUIRED" tag, not inside it.
  const after = text.parentElement && text.parentElement !== root ? text.parentElement : text;
  if (existing?.isConnected && existing.previousSibling === after) {
    return existing;
  }
  existing?.remove();
  const slot = document.createElement('span');
  slot.className = SLOT_CLASS;
  after.after(slot);
  return slot;
}

function findTargets(scope, tips, common, described, section) {
  const found = [];
  const ratingGroups = new Set(),
    layoutGroups = new Set();
  const add = (key, name, text, anchor) => {
    if (anchor && isVisible(anchor)) {
      found.push({ key: `${section}:${key}`, name, text, anchor });
    }
  };
  for (const control of scope.querySelectorAll(CONTROL_SELECTOR)) {
    if (control.closest('[inert],details:not([open]),.field-help-layer')) {
      continue;
    }
    const candidates = [...(control.labels || [])].filter(isVisible);
    const label =
      candidates.find(
        (item) => Object.hasOwn(tips, labelText(item)) || Object.hasOwn(common, labelText(item)),
      ) || candidates[0];
    let name = label
      ? labelText(label)
      : clean(control.getAttribute('aria-label') || control.textContent);
    let text = tips[name] || common[name];
    if (!text && control.getAttribute('aria-label')) {
      name = clean(control.getAttribute('aria-label'));
      text = tips[name] || common[name];
    }
    if (!text && label) {
      const strong = label.querySelector('strong');
      if (strong) {
        name = clean(strong.textContent);
        text = tips[name] || common[name];
      }
    }
    if (!text || (label && !isVisible(label)) || (!isVisible(control) && control.type !== 'file')) {
      continue;
    }
    // Keep every control's accessible description even where no visible button is shown.
    const previous = described.get(control);
    if (
      !control.hasAttribute('aria-description') ||
      (previous && control.getAttribute('aria-description') === previous)
    ) {
      control.setAttribute('aria-description', text);
      described.set(control, text);
    }
    const rating = control.closest('[role="group"][aria-label="Asset rating"]');
    if (rating && /^Rate [1-5] out of 5$/.test(name)) {
      // Five stars are one choice: show one help button beside the group's title.
      if (!ratingGroups.has(rating)) {
        ratingGroups.add(rating);
        const anchor =
          rating.closest('.asset-rating,.iteration-rating')?.querySelector('strong,span') || null;
        add(
          'rating',
          'Asset rating',
          tips['Asset rating'] ||
            common['Asset rating'] ||
            'Rate this asset from one to five stars.',
          anchor,
        );
      }
      continue;
    }
    const layout = control.closest('.layout-switch[role="group"]');
    if (layout && (name === 'Grid view' || name === 'List view')) {
      if (!layoutGroups.has(layout)) {
        layoutGroups.add(layout);
        const groupText = tips['Display layout'] || common['Display layout'];
        const anchor = layout.querySelector('.gallery-control-label');
        if (groupText && anchor) {
          add('layout', 'Display layout', groupText, anchor);
        }
      }
      continue;
    }
    const namedAnchor =
      !label && name === 'Current project'
        ? control.closest('.workspace')?.querySelector('strong')
        : null;
    const anchor = label || namedAnchor;
    // Controls with no visible text to sit beside keep their description but get no button.
    if (anchor) {
      add(`${name}:${found.length}`, name, text, anchor);
    }
  }
  return found;
}

function HelpButton({ target, open, setOpen }) {
  const buttonRef = useRef(null);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="field-help-trigger"
      aria-label={`Help: ${target.name}`}
      aria-expanded={open ? 'true' : 'false'}
      aria-describedby={open ? 'forge-field-help' : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          setOpen({ key: target.key, element: buttonRef.current, text: target.text });
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          setOpen((current) => (current?.key === target.key ? null : current));
        }
      }}
      onFocus={() => setOpen({ key: target.key, element: buttonRef.current, text: target.text })}
      onBlur={() => setOpen((current) => (current?.key === target.key ? null : current))}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen({ key: target.key, element: buttonRef.current, text: target.text });
      }}
    >
      <CircleHelp size={14} aria-hidden="true" />
    </button>
  );
}

function Popover({ open }) {
  const [style, setStyle] = useState({ visibility: 'hidden' });
  const ref = useRef(null);
  useEffect(() => {
    const place = () => {
      const anchor = open.element?.getBoundingClientRect();
      const box = ref.current?.getBoundingClientRect();
      if (!anchor || !box) {
        return;
      }
      const margin = 8;
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
      const below = anchor.bottom + 6;
      const top =
        below + box.height + margin > window.innerHeight
          ? Math.max(margin, anchor.top - box.height - 6)
          : below;
      setStyle({ left, top });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return createPortal(
    <div
      ref={ref}
      className="field-help-popover"
      id="forge-field-help"
      role="tooltip"
      style={style}
    >
      {open.text}
    </div>,
    topModal() || document.body,
  );
}

/** Adds accessible, focusable help to existing controls without changing form values. */
export default function FieldHelp({ section, tooltips }) {
  const [targets, setTargets] = useState([]),
    [open, setOpen] = useState(null);
  useEffect(() => {
    const root = document.querySelector('.app-shell');
    if (!root) {
      return;
    }
    const described = new Map();
    const slots = new Map();
    let timer = 0;
    const discover = () => {
      timer = 0;
      const scope = topModal() || root;
      const tips = tooltips[section] || {},
        common = tooltips.common || {};
      const found = findTargets(scope, tips, common, described, section);
      const keep = new Set();
      const next = [];
      for (const target of found) {
        const slot = slotFor(target.anchor, slots.get(target.anchor));
        if (!slot) {
          continue;
        }
        slots.set(target.anchor, slot);
        keep.add(target.anchor);
        next.push({ ...target, slot });
      }
      for (const [anchor, slot] of slots) {
        if (!keep.has(anchor)) {
          slot.remove();
          slots.delete(anchor);
        }
      }
      setTargets((current) =>
        current.length === next.length &&
        current.every(
          (item, index) =>
            item.key === next[index].key &&
            item.slot === next[index].slot &&
            item.text === next[index].text,
        )
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (!timer) {
        timer = setTimeout(discover, DISCOVERY_DELAY);
      }
    };
    const ours = (node) =>
      node.nodeType === Node.ELEMENT_NODE
        ? node.classList.contains(SLOT_CLASS) || Boolean(node.closest?.(`.${SLOT_CLASS}`))
        : Boolean(node.parentElement?.closest(`.${SLOT_CLASS}`));
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        if (ours(record.target)) {
          return false;
        }
        if (record.type === 'attributes') {
          return true;
        }
        const nodes = [...record.addedNodes, ...record.removedNodes];
        return nodes.some((node) => node.nodeType === Node.ELEMENT_NODE && !ours(node));
      });
      if (relevant) {
        schedule();
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'disabled'],
    });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      clearTimeout(timer);
      for (const slot of slots.values()) {
        slot.remove();
      }
      for (const [control, text] of described) {
        if (control.getAttribute('aria-description') === text) {
          control.removeAttribute('aria-description');
        }
      }
      setTargets([]);
    };
  }, [section, tooltips]);
  useEffect(() => {
    const escape = (event) => {
      if (event.key === 'Escape') {
        setOpen(null);
      }
    };
    const dismiss = (event) => {
      if (!event.target.closest?.('.field-help-trigger')) {
        setOpen(null);
      }
    };
    window.addEventListener('keydown', escape);
    document.addEventListener('pointerdown', dismiss);
    return () => {
      window.removeEventListener('keydown', escape);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, []);
  useEffect(() => {
    setOpen(null);
  }, [section]);
  return (
    <>
      {targets.map((target) =>
        createPortal(
          <HelpButton
            key={target.key}
            target={target}
            open={open?.key === target.key}
            setOpen={setOpen}
          />,
          target.slot,
          target.key,
        ),
      )}
      {open && <Popover open={open} />}
    </>
  );
}
