import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Axis3d,
  BoxSelect,
  Camera,
  Download,
  Eye,
  Focus,
  Grid3x3,
  Keyboard,
  Layers,
  Orbit,
  Palette,
  Pause,
  PanelRight,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Triangle,
} from 'lucide-react';
import {
  BACKGROUND_PRESETS,
  LIGHTING_PRESETS,
  PLAYBACK_SPEEDS,
  QUALITY_PRESETS,
  SHORTCUTS,
  VIEW_PRESETS,
  cycle,
  formatBytes,
  formatCount,
  formatDimensions,
  formatTime,
  resolveShortcut,
  snapshotFilename,
} from './viewer-core';
import { topModal } from './modal-layer';
import './ux-viewer.css';

const TOGGLES = {
  autoRotate: { label: 'Auto-rotate', keys: 'O', icon: Orbit },
  wireframe: { label: 'Wireframe', keys: 'W', icon: Triangle, cap: 'wireframe' },
  grid: { label: 'Grid', keys: 'G', icon: Grid3x3 },
  axes: { label: 'Axes', keys: 'X', icon: Axis3d },
  bounds: { label: 'Bounding box', keys: 'B', icon: BoxSelect },
  ground: { label: 'Ground shadow', keys: 'S', icon: Layers, cap: 'ground' },
};
const UNAVAILABLE = {
  wireframe: 'only available for meshes',
  ground: 'needs a mesh with a reasonable triangle count',
  lighting: 'only affects lit meshes',
};

function Tool({
  icon: Icon,
  label,
  keys,
  pressed,
  disabled,
  reason,
  onClick,
  text,
  className = '',
}) {
  const tip = disabled && reason ? `${label} — ${reason}` : keys ? `${label} (${keys})` : label;
  return (
    <button
      type="button"
      className={`vw-btn ${text ? 'vw-btn-text' : ''} ${className}`.trim()}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={keys}
      data-tip={tip}
      onClick={onClick}
    >
      <Icon size={17} aria-hidden="true" />
      {text && <span>{text}</span>}
    </button>
  );
}

function RowToggle({ icon: Icon, label, keys, pressed, disabled, reason, onClick }) {
  return (
    <button
      type="button"
      className="vw-row"
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={keys}
      title={disabled && reason ? `${label} — ${reason}` : undefined}
      onClick={onClick}
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
      <kbd>{keys}</kbd>
    </button>
  );
}

function Stat({ label, value }) {
  return value === null || value === undefined ? null : (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function describeTarget(element) {
  const tag = element?.tagName;
  const type = element?.getAttribute?.('type');
  const editable =
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element?.isContentEditable ||
    (tag === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(type));
  return {
    editable: !!editable,
    native: tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'INPUT',
    button: tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY',
  };
}

export function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export default function ViewerShell({
  name,
  url,
  prefs,
  setPref,
  resetPrefs,
  stageRef,
  state,
  caps = {},
  stats,
  format,
  fileSize,
  playback,
  playbackActions,
  activeView,
  actions,
  chrome = {},
  fallback,
  children,
}) {
  const mode = chrome.mode || 'inline';
  const inspectorKey = mode === 'workbench' ? 'inspectorWorkbench' : 'inspectorInline';
  const inspectorOpen = prefs[inspectorKey];
  const ready = state.status === 'ready';
  const rootRef = useRef(null),
    stageElement = useRef(null),
    shortcutsElement = useRef(null),
    toastTimer = useRef(0);
  const [compact, setCompact] = useState(false);
  const [tight, setTight] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [toast, setToast] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const hintId = useId(),
    inspectorId = useId();

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver !== 'function') {
      return undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setCompact(width > 0 && (width < 620 || height < 360));
      setTight(width < 1000);
      setNarrow(width > 0 && width < 380);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  // After stepping to another asset, keep keyboard control on the viewport.
  const focusOnReady = chrome.focusOnReady;
  useEffect(() => {
    if (ready && focusOnReady) {
      stageElement.current?.focus({ preventScroll: true });
    }
  }, [ready, focusOnReady]);

  useEffect(() => {
    if (helpOpen) {
      shortcutsElement.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [helpOpen]);

  const say = useCallback((message) => {
    clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  const blocked = (key) =>
    say(`${TOGGLES[key]?.label || key} is ${UNAVAILABLE[key] || 'unavailable'}.`);
  const available = (key) => {
    const cap = TOGGLES[key]?.cap || (key === 'lighting' ? 'lighting' : null);
    return !cap || caps[cap] !== false;
  };
  const toggle = (key) => {
    if (!available(key)) {
      blocked(key);
      return;
    }
    const next = !prefs[key];
    setPref(key, next);
    say(`${TOGGLES[key].label} ${next ? 'on' : 'off'}`);
  };
  const cycleSetting = (key) => {
    if (key === 'lighting' && !available('lighting')) {
      blocked('lighting');
      return;
    }
    const presets = key === 'lighting' ? LIGHTING_PRESETS : BACKGROUND_PRESETS;
    const next = cycle(
      presets.map((preset) => preset.id),
      prefs[key],
    );
    setPref(key, next);
    say(
      `${key === 'lighting' ? 'Lighting' : 'Background'}: ${presets.find((p) => p.id === next).label}`,
    );
  };
  const snapshot = async () => {
    try {
      const blob = await actions.snapshot();
      downloadBlob(blob, snapshotFilename(name, activeView || 'view'));
      say('PNG snapshot downloaded');
    } catch {
      say('Could not create the snapshot.');
    }
  };
  const showView = (id) => {
    actions.view(id);
    say(`${VIEW_PRESETS.find((preset) => preset.id === id)?.label} view`);
  };
  const setInspector = (open) => setPref(inspectorKey, open);

  const run = (command) => {
    switch (command.type) {
      case 'step':
        if (!chrome.nav) {
          return false;
        }
        chrome.nav.onStep(command.offset);
        return true;
      case 'help':
        setHelpOpen(true);
        setInspector(true);
        return true;
      case 'inspector':
        setInspector(!inspectorOpen);
        return true;
      case 'maximize':
        if (!chrome.onToggleMaximize) {
          return false;
        }
        chrome.onToggleMaximize();
        return true;
      case 'toggle':
        toggle(command.pref);
        return true;
      case 'cycle':
        cycleSetting(command.pref);
        return true;
      case 'playPause':
        if (!playback) {
          say('This asset has no animation.');
          return true;
        }
        playbackActions.setPlaying(!playback.playing);
        return true;
      default:
        break;
    }
    if (!ready) {
      return false;
    }
    switch (command.type) {
      case 'reset':
        actions.reset();
        say('View reset');
        return true;
      case 'frame':
        actions.frame();
        say('Model framed');
        return true;
      case 'view':
        showView(command.view);
        return true;
      case 'orbit':
        actions.orbit(command.azimuth, command.polar);
        return true;
      case 'pan':
        actions.pan(command.dx, command.dy);
        return true;
      case 'zoom':
        actions.zoom(command.direction);
        return true;
      case 'snapshot':
        snapshot();
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (event) => {
    if (event.defaultPrevented) {
      return;
    }
    const command = resolveShortcut(event, describeTarget(event.target));
    if (command && run(command)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const keyHandler = useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  // In the large viewer every key while its dialog is the top modal keeps controlling the
  // model, even when focus sits elsewhere in the dialog (for example on the Close button).
  useEffect(() => {
    const dialog = mode === 'workbench' ? rootRef.current?.closest('[role="dialog"]') : null;
    if (!dialog) {
      return undefined;
    }
    const forward = (event) => {
      if (!rootRef.current?.contains(event.target) && topModal() === dialog) {
        keyHandler.current(event);
      }
    };
    document.addEventListener('keydown', forward);
    return () => document.removeEventListener('keydown', forward);
  }, [mode]);

  const toggleButton = (key, extra = {}) => {
    const spec = TOGGLES[key];
    const disabled = !available(key);
    return (
      <Tool
        key={key}
        icon={spec.icon}
        label={spec.label}
        keys={spec.keys}
        pressed={!!prefs[key] && !disabled}
        disabled={disabled}
        reason={UNAVAILABLE[key]}
        onClick={() => toggle(key)}
        {...extra}
      />
    );
  };
  const lightingDisabled = caps.lighting === false;
  const selects = (
    <>
      <label className="vw-select" data-tip="Lighting preset (L)">
        <Sun size={16} aria-hidden="true" />
        <select
          aria-label="Lighting preset"
          aria-keyshortcuts="L"
          value={prefs.lighting}
          disabled={lightingDisabled}
          onChange={(event) => setPref('lighting', event.target.value)}
        >
          {LIGHTING_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      <label className="vw-select" data-tip="Background (C)">
        <Palette size={16} aria-hidden="true" />
        <select
          aria-label="Background"
          aria-keyshortcuts="C"
          value={prefs.background}
          onChange={(event) => setPref('background', event.target.value)}
        >
          {BACKGROUND_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
  const viewSelect = (
    <label className="vw-select" data-tip="Camera view (1–6)">
      <Eye size={16} aria-hidden="true" />
      <select
        aria-label="Camera view"
        value={activeView || ''}
        disabled={!ready}
        onChange={(event) => event.target.value && showView(event.target.value)}
      >
        <option value="" disabled>
          View
        </option>
        {VIEW_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label} ({preset.key})
          </option>
        ))}
      </select>
    </label>
  );
  const qualitySelect = (
    <label className="vw-field">
      <span>Render quality</span>
      <select
        aria-label="Render quality"
        value={prefs.quality}
        onChange={(event) => setPref('quality', event.target.value)}
      >
        {QUALITY_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
    </label>
  );

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const shortcut of SHORTCUTS) {
      groups.set(shortcut.group, [...(groups.get(shortcut.group) || []), shortcut]);
    }
    return [...groups];
  }, []);
  const counts = stats
    ? [
        ['Vertices', stats.vertices],
        ['Triangles', stats.triangles],
        ['Points', stats.points],
        ['Splats', stats.splats],
        ['Bones', stats.bones],
        ['Meshes', stats.meshes],
        ['Materials', stats.materials],
        ['Textures', stats.textures],
      ].filter(([, value]) => typeof value === 'number' && value > 0)
    : [];
  const summary = ready
    ? [
        format?.label,
        format?.kindLabel,
        stats?.triangles ? `${formatCount(stats.triangles)} triangles` : null,
        stats?.points ? `${formatCount(stats.points)} points` : null,
        stats?.splats ? `${formatCount(stats.splats)} splats` : null,
        stats?.bones ? `${formatCount(stats.bones)} bones` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const sizeLabel = formatBytes(fileSize);

  return (
    <div
      ref={rootRef}
      className="vw"
      data-mode={mode}
      data-compact={compact || undefined}
      data-background={prefs.background}
      data-inspector={inspectorOpen ? 'open' : 'closed'}
      onKeyDown={onKeyDown}
    >
      <div className="vw-toolbar" role="group" aria-label="3D viewer tools">
        <div className="vw-group" role="group" aria-label="Camera">
          <Tool
            icon={RotateCcw}
            label="Reset view"
            keys="R"
            text={compact || tight ? undefined : 'Reset'}
            disabled={!ready}
            onClick={() => run({ type: 'reset' })}
          />
          {!narrow && (
            <Tool
              icon={Focus}
              label="Frame model"
              keys="F"
              text={compact || tight ? undefined : 'Frame'}
              disabled={!ready}
              onClick={() => run({ type: 'frame' })}
            />
          )}
          {!compact && viewSelect}
        </div>
        <div className="vw-group" role="group" aria-label="Display" hidden={narrow}>
          {!narrow && toggleButton('autoRotate')}
          {!compact && (
            <>
              {toggleButton('wireframe')}
              {toggleButton('grid')}
              {toggleButton('axes')}
              {toggleButton('bounds')}
              {toggleButton('ground')}
            </>
          )}
        </div>
        {!compact && (
          <div className="vw-group" role="group" aria-label="Scene">
            {selects}
          </div>
        )}
        <div className="vw-group vw-group-end" role="group" aria-label="Capture and panels">
          <Tool
            icon={Camera}
            label="Download PNG snapshot"
            keys="P"
            disabled={!ready}
            onClick={() => run({ type: 'snapshot' })}
          />
          <Tool
            icon={PanelRight}
            label="Inspector"
            keys="I"
            pressed={inspectorOpen}
            onClick={() => setInspector(!inspectorOpen)}
            className="vw-inspector-toggle"
          />
        </div>
      </div>

      <div className="vw-body">
        <div
          ref={stageElement}
          className="vw-stage"
          tabIndex={0}
          role="group"
          aria-roledescription="3D viewport"
          aria-label={`3D preview of ${name}`}
          aria-describedby={hintId}
        >
          <div ref={stageRef} className="vw-canvas" />
          <p id={hintId} className="sr-only">
            Drag to orbit, right-drag or Control plus arrow keys to pan, scroll or plus and minus to
            zoom, Shift plus arrow keys to orbit. Press question mark for every shortcut.
          </p>
          {ready && summary && (
            <div className="vw-chip" aria-hidden="true">
              {summary}
            </div>
          )}
          {ready && (
            <div className="vw-hint" aria-hidden="true">
              <span>Drag to orbit</span>
              <span>Right-drag to pan</span>
              <span>Scroll to zoom</span>
              <span>
                <kbd>?</kbd> shortcuts
              </span>
            </div>
          )}
          {state.status === 'loading' && (
            <div className="vw-overlay vw-loading" role="status">
              <span className="vw-spinner" aria-hidden="true" />
              <strong>{state.stage || 'Loading 3D preview…'}</strong>
              {typeof state.progress === 'number' && (
                <span
                  className="vw-progress"
                  role="progressbar"
                  aria-label="Loading progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(state.progress * 100)}
                >
                  <i style={{ width: `${Math.round(state.progress * 100)}%` }} />
                </span>
              )}
              <small>{sizeLabel !== '—' ? `${name} · ${sizeLabel}` : name}</small>
            </div>
          )}
          {state.status === 'error' && (
            <div className="vw-overlay vw-error" role="alert">
              <AlertTriangle size={28} aria-hidden="true" />
              <strong>{state.error.title}</strong>
              <p>{state.error.message}</p>
              {state.error.hint && <small>{state.error.hint}</small>}
              <div className="vw-error-actions">
                {state.error.retryable && (
                  <button type="button" className="vw-action" onClick={actions.retry}>
                    <RefreshCw size={15} aria-hidden="true" /> Try again
                  </button>
                )}
                {fallback && (
                  <button type="button" className="vw-action" onClick={fallback.onClick}>
                    {fallback.label}
                  </button>
                )}
                {url && (
                  <a className="vw-action" href={url} download={name}>
                    <Download size={15} aria-hidden="true" /> Download file
                  </a>
                )}
              </div>
            </div>
          )}
          {toast && (
            <div className="vw-toast" aria-hidden="true">
              {toast}
            </div>
          )}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {toast}
          </div>
          {playback && ready && (
            <div className="vw-playback" role="group" aria-label="Animation playback">
              <Tool
                icon={playback.playing ? Pause : Play}
                label={playback.playing ? 'Pause animation' : 'Play animation'}
                keys="Space"
                onClick={() => playbackActions.setPlaying(!playback.playing)}
              />
              <output className="vw-time" aria-live="off">
                {formatTime(playback.time)} / {formatTime(playback.duration)}
              </output>
              <input
                type="range"
                className="vw-scrub"
                aria-label="Animation position"
                aria-valuetext={`${formatTime(playback.time)} of ${formatTime(playback.duration)}`}
                min={0}
                max={playback.duration || 1}
                step={Math.max((playback.duration || 1) / 200, 0.001)}
                value={Math.min(playback.time, playback.duration || 1)}
                onChange={(event) => playbackActions.seek(Number(event.target.value))}
              />
              {playback.clips.length > 1 && (
                <label className="vw-select vw-clip">
                  <span className="sr-only">Animation clip</span>
                  <select
                    aria-label="Animation clip"
                    value={playback.index}
                    onChange={(event) => playbackActions.selectClip(Number(event.target.value))}
                  >
                    {playback.clips.map((clip, index) => (
                      <option key={index} value={index}>
                        {clip.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="vw-select vw-speed" data-tip="Playback speed">
                <span className="sr-only">Playback speed</span>
                <select
                  aria-label="Playback speed"
                  value={playback.speed}
                  onChange={(event) => playbackActions.setSpeed(Number(event.target.value))}
                >
                  {PLAYBACK_SPEEDS.map((speed) => (
                    <option key={speed} value={speed}>
                      {speed}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {children}
        </div>

        {inspectorOpen && (
          <aside id={inspectorId} className="vw-inspector" aria-label="Inspector">
            <section>
              <h3>Asset</h3>
              <dl className="vw-stats">
                <dt>Name</dt>
                <dd className="vw-name">{name}</dd>
                <Stat
                  label="Format"
                  value={format ? `${format.label} · ${format.description}` : null}
                />
                <Stat label="Type" value={ready ? format?.kindLabel : null} />
                <Stat label="File size" value={sizeLabel !== '—' ? sizeLabel : null} />
                <Stat
                  label={format?.kind === 'splat' ? 'Approx. extent' : 'Bounding box'}
                  value={ready && stats?.size ? formatDimensions(stats.size) : null}
                />
              </dl>
            </section>
            {counts.length > 0 && (
              <section>
                <h3>Geometry</h3>
                <dl className="vw-stats">
                  {counts.map(([label, value]) => (
                    <Stat key={label} label={label} value={formatCount(value)} />
                  ))}
                </dl>
              </section>
            )}
            {playback && (
              <section>
                <h3>Animation</h3>
                <ul className="vw-clips">
                  {playback.clips.map((clip, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        aria-pressed={index === playback.index}
                        onClick={() => playbackActions.selectClip(index)}
                      >
                        <span>{clip.name}</span>
                        <small>{formatTime(clip.duration)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {compact && (
              <section>
                <h3>Display</h3>
                <div className="vw-rows">
                  {narrow && (
                    <RowToggle
                      icon={Focus}
                      label="Frame model"
                      keys="F"
                      disabled={!ready}
                      onClick={() => run({ type: 'frame' })}
                    />
                  )}
                  {Object.entries(TOGGLES).map(([key, spec]) => (
                    <RowToggle
                      key={key}
                      icon={spec.icon}
                      label={spec.label}
                      keys={spec.keys}
                      pressed={!!prefs[key] && available(key)}
                      disabled={!available(key)}
                      reason={UNAVAILABLE[key]}
                      onClick={() => toggle(key)}
                    />
                  ))}
                </div>
                <div className="vw-fields">
                  {viewSelect}
                  {selects}
                </div>
              </section>
            )}
            <section>
              <h3>
                <SlidersHorizontal size={14} aria-hidden="true" /> Settings
              </h3>
              <label className="vw-field vw-range">
                <span>
                  Auto-rotate speed <output>{prefs.autoRotateSpeed.toFixed(2)}×</output>
                </span>
                <input
                  type="range"
                  aria-label="Auto-rotate speed"
                  min={0.25}
                  max={4}
                  step={0.25}
                  value={prefs.autoRotateSpeed}
                  onChange={(event) => setPref('autoRotateSpeed', Number(event.target.value))}
                />
              </label>
              {caps.pointSize && (
                <label className="vw-field vw-range">
                  <span>
                    Point size <output>{prefs.pointSize.toFixed(2)}×</output>
                  </span>
                  <input
                    type="range"
                    aria-label="Point size"
                    min={0.25}
                    max={6}
                    step={0.25}
                    value={prefs.pointSize}
                    onChange={(event) => setPref('pointSize', Number(event.target.value))}
                  />
                </label>
              )}
              {caps.splat && (
                <>
                  <label className="vw-field vw-range">
                    <span>
                      Splat size <output>{prefs.splatScale.toFixed(2)}×</output>
                    </span>
                    <input
                      type="range"
                      aria-label="Splat size"
                      min={0.25}
                      max={2}
                      step={0.05}
                      value={prefs.splatScale}
                      onChange={(event) => setPref('splatScale', Number(event.target.value))}
                    />
                  </label>
                  <RowToggle
                    icon={Sun}
                    label="Point cloud mode"
                    pressed={prefs.splatPoints}
                    onClick={() => setPref('splatPoints', !prefs.splatPoints)}
                  />
                </>
              )}
              {qualitySelect}
              <button type="button" className="vw-action vw-reset" onClick={resetPrefs}>
                Reset viewer settings
              </button>
            </section>
            <section>
              <details
                ref={shortcutsElement}
                className="vw-shortcuts"
                open={helpOpen}
                onToggle={(event) => setHelpOpen(event.currentTarget.open)}
              >
                <summary>
                  <Keyboard size={14} aria-hidden="true" /> Keyboard shortcuts
                </summary>
                {grouped.map(([group, items]) => (
                  <div key={group}>
                    <h4>{group}</h4>
                    <ul>
                      {items.map((item) => (
                        <li key={item.label}>
                          <span>
                            {item.keys.map((key) => (
                              <kbd key={key}>{key}</kbd>
                            ))}
                          </span>
                          {item.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
