import { useRouteToggle } from './useNav';
import React, { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Maximize, Maximize2, Minimize2, X } from 'lucide-react';
import { topModal } from './modal-layer';
import './interactive-asset-viewer.css';
import './ux-viewer.css';

const ModelPreview = React.lazy(() => import('./ModelPreview'));
const MotionPreview = React.lazy(() => import('./MotionPreview'));
const PlyAssetPreview = React.lazy(() => import('./PlyAssetPreview'));

// Set when the user steps to another asset so the next viewer can take keyboard focus.
let focusStageNext = false;

// A stale or missing chunk (for example right after an update) must not blank the app.
class ViewerBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('3D viewer could not load:', error);
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <div className="viewer-message" role="alert">
        <strong>The 3D viewer could not be loaded</strong>
        <span>
          Part of the app failed to download, usually after an update. Reload the page to try again.
        </span>
        <button type="button" className="vw-action" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    );
  }
}

function Viewer({ url, name, playing, onPlayingChange, timeRef, cameraRef, chrome, meta }) {
  const Component = /\.bvh$/i.test(name)
    ? MotionPreview
    : /\.ply$/i.test(name)
      ? PlyAssetPreview
      : ModelPreview;
  return (
    <ViewerBoundary key={name}>
      <Suspense
        fallback={
          <div className="viewer-message" role="status">
            <span className="vw-spinner" aria-hidden="true" />
            <strong>Loading interactive preview…</strong>
          </div>
        }
      >
        <Component
          url={url}
          name={name}
          playing={playing}
          onPlayingChange={onPlayingChange}
          timeRef={timeRef}
          cameraRef={cameraRef}
          chrome={chrome}
          meta={meta}
        />
      </Suspense>
    </ViewerBoundary>
  );
}

// Previous / next 3D asset. It lives outside the lazy viewer so it keeps working while a
// file is loading or has failed to open.
function AssetNav({ navigation, onStep }) {
  if (!navigation) {
    return null;
  }
  const { index, total } = navigation;
  return (
    <div className="vw-nav" role="group" aria-label="3D asset navigation">
      <button
        type="button"
        className="vw-btn"
        aria-label="Previous 3D asset"
        aria-keyshortcuts="ArrowLeft"
        aria-disabled={index <= 0 || undefined}
        data-tip="Previous 3D asset (←)"
        onClick={() => onStep(-1)}
      >
        <ChevronLeft size={18} aria-hidden="true" />
      </button>
      <span className="vw-nav-count" role="status" aria-live="polite">
        {index + 1} / {total}
      </span>
      <button
        type="button"
        className="vw-btn"
        aria-label="Next 3D asset"
        aria-keyshortcuts="ArrowRight"
        aria-disabled={index >= total - 1 || undefined}
        data-tip="Next 3D asset (→)"
        onClick={() => onStep(1)}
      >
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

function InspectionDialog({
  url,
  name,
  onClose,
  trigger,
  playing,
  onPlayingChange,
  timeRef,
  cameraRef,
  meta,
  navigation,
  onStep,
}) {
  const dialog = useRef(null),
    backdrop = useRef(null),
    close = useRef(null),
    onCloseRef = useRef(onClose),
    titleId = useId(),
    hintId = useId();
  const [fullscreen, setFullscreen] = useState(false);
  const [focusOnReady] = useState(() => focusStageNext);
  onCloseRef.current = onClose;
  const canFullscreen = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await backdrop.current?.requestFullscreen();
      }
    } catch {
      // Some hosts refuse fullscreen; the large workbench still works.
    }
  }
  const chrome = useMemo(
    () => ({
      mode: 'workbench',
      nav: navigation,
      onToggleMaximize: canFullscreen ? toggleFullscreen : () => onCloseRef.current(),
      focusOnReady,
    }),
    [navigation, canFullscreen, focusOnReady],
  );
  useEffect(() => {
    focusStageNext = false;
  }, []);
  useEffect(() => {
    const triggerElement = trigger.current;
    const previousOverflow = document.body.style.overflow;
    const backdropElement = backdrop.current;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    // The gallery modal underneath focuses its own Close button in a later effect of the
    // same commit; pull focus back so it never rests behind this dialog.
    const refocus = setTimeout(() => {
      if (dialog.current && !dialog.current.contains(document.activeElement)) {
        close.current?.focus();
      }
    }, 0);
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === backdropElement);
    document.addEventListener('fullscreenchange', syncFullscreen);
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
      if (event.key !== 'Tab') {
        return;
      }
      const controls = [
        ...dialog.current.querySelectorAll(
          'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])',
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
      clearTimeout(refocus);
      document.removeEventListener('keydown', handle, true);
      document.removeEventListener('fullscreenchange', syncFullscreen);
      if (document.fullscreenElement === backdropElement) {
        document.exitFullscreen?.().catch(() => {});
      }
      document.body.style.overflow = previousOverflow;
      triggerElement?.focus();
    };
  }, [trigger]);
  // Runs after the viewer's own handler. The library's left/right shortcuts must never
  // change the asset behind this dialog; with 3D siblings they step through them instead.
  function onKeyDown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.stopPropagation();
    if (
      navigation &&
      !event.defaultPrevented &&
      !(event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) &&
      !/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)
    ) {
      event.preventDefault();
      onStep(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }
  return createPortal(
    <div
      ref={backdrop}
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
        onKeyDown={onKeyDown}
      >
        <header className="inspection-header">
          <div>
            <span className="inspection-label">3D viewer</span>
            <h2 id={titleId} title={name}>
              {name}
            </h2>
          </div>
          <div className="inspection-actions">
            <AssetNav navigation={navigation} onStep={onStep} />
            {canFullscreen && (
              <button
                type="button"
                className="inspection-fullscreen"
                aria-pressed={fullscreen}
                aria-label="Toggle browser full screen"
                data-tip="Toggle browser full screen (M)"
                onClick={toggleFullscreen}
              >
                {fullscreen ? (
                  <Minimize2 size={18} aria-hidden="true" />
                ) : (
                  <Maximize size={18} aria-hidden="true" />
                )}
                <span>{fullscreen ? 'Exit full screen' : 'Full screen'}</span>
              </button>
            )}
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
          </div>
        </header>
        <div className="inspection-stage">
          <Viewer
            url={url}
            name={name}
            playing={playing}
            onPlayingChange={onPlayingChange}
            timeRef={timeRef}
            cameraRef={cameraRef}
            chrome={chrome}
            meta={meta}
          />
        </div>
        <p id={hintId} className="inspection-footer">
          Drag to orbit · right-drag to pan · scroll to zoom · press ? for keyboard shortcuts
          {navigation ? ' · ← → switch 3D asset' : ''}
          {/\.bvh$/i.test(name) ? ' · Space plays or pauses motion' : ''}
        </p>
      </section>
    </div>,
    document.body,
  );
}

// `navigation` is optional: { index, total, onStep(offset) } across the 3D assets of the
// current list. `size` is the file size in bytes when the caller already knows it.
export default function InteractiveAssetViewer({ url, name, navigation = null, size }) {
  const [expanded, setExpanded] = useRouteToggle('inspect');
  const [playing, setPlaying] = useState(true);
  const [focusOnReady] = useState(() => focusStageNext);
  const trigger = useRef(null),
    timeRef = useRef(0),
    cameraRef = useRef(null),
    navigationRef = useRef(null);
  const index = navigation?.total > 1 ? navigation.index : null,
    total = navigation?.total > 1 ? navigation.total : null;
  navigationRef.current = navigation;
  const meta = useMemo(() => ({ size }), [size]);
  const step = useCallback((offset) => {
    const current = navigationRef.current;
    const target = current ? current.index + offset : -1;
    if (current && target >= 0 && target < current.total) {
      focusStageNext = true;
      current.onStep(offset);
    }
  }, []);
  const nav = useMemo(
    () => (total === null ? null : { index, total, onStep: step }),
    [index, total, step],
  );
  const inlineChrome = useMemo(
    () => ({
      mode: 'inline',
      nav,
      onToggleMaximize: () => setExpanded(true),
      focusOnReady,
    }),
    [nav, setExpanded, focusOnReady],
  );
  useEffect(() => {
    focusStageNext = false;
  }, []);
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
          cameraRef={cameraRef}
          chrome={inlineChrome}
          meta={meta}
        />
      )}
      <div className="vw-chrome">
        <AssetNav navigation={nav} onStep={step} />
        <button
          ref={trigger}
          type="button"
          className="inspection-expand"
          aria-label={`Full screen preview of ${name}`}
          aria-keyshortcuts="M"
          data-tip="Open large viewer (M)"
          onClick={() => setExpanded(true)}
        >
          <Maximize2 size={17} aria-hidden="true" />
          <span>Full screen</span>
        </button>
      </div>
      {expanded && (
        <InspectionDialog
          url={url}
          name={name}
          onClose={() => setExpanded(false)}
          trigger={trigger}
          playing={playing}
          onPlayingChange={setPlaying}
          timeRef={timeRef}
          cameraRef={cameraRef}
          meta={meta}
          navigation={nav}
          onStep={step}
        />
      )}
    </div>
  );
}
