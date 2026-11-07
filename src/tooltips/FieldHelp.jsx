import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp } from 'lucide-react';
import { topModal } from '../modal-layer';
import './field-help.css';

const HELP_TRIGGER_SIZE = 24;
const HELP_TRIGGER_GAP = 6;

function overlaps(first, second) {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

/** Place a help trigger in nearby free space without covering text or artwork. */
export function placeHelpTrigger(anchor, viewport, occupied, size = HELP_TRIGGER_SIZE) {
  const margin = 3;
  const originLeft = viewport.left || 0;
  const originTop = viewport.top || 0;
  const clampLeft = (left) =>
    Math.max(originLeft + margin, Math.min(originLeft + viewport.width - size - margin, left));
  const clampTop = (top) =>
    Math.max(originTop + margin, Math.min(originTop + viewport.height - size - margin, top));
  const centerY = anchor.top + anchor.height / 2 - size / 2;
  const centerX = anchor.left + anchor.width / 2 - size / 2;
  const preferred = [
    [anchor.right + HELP_TRIGGER_GAP, centerY],
    [anchor.left - size - HELP_TRIGGER_GAP, centerY],
    [centerX, anchor.top - size - HELP_TRIGGER_GAP],
    [centerX, anchor.bottom + HELP_TRIGGER_GAP],
    [anchor.right + HELP_TRIGGER_GAP, anchor.top],
    [anchor.left - size - HELP_TRIGGER_GAP, anchor.bottom - size],
  ];
  const candidates = preferred.map(([left, top]) => ({
    left: clampLeft(left),
    top: clampTop(top),
  }));
  for (let distance = 20; distance <= 144; distance += 16) {
    for (const [horizontal, vertical] of [
      [1, 0],
      [-1, 0],
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 1],
      [-1, -1],
      [-1, 1],
    ]) {
      candidates.push({
        left: clampLeft(centerX + horizontal * distance),
        top: clampTop(centerY + vertical * distance),
      });
    }
  }

  // When a label sits in a dense row, search the viewport edge gutters for a
  // clear slot instead of clamping the icon back over the label or a preview.
  const step = 32;
  for (
    let left = originLeft + margin;
    left <= originLeft + viewport.width - size - margin;
    left += step
  ) {
    candidates.push({ left, top: originTop + margin });
    candidates.push({
      left,
      top: clampTop(originTop + viewport.height - size - margin),
    });
  }
  for (
    let top = originTop + margin + step;
    top < originTop + viewport.height - size - margin;
    top += step
  ) {
    candidates.push({ left: originLeft + margin, top });
    candidates.push({
      left: clampLeft(originLeft + viewport.width - size - margin),
      top,
    });
  }

  const safe = candidates.find((candidate) => {
    const rect = {
      ...candidate,
      right: candidate.left + size,
      bottom: candidate.top + size,
    };
    return !occupied.some((obstacle) => overlaps(rect, obstacle));
  });
  if (safe) {
    return safe;
  }
  const withoutArtwork = candidates.find((candidate) => {
    const rect = {
      ...candidate,
      right: candidate.left + size,
      bottom: candidate.top + size,
    };
    return !occupied.some((obstacle) => obstacle.isArtwork && overlaps(rect, obstacle));
  });
  return withoutArtwork || candidates[0] || { left: originLeft + margin, top: originTop + margin };
}

function occupiedRects(scope, cachedNodes) {
  const rects = [];
  const addRect = (element, isArtwork = false) => {
    if (!isVisible(element)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      rects.push(isArtwork ? { ...rect, isArtwork: true } : rect);
    }
  };
  if (cachedNodes) {
    for (const range of cachedNodes.text) {
      if (!range.startContainer.isConnected || !range.startContainer.nodeValue.trim()) {
        continue;
      }
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          rects.push(rect);
        }
      }
    }
    cachedNodes.artwork.forEach((element) => addRect(element, true));
    cachedNodes.controls.forEach(addRect);
    return rects;
  }
  const text = [];
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue.trim() &&
        !node.parentElement?.closest(
          'input,select,textarea,button,svg,script,style,.field-help-layer',
        )
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    text.push(range);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) {
        rects.push(rect);
      }
    }
  }
  const artwork = [...scope.querySelectorAll('img,canvas,video,[role="img"]')];
  const controls = [
    ...scope.querySelectorAll('input,select,textarea,button,[role="switch"],[role="slider"]'),
  ];
  artwork.forEach((element) => addRect(element, true));
  controls.forEach(addRect);
  return { rects, nodes: { text, artwork, controls } };
}

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
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const [portalTarget, setPortalTarget] = useState(() =>
    typeof document === 'undefined' ? null : document.body,
  );
  useEffect(() => {
    let frame = 0;
    let needsDiscovery = true;
    let cachedNodes = null;
    const root = document.querySelector('.app-shell');
    if (!root) {
      return;
    }
    const described = new Map();
    const refresh = () => {
      frame = 0;
      const discover = needsDiscovery;
      needsDiscovery = false;
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
        occupancy = occupiedRects(scope, discover ? null : cachedNodes),
        occupied = discover ? occupancy.rects : occupancy,
        ratingGroups = new Set(),
        layoutGroups = new Set();
      if (discover) {
        cachedNodes = occupancy.nodes;
      }
      if (!discover) {
        const updated = targetsRef.current.map((target) => {
          if (!target.anchorElement?.isConnected) {
            return target;
          }
          const anchor = target.anchorElement.getBoundingClientRect();
          const scopeRect = scope.getBoundingClientRect();
          let position = placeHelpTrigger(
            anchor,
            {
              left: Math.max(0, scopeRect.left),
              top: Math.max(0, scopeRect.top),
              width: Math.max(
                0,
                Math.min(window.innerWidth, scopeRect.right) - Math.max(0, scopeRect.left),
              ),
              height: Math.max(
                0,
                Math.min(window.innerHeight, scopeRect.bottom) - Math.max(0, scopeRect.top),
              ),
            },
            occupied,
          );
          const triggerRect = {
            left: position.left,
            top: position.top,
            right: position.left + HELP_TRIGGER_SIZE,
            bottom: position.top + HELP_TRIGGER_SIZE,
          };
          if (occupied.some((obstacle) => obstacle.isArtwork && overlaps(triggerRect, obstacle))) {
            position = placeHelpTrigger(
              anchor,
              { width: window.innerWidth, height: window.innerHeight },
              occupied,
            );
          }
          const rect = {
            left: position.left,
            top: position.top,
            right: position.left + HELP_TRIGGER_SIZE,
            bottom: position.top + HELP_TRIGGER_SIZE,
          };
          occupied.push(rect);
          return { ...target, ...position };
        });
        setTargets((current) =>
          current.every(
            (target, index) =>
              target.left === updated[index]?.left && target.top === updated[index]?.top,
          )
            ? current
            : updated,
        );
        return;
      }
      let number = 0;
      const addTarget = (name, text, anchor, anchorElement) => {
        const scopeRect = scope.getBoundingClientRect();
        const bounds = {
          left: Math.max(0, scopeRect.left),
          top: Math.max(0, scopeRect.top),
          width: Math.max(
            0,
            Math.min(window.innerWidth, scopeRect.right) - Math.max(0, scopeRect.left),
          ),
          height: Math.max(
            0,
            Math.min(window.innerHeight, scopeRect.bottom) - Math.max(0, scopeRect.top),
          ),
        };
        let position = placeHelpTrigger(anchor, bounds, occupied);
        const overlapsArtwork = (candidate) => {
          const rect = {
            left: candidate.left,
            top: candidate.top,
            right: candidate.left + HELP_TRIGGER_SIZE,
            bottom: candidate.top + HELP_TRIGGER_SIZE,
          };
          return occupied.some((obstacle) => obstacle.isArtwork && overlaps(rect, obstacle));
        };
        if (overlapsArtwork(position)) {
          // Full-bleed previews can leave no clear slot inside a dialog. Keep
          // the trigger in the dialog's DOM for its focus trap, but allow its
          // fixed visual position to use the dimmed viewport gutter.
          position = placeHelpTrigger(
            anchor,
            { width: window.innerWidth, height: window.innerHeight },
            occupied,
          );
        }
        const rect = {
          left: position.left,
          top: position.top,
          right: position.left + HELP_TRIGGER_SIZE,
          bottom: position.top + HELP_TRIGGER_SIZE,
        };
        occupied.push(rect);
        found.push({
          key: `${section}-${number++}-${name}`,
          name,
          text,
          anchorElement,
          ...position,
        });
      };
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
              addTarget('Asset rating', groupText, rect, anchor);
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
              addTarget('Display layout', groupText, rect, anchor);
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
        addTarget(
          name,
          text,
          chatMessage ? controlRect : rect,
          chatMessage ? control : label || namedAnchor || control,
        );
      }
      setTargets((current) => {
        if (
          current.length === found.length &&
          current.every(
            (target, index) =>
              target.key === found[index].key &&
              target.left === found[index].left &&
              target.top === found[index].top &&
              target.name === found[index].name &&
              target.text === found[index].text &&
              target.anchorElement === found[index].anchorElement,
          )
        ) {
          return current;
        }
        return found;
      });
    };
    const schedule = (discover = false) => {
      needsDiscovery ||= discover;
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
        schedule(true);
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'inert', 'class', 'style'],
    });
    const onScroll = () => schedule(false);
    const onResize = () => schedule(true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onScroll);
    schedule(true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onScroll);
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
                left: Math.max(8, Math.min(t.left, window.innerWidth - 320)),
                top: Math.max(8, Math.min(t.top + 23, window.innerHeight - 8)),
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
