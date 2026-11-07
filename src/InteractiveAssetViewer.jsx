import { useRouteToggle } from './useNav';
import React, { Suspense, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import { topModal } from './modal-layer';
import './interactive-asset-viewer.css';

const ModelPreview = React.lazy(() => import('./ModelPreview'));
const MotionPreview = React.lazy(() => import('./MotionPreview'));
const PlyAssetPreview = React.lazy(() => import('./PlyAssetPreview'));

function Viewer({ url, name, playing, onPlayingChange, timeRef }) {
  const Component = /\.bvh$/i.test(name)
    ? MotionPreview
    : /\.ply$/i.test(name)
      ? PlyAssetPreview
      : ModelPreview;
  return (
    <Suspense
      fallback={
        <div className="model-preview-message" role="status">
          Loading interactive preview…
        </div>
      }
    >
      <Component
        url={url}
        name={name}
        playing={playing}
        onPlayingChange={onPlayingChange}
        timeRef={timeRef}
      />
    </Suspense>
  );
}

function InspectionDialog({ url, name, onClose, trigger, playing, onPlayingChange, timeRef }) {
  const dialog = useRef(null),
    close = useRef(null),
    onCloseRef = useRef(onClose),
    titleId = useId(),
    hintId = useId();
  onCloseRef.current = onClose;
  useEffect(() => {
    const triggerElement = trigger.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const handle = (event) => {
      if (topModal() !== dialog.current) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      // The library's left/right shortcuts should not change the asset behind this dialog.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.stopPropagation();
      }
      if (event.key !== 'Tab') {
        return;
      }
      const controls = [
        ...dialog.current.querySelectorAll(
          'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ].filter(
        (element) =>
          !element.matches(':disabled,[hidden],[inert]') &&
          element.getClientRects().length > 0 &&
          !element.closest('[hidden],[inert],[aria-hidden="true"]'),
      );
      if (!controls.length) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === controls[0] || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        controls.at(-1).focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === controls.at(-1) ||
          !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        controls[0].focus();
      }
    };
    document.addEventListener('keydown', handle, true);
    return () => {
      document.removeEventListener('keydown', handle, true);
      document.body.style.overflow = previousOverflow;
      triggerElement?.focus();
    };
  }, [trigger]);
  return createPortal(
    <div
      className="inspection-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <section
        ref={dialog}
        className="inspection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="inspection-header">
          <div>
            <span className="inspection-label">Interactive preview</span>
            <h2 id={titleId} title={name}>
              {name}
            </h2>
          </div>
          <button
            ref={close}
            type="button"
            className="inspection-close"
            onClick={onClose}
            aria-label="Close full screen preview"
          >
            <X size={20} />
            <span>Close</span>
          </button>
        </header>
        <div className="inspection-stage">
          <Viewer
            url={url}
            name={name}
            playing={playing}
            onPlayingChange={onPlayingChange}
            timeRef={timeRef}
          />
        </div>
        <p id={hintId} className="inspection-footer">
          Drag to rotate · scroll or pinch to zoom
          {/\.bvh$/i.test(name) ? ' · use the controls to pause motion' : ''}
        </p>
      </section>
    </div>,
    document.body,
  );
}

export default function InteractiveAssetViewer({ url, name }) {
  const [expanded, setExpanded] = useRouteToggle('inspect');
  const [playing, setPlaying] = useState(true);
  const trigger = useRef(null),
    timeRef = useRef(0);
  return (
    <div className="interactive-asset-viewer">
      {expanded ? (
        <div className="inspection-inline-placeholder" aria-hidden="true" />
      ) : (
        <Viewer
          url={url}
          name={name}
          playing={playing}
          onPlayingChange={setPlaying}
          timeRef={timeRef}
        />
      )}
      <button
        ref={trigger}
        type="button"
        className="inspection-expand"
        aria-label={`Full screen preview of ${name}`}
        title="Open full screen preview"
        onClick={() => setExpanded(true)}
      >
        <Maximize2 size={17} />
        <span>Full screen</span>
      </button>
      {expanded && (
        <InspectionDialog
          url={url}
          name={name}
          onClose={() => setExpanded(false)}
          trigger={trigger}
          playing={playing}
          onPlayingChange={setPlaying}
          timeRef={timeRef}
        />
      )}
    </div>
  );
}
