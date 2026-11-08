import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ViewerShell from './ViewerShell';
import { createViewerEngine } from './viewer-engine';
import {
  DEFAULT_PREFS,
  ViewerError,
  assetFormat,
  describeViewerError,
  loadPrefs,
  savePrefs,
} from './viewer-core';

export function useViewerPrefs() {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);
  const setPref = useCallback(
    (key, value) => setPrefs((previous) => ({ ...previous, [key]: value })),
    [],
  );
  const resetPrefs = useCallback(
    () =>
      setPrefs((previous) => ({
        ...DEFAULT_PREFS,
        inspectorInline: previous.inspectorInline,
        inspectorWorkbench: previous.inspectorWorkbench,
      })),
    [],
  );
  return [prefs, setPref, resetPrefs];
}

const motionQuery = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');
const NO_PANORAMA = { detected: false, inside: false, source: null };

// Owns one engine for one asset: creates it, runs the source loader, mirrors its state
// into React for the shell, and tears everything down when the asset changes.
export default function ThreeViewer({
  url,
  name,
  source,
  engineOptions,
  onFallback,
  fallbackLabel,
  playing = true,
  onPlayingChange,
  timeRef,
  cameraRef,
  chrome,
  meta,
}) {
  const [host, setHost] = useState(null);
  const [prefs, setPref, resetPrefs] = useViewerPrefs();
  const [state, setState] = useState({
    status: 'loading',
    stage: 'Preparing viewer…',
    progress: null,
  });
  const [info, setInfo] = useState({ stats: null, caps: {}, kind: null, byteLength: null });
  const [playback, setPlayback] = useState(null);
  const [activeView, setActiveView] = useState(null);
  const [panorama, setPanorama] = useState(NO_PANORAMA);
  const panoramaHint = meta?.panorama === true;
  const [attempt, setAttempt] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(() => !!motionQuery()?.matches);
  const [motionOptIn, setMotionOptIn] = useState(false);
  const engineRef = useRef(null);
  const latest = useRef({});
  const effectivePrefs = useMemo(
    () => (reducedMotion && !motionOptIn ? { ...prefs, autoRotate: false } : prefs),
    [prefs, reducedMotion, motionOptIn],
  );
  latest.current = { prefs: effectivePrefs, playing, onPlayingChange, reducedMotion };

  const setViewerPref = useCallback(
    (key, value) => {
      if (key === 'autoRotate' && value) {
        setMotionOptIn(true);
      }
      setPref(key, value);
    },
    [setPref],
  );

  useEffect(() => {
    const query = motionQuery();
    if (!query?.addEventListener) {
      return undefined;
    }
    const changed = (event) => {
      setReducedMotion(event.matches);
      if (event.matches) {
        setMotionOptIn(false);
        engineRef.current?.setPlaying(false);
        latest.current.onPlayingChange?.(false);
      }
    };
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    if (!host) {
      return undefined;
    }
    setPlayback(null);
    setActiveView(null);
    setPanorama(NO_PANORAMA);
    setInfo({ stats: null, caps: {}, kind: null, byteLength: null });
    if (!url) {
      setState({
        status: 'error',
        error: describeViewerError(new ViewerError('EMPTY', 'No 3D file is selected.'), { name }),
      });
      return undefined;
    }
    setState({ status: 'loading', stage: 'Preparing viewer…', progress: null });
    const controller = new AbortController();
    let engine = null,
      ready = false;
    (async () => {
      try {
        const current = latest.current;
        engine = createViewerEngine({
          host,
          prefs: current.prefs,
          reducedMotion: current.reducedMotion,
          ...engineOptions,
          onPlayback: (snapshot) => {
            if (timeRef && snapshot) {
              timeRef.current = snapshot.time;
            }
            setPlayback(snapshot);
          },
          onView: setActiveView,
          onContextLost: () => {
            setState({
              status: 'error',
              error: describeViewerError(new ViewerError('NO_WEBGL', 'Graphics context lost.'), {
                name,
              }),
            });
          },
        });
        engineRef.current = engine;
        const result = await source(engine, {
          url,
          name,
          panoramaHint,
          signal: controller.signal,
          session: { time: timeRef?.current || 0 },
          onStage: (stage) => setState((previous) => ({ ...previous, stage })),
          onProgress: (progress) => setState((previous) => ({ ...previous, progress })),
        });
        if (controller.signal.aborted) {
          return;
        }
        if (cameraRef?.current) {
          engine.restoreCameraState(cameraRef.current);
        }
        if (engine.caps.animation) {
          const shouldPlay = current.playing && !current.reducedMotion;
          engine.selectClip(0, { time: timeRef?.current || 0, playing: shouldPlay });
          if (current.playing && !shouldPlay) {
            current.onPlayingChange?.(false);
          }
        }
        ready = true;
        setPanorama(engine.panoramaState());
        setInfo({
          stats: engine.stats,
          caps: engine.caps,
          kind: result?.kind || engine.kind,
          byteLength: result?.byteLength ?? null,
        });
        setState({ status: 'ready' });
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
          return;
        }
        console.error('3D viewer failed:', error);
        engine?.dispose();
        engine = null;
        engineRef.current = null;
        setState({ status: 'error', error: describeViewerError(error, { name }) });
      }
    })();
    return () => {
      controller.abort();
      if (engine) {
        if (ready) {
          if (cameraRef) {
            cameraRef.current = engine.getCameraState();
          }
          const snapshot = engine.playback();
          if (timeRef && snapshot) {
            timeRef.current = snapshot.time;
          }
        }
        engine.dispose();
      }
      engineRef.current = null;
    };
    // The loader inputs are the only reasons to rebuild the engine; preferences are
    // applied to the running engine below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, url, name, source, attempt, panoramaHint]);

  useEffect(() => {
    engineRef.current?.applyPrefs(effectivePrefs);
  }, [effectivePrefs, state.status]);

  const actions = useMemo(
    () => ({
      reset: () => engineRef.current?.reset(),
      frame: () => engineRef.current?.frame(),
      view: (id) => engineRef.current?.setView(id),
      orbit: (azimuth, polar) => engineRef.current?.orbitBy(azimuth, polar),
      pan: (dx, dy) => engineRef.current?.panBy(dx, dy),
      zoom: (direction) => engineRef.current?.zoomBy(direction > 0 ? 0.8 : 1.25),
      setPanoramaInside: (inside) => {
        engineRef.current?.setPanoramaInside(inside);
        setPanorama(engineRef.current?.panoramaState() || NO_PANORAMA);
      },
      snapshot: () =>
        engineRef.current
          ? engineRef.current.snapshot()
          : Promise.reject(new Error('The viewer is not ready.')),
      retry: () => setAttempt((count) => count + 1),
    }),
    [],
  );
  const playbackActions = useMemo(
    () => ({
      setPlaying: (value) => {
        engineRef.current?.setPlaying(value);
        latest.current.onPlayingChange?.(value);
      },
      seek: (time) => {
        const engine = engineRef.current;
        engine?.seek(time);
        setPlayback(engine?.playback() || null);
      },
      selectClip: (index) => engineRef.current?.selectClip(index),
      setSpeed: (speed) => setPref('playbackSpeed', speed),
    }),
    [setPref],
  );

  return (
    <ViewerShell
      name={name}
      url={url}
      prefs={effectivePrefs}
      setPref={setViewerPref}
      resetPrefs={resetPrefs}
      stageRef={setHost}
      state={state}
      caps={info.caps}
      stats={info.stats}
      format={assetFormat(name, info.kind)}
      fileSize={meta?.size ?? info.byteLength}
      playback={playback}
      playbackActions={playbackActions}
      activeView={activeView}
      panorama={panorama}
      actions={actions}
      chrome={chrome}
      fallback={
        onFallback ? { label: fallbackLabel || 'Show point preview', onClick: onFallback } : null
      }
    />
  );
}
