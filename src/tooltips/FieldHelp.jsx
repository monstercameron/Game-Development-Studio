import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { topModal } from '../modal-layer';
import './field-help.css';

const clean = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(OPTIONAL|REQUIRED(?: FOR (?:A TEST|RENDER|3D|VIDEO|SEGMENTATION))?)\s*$/i, '')
    .trim();
function labelText(label) {
  const clone = label.cloneNode(true);
  clone
    .querySelectorAll('input,select,textarea,button,svg,small,option,p')
    .forEach((node) => node.remove());
  return clean(clone.textContent);
}
function isVisible(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  );
}
function anchorRect(label) {
  const source = label.classList.contains('upload-box')
    ? label.querySelector('strong') || label
    : label;
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue.trim() &&
        !node.parentElement?.closest('select,textarea,button,small,svg')
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let node,
    anchor = null;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (!anchor) {
        anchor = rect;
      } else if (Math.abs(rect.top - anchor.top) < 5 && rect.right > anchor.right) {
        anchor = rect;
      }
    }
  }
  return anchor || label.getBoundingClientRect();
}

/** Adds accessible, focusable help to existing controls without changing form values. */
export default function FieldHelp({ section, tooltips }) {
  const [targets, setTargets] = useState([]),
    [open, setOpen] = useState('');
  const [portalTarget, setPortalTarget] = useState(() =>
    typeof document === 'undefined' ? null : document.body,
  );
  useEffect(() => {
    let frame = 0;
    const root = document.querySelector('.app-shell');
    if (!root) {
      return;
    }
    const described = new Map();
    const refresh = () => {
      frame = 0;
      const dialog = topModal();
      const scope = dialog || root;
      // Help buttons belong inside the active modal so its keyboard focus trap
      // and accessibility tree can reach them. Otherwise they live above the app.
      setPortalTarget((current) => {
        const next = dialog || document.body;
        return current === next ? current : next;
      });
      const tips = tooltips[section] || {},
        common = tooltips.common || {},
        found = [],
        ratingGroups = new Set(),
        layoutGroups = new Set();
      let number = 0;
      for (const control of scope.querySelectorAll(
        'input:not([type="hidden"]),select,textarea,button[aria-pressed],button[role="switch"],[role="slider"]',
      )) {
        if (control.closest('[inert],details:not([open])')) {
          continue;
        }
        const candidates = [...(control.labels || [])].filter(isVisible);
        const label =
          candidates.find(
            (item) =>
              Object.hasOwn(tips, labelText(item)) || Object.hasOwn(common, labelText(item)),
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
        if (
          !text ||
          (label && !isVisible(label)) ||
          (!isVisible(control) && control.type !== 'file')
        ) {
          continue;
        }
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
          // The five stars are one choice, not five separate parameters. Keep
          // individual screen-reader descriptions but show one help control.
          if (!ratingGroups.has(rating)) {
            ratingGroups.add(rating);
            const anchor =
              rating.closest('.asset-rating,.iteration-rating')?.querySelector('strong,span') ||
              rating;
            const rect = anchorRect(anchor),
              groupText =
                tips['Asset rating'] ||
                common['Asset rating'] ||
                'Rate this asset from one to five stars.';
            if (
              rect.bottom >= 0 &&
              rect.top <= window.innerHeight &&
              rect.right >= 0 &&
              rect.left <= window.innerWidth
            ) {
              const left = Math.max(3, Math.min(window.innerWidth - 23, rect.right + 5)),
                top = Math.max(
                  3,
                  Math.min(window.innerHeight - 23, rect.top + (rect.height - 18) / 2),
                );
              found.push({
                key: `${section}-${number++}-Asset rating`,
                name: 'Asset rating',
                text: groupText,
                left,
                top,
                controlRect: rating.getBoundingClientRect(),
              });
            }
          }
          continue;
        }
        const layout = window.innerWidth >= 851 && control.closest('.layout-switch[role="group"]');
        if (layout && (name === 'Grid view' || name === 'List view')) {
          // Layout is one setting with two options; put its help beside the
          // group label instead of covering the compact view buttons.
          if (!layoutGroups.has(layout)) {
            layoutGroups.add(layout);
            const anchor = layout.querySelector('.gallery-control-label') || layout;
            const rect = anchorRect(anchor),
              groupText = tips['Display layout'] || common['Display layout'];
            if (
              groupText &&
              rect.bottom >= 0 &&
              rect.top <= window.innerHeight &&
              rect.right >= 0 &&
              rect.left <= window.innerWidth
            ) {
              const left = Math.max(3, Math.min(window.innerWidth - 23, rect.right + 5)),
                top = Math.max(
                  3,
                  Math.min(window.innerHeight - 23, rect.top + (rect.height - 18) / 2),
                );
              found.push({
                key: `${section}-${number++}-Display layout`,
                name: 'Display layout',
                text: groupText,
                left,
                top,
                controlRect: layout.getBoundingClientRect(),
              });
            }
          }
          continue;
        }
        const namedAnchor =
          !label && name === 'Current project'
            ? control.closest('.workspace')?.querySelector('strong')
            : null;
        const controlRect = control.getBoundingClientRect(),
          rect = label ? anchorRect(label) : namedAnchor ? anchorRect(namedAnchor) : controlRect;
        if (
          rect.bottom < 0 ||
          rect.top > window.innerHeight ||
          rect.right < 0 ||
          rect.left > window.innerWidth
        ) {
          continue;
        }
        const clip = (label || control).closest('.chat-config,.chat-messages,.runtime-job-list');
        if (clip) {
          const clipRect = clip.getBoundingClientRect();
          if (rect.bottom < clipRect.top || rect.top > clipRect.bottom) {
            continue;
          }
        }
        // The chat composer has no visible label; keep its help inside the
        // message field instead of floating over the composer's outside edge.
        const chatMessage =
          window.innerWidth >= 851 && name === 'Message' && control.closest('.chat-composer');
        const left = Math.max(
          3,
          Math.min(
            window.innerWidth - 23,
            chatMessage ? rect.right - 26 : label || namedAnchor ? rect.right + 5 : rect.left - 22,
          ),
        );
        const top = Math.max(
          3,
          Math.min(
            window.innerHeight - 23,
            chatMessage ? rect.top + 2 : rect.top + (rect.height - 18) / 2,
          ),
        );
        found.push({ key: `${section}-${number++}-${name}`, name, text, left, top, controlRect });
      }
      setTargets(found);
    };
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(refresh);
      }
    };
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const element =
          record.target.nodeType === Node.ELEMENT_NODE
            ? record.target
            : record.target.parentElement;
        if (element?.closest?.('.field-help-layer')) {
          return false;
        }
        if (record.type === 'childList') {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          if (
            nodes.length &&
            nodes.every(
              (node) =>
                node.nodeType === Node.ELEMENT_NODE && node.classList.contains('field-help-layer'),
            )
          ) {
            return false;
          }
        }
        return true;
      });
      if (relevant) {
        schedule();
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'class', 'style'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      cancelAnimationFrame(frame);
      for (const [control, text] of described) {
        if (control.getAttribute('aria-description') === text) {
          control.removeAttribute('aria-description');
        }
      }
    };
  }, [section, tooltips]);
  useEffect(() => {
    const escape = (e) => {
      if (e.key === 'Escape') {
        setOpen('');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  useEffect(() => {
    const dismiss = (e) => {
      if (!e.target.closest?.('.field-help-trigger')) {
        setOpen('');
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);
  useEffect(() => {
    setOpen('');
  }, [section]);
  if (!portalTarget) {
    return null;
  }
  return createPortal(
    <div className="field-help-layer">
      {targets.map((t) => (
        <React.Fragment key={t.key}>
          <button
            type="button"
            className="field-help-trigger"
            style={{ left: t.left, top: t.top }}
            aria-label={`Help: ${t.name}`}
            aria-describedby={open === t.key ? 'forge-field-help' : undefined}
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') {
                setOpen(t.key);
              }
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') {
                setOpen((current) => (current === t.key ? '' : current));
              }
            }}
            onFocus={() => setOpen(t.key)}
            onBlur={() => setOpen((current) => (current === t.key ? '' : current))}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(t.key);
            }}
          >
            <CircleHelp size={16} />
          </button>
          {open === t.key && (
            <div
              className="field-help-popover"
              id="forge-field-help"
              role="tooltip"
              style={{
                left: Math.max(8, Math.min(t.left, window.innerWidth - 300)),
                top: t.top + 110 < window.innerHeight ? t.top + 23 : undefined,
                bottom:
                  t.top + 110 >= window.innerHeight ? window.innerHeight - t.top + 5 : undefined,
              }}
            >
              {t.text}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>,
    portalTarget,
  );
}
