import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ArrowRight,
  AudioLines,
  Clapperboard,
  CornerUpLeft,
  GripVertical,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  clampPosition,
  close,
  consumeReturn,
  createRepeatState,
  cycleRepeat,
  formatTime,
  getServerSnapshot,
  getSnapshot,
  loadPosition,
  open,
  repeatLabel,
  repeatName,
  repeatOnEnded,
  repeatOnSeek,
  requestExpand,
  savePosition,
  setMinimized,
  subscribe,
} from './mini-player';
import './ux-miniplayer.css';

const STEP = 16;
const BIG_STEP = 64;

function viewportSize() {
  const root = document.documentElement;
  return { width: root.clientWidth || window.innerWidth, height: window.innerHeight };
}

// The "Shrink to mini player" button for an inline <audio>/<video> preview. It finds the
// media element inside `scope`, pauses it, and opens the mini player at the same time and
// playing state. It also resumes the inline element when the mini player hands playback
// back ("Back to full preview").
export function ShrinkButton({
  scope,
  selector = 'video, audio',
  kind,
  url,
  name,
  onShrunk,
  className = '',
  children,
}) {
  const buttonRef = useRef(null);
  const find = () => buttonRef.current?.closest(scope)?.querySelector(selector) || null;
  useEffect(() => {
    function resume() {
      const media = buttonRef.current?.closest(scope)?.querySelector(selector);
      if (!media) {
        return;
      }
      const pending = consumeReturn(url);
      if (!pending) {
        return;
      }
      const start = () => {
        try {
          media.currentTime = pending.time;
        } catch {
          // Some streams cannot seek before they are ready; playback just starts from the top.
        }
        if (pending.playing) {
          media.play().catch(() => {});
        }
      };
      if (media.readyState >= 1) {
        start();
      } else {
        media.addEventListener('loadedmetadata', start, { once: true });
      }
    }
    resume();
    return subscribe(resume);
  }, [scope, selector, url]);
  function shrink() {
    const media = find();
    const playing = Boolean(media && !media.paused && !media.ended);
    const time = media && !media.ended ? media.currentTime : 0;
    media?.pause();
    open({
      kind,
      url,
      name,
      time,
      playing,
      origin: window.location.pathname + window.location.search,
    });
    onShrunk?.();
  }
  const label = 'Shrink to mini player';
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`mini-shrink ${className}`.trim()}
      aria-label={label}
      title={label}
      onClick={shrink}
    >
      <PictureInPicture2 size={17} aria-hidden="true" />
      {children}
    </button>
  );
}

const REPEAT_ICONS = { never: ArrowRight, once: Repeat1, loop: Repeat };

function useRepeat() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).repeat;
}

// Single cycle button: Never -> Once -> Loop. Used by the mini player and inline previews.
function RepeatToggle({ repeat, className = '', showLabel = false }) {
  const Icon = REPEAT_ICONS[repeat] || ArrowRight;
  return (
    <button
      type="button"
      className={className}
      data-repeat={repeat}
      aria-label={repeatLabel(repeat)}
      title={`Repeat: ${repeatName(repeat)}. Click to change.`}
      onClick={cycleRepeat}
    >
      <Icon size={16} aria-hidden="true" />
      {showLabel && <span>Repeat: {repeatName(repeat)}</span>}
    </button>
  );
}

// Repeat control for an inline <audio>/<video> preview. The media element is replaced when the
// asset changes, so `ended` is observed on `scope` in the capture phase (it does not bubble).
export function RepeatButton({
  scope,
  selector = 'video, audio',
  className = '',
  showLabel = false,
}) {
  const anchorRef = useRef(null);
  const repeat = useRepeat();
  useEffect(() => {
    const root = anchorRef.current?.closest(scope);
    if (!root) {
      return undefined;
    }
    let tracked = null;
    let counter = createRepeatState(repeat);
    let ignoreSeek = false;
    const matches = (target) => target instanceof HTMLMediaElement && target.matches(selector);
    const track = (media) => {
      if (media !== tracked) {
        tracked = media;
        counter = createRepeatState(repeat);
      }
      media.loop = repeat === 'loop';
    };
    const onPlay = (event) => matches(event.target) && track(event.target);
    const onEnded = (event) => {
      const media = event.target;
      if (!matches(media)) {
        return;
      }
      track(media);
      const decision = repeatOnEnded(counter);
      counter = decision.state;
      if (decision.replay) {
        ignoreSeek = true;
        media.currentTime = 0;
        media.play().catch(() => {});
      }
    };
    const onSeeked = (event) => {
      if (!matches(event.target)) {
        return;
      }
      if (ignoreSeek) {
        ignoreSeek = false;
      } else {
        counter = repeatOnSeek(counter, event.target.currentTime);
      }
    };
    const current = root.querySelector(selector);
    if (current) {
      track(current);
    }
    root.addEventListener('play', onPlay, true);
    root.addEventListener('ended', onEnded, true);
    root.addEventListener('seeked', onSeeked, true);
    return () => {
      root.removeEventListener('play', onPlay, true);
      root.removeEventListener('ended', onEnded, true);
      root.removeEventListener('seeked', onSeeked, true);
    };
  }, [scope, selector, repeat]);
  return (
    <span ref={anchorRef} className="mini-repeat-anchor">
      <RepeatToggle
        repeat={repeat}
        className={`mini-repeat ${className}`.trim()}
        showLabel={showLabel}
      />
    </span>
  );
}

export default function MiniPlayer() {
  const { item, minimized } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [announcement, setAnnouncement] = useState('');
  const previousId = useRef(null);
  const itemId = item?.id ?? null;
  const itemName = item?.name;
  const itemPlaying = item?.playing;
  useEffect(() => {
    if (itemId !== null) {
      setAnnouncement(`Mini player: ${itemName}, ${itemPlaying ? 'playing' : 'ready'}`);
    } else if (previousId.current !== null) {
      setAnnouncement('Mini player closed');
    }
    previousId.current = itemId;
  }, [itemId, itemName, itemPlaying]);
  return (
    <>
      <div className="mini-player-status" role="status" aria-live="polite">
        {announcement}
      </div>
      {item && <Dock key={item.id} item={item} minimized={minimized} />}
    </>
  );
}

function Dock({ item, minimized }) {
  const navigate = useNavigate();
  const location = useLocation();
  const dockRef = useRef(null);
  const mediaRef = useRef(null);
  const started = useRef(false);
  const repeat = useRepeat();
  const counter = useRef(createRepeatState(repeat));
  const ignoreSeek = useRef(false);
  const drag = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(item.time);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(loadPosition);
  const isVideo = item.kind === 'video';
  const KindIcon = isVideo ? Clapperboard : AudioLines;

  // Keep the position stored as offsets from the bottom-right corner inside the viewport.
  function place(next, remember = true) {
    const rect = dockRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const clamped = clampPosition(next, rect, viewportSize());
    setPosition(clamped);
    if (remember) {
      savePosition(clamped);
    }
  }
  function currentOffsets() {
    const rect = dockRef.current.getBoundingClientRect();
    const view = viewportSize();
    return { right: view.width - rect.right, bottom: view.height - rect.bottom };
  }
  useLayoutEffect(() => {
    if (position) {
      place(position, false);
    }
    // Resizing the dock (pill <-> full) can push it past the edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimized]);
  useEffect(() => {
    const onResize = () => setPosition((value) => (value ? { ...value } : value));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    if (position) {
      const rect = dockRef.current.getBoundingClientRect();
      const clamped = clampPosition(position, rect, viewportSize());
      if (clamped.right !== position.right || clamped.bottom !== position.bottom) {
        setPosition(clamped);
      }
    }
  }, [position]);

  // Keyboard handling is native so the shell's own document-level Escape and arrow-key
  // shortcuts (dialogs, gallery stepping) do not also react to keys meant for the dock.
  useEffect(() => {
    const dock = dockRef.current;
    function onKeyDown(event) {
      if (event.key === 'Escape' && !minimized) {
        event.stopPropagation();
        setMinimized(true);
        dock.querySelector('[data-mini="toggle"]')?.focus();
        return;
      }
      if (event.target.closest?.('[data-mini="grip"]')) {
        const step = event.shiftKey ? BIG_STEP : STEP;
        const delta = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }[event.key];
        if (delta) {
          event.preventDefault();
          event.stopPropagation();
          const offsets = currentOffsets();
          place({ right: offsets.right - delta[0], bottom: offsets.bottom - delta[1] });
        }
      }
    }
    dock.addEventListener('keydown', onKeyDown);
    return () => dock.removeEventListener('keydown', onKeyDown);
  }, [minimized]);

  // Never play two things at once: starting any other media element pauses the mini player.
  useEffect(() => {
    function onOtherPlay(event) {
      if (event.target !== mediaRef.current && event.target instanceof HTMLMediaElement) {
        mediaRef.current?.pause();
      }
    }
    document.addEventListener('play', onOtherPlay, true);
    return () => document.removeEventListener('play', onOtherPlay, true);
  }, []);

  // Stop the element when the dock goes away (close, replace, or hand-back).
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      media?.pause();
    };
  }, []);

  // Lock-screen / media-key integration where the browser supports it.
  useEffect(() => {
    const session = typeof navigator === 'undefined' ? null : navigator.mediaSession;
    if (!session) {
      return undefined;
    }
    try {
      if (typeof MediaMetadata === 'function') {
        session.metadata = new MediaMetadata({ title: item.name, artist: 'Forge Studio' });
      }
      const handlers = {
        play: () => mediaRef.current?.play().catch(() => {}),
        pause: () => mediaRef.current?.pause(),
        stop: () => close(),
        seekbackward: () => seekBy(-10),
        seekforward: () => seekBy(10),
      };
      for (const [action, handler] of Object.entries(handlers)) {
        session.setActionHandler(action, handler);
      }
    } catch {
      // Some actions are unsupported in some browsers.
    }
    return () => {
      try {
        session.metadata = null;
        for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward']) {
          session.setActionHandler(action, null);
        }
      } catch {
        // Nothing to clean up.
      }
    };
  }, [item.id, item.name]);
  useEffect(() => {
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }, [playing]);

  // Loop uses the native attribute; Never and Once are decided on `ended`. A mode change
  // starts the once-counter over.
  useEffect(() => {
    counter.current = createRepeatState(repeat);
    if (mediaRef.current) {
      mediaRef.current.loop = repeat === 'loop';
    }
  }, [repeat]);

  function seekBy(seconds) {
    const media = mediaRef.current;
    if (media) {
      media.currentTime = Math.max(
        0,
        Math.min(media.duration || Infinity, media.currentTime + seconds),
      );
    }
  }
  function toggle() {
    const media = mediaRef.current;
    if (!media) {
      return;
    }
    if (media.paused) {
      media.play().catch(() => setFailed(true));
    } else {
      media.pause();
    }
  }
  function backToPreview() {
    const media = mediaRef.current;
    const origin = requestExpand({ time: media?.currentTime, playing: !media?.paused });
    const here = location.pathname + location.search;
    if (origin && origin !== here) {
      navigate(origin);
    }
  }

  function startDrag(event) {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ...currentOffsets() };
  }
  function moveDrag(event) {
    const start = drag.current;
    if (start) {
      place(
        {
          right: start.right - (event.clientX - start.x),
          bottom: start.bottom - (event.clientY - start.y),
        },
        false,
      );
    }
  }
  function endDrag(event) {
    if (drag.current) {
      drag.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      setPosition((value) => {
        if (value) {
          savePosition(value);
        }
        return value;
      });
    }
  }

  const mediaProps = {
    ref: mediaRef,
    src: item.url,
    preload: 'metadata',
    onLoadedMetadata: (event) => {
      const media = event.currentTarget;
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      if (!started.current) {
        started.current = true;
        if (item.time > 0) {
          try {
            media.currentTime = Math.min(item.time, media.duration || item.time);
          } catch {
            // Playback simply starts from the beginning.
          }
        }
        if (item.playing) {
          media.play().catch(() => setFailed(true));
        }
      }
    },
    onDurationChange: (event) => {
      const value = event.currentTarget.duration;
      setDuration(Number.isFinite(value) ? value : 0);
    },
    onTimeUpdate: (event) => setTime(event.currentTarget.currentTime),
    onPlay: () => {
      setPlaying(true);
      setFailed(false);
    },
    onPause: () => setPlaying(false),
    onEnded: (event) => {
      const media = event.currentTarget;
      const decision = repeatOnEnded(counter.current);
      counter.current = decision.state;
      if (decision.replay) {
        ignoreSeek.current = true;
        media.currentTime = 0;
        media.play().catch(() => setFailed(true));
      } else {
        setPlaying(false);
      }
    },
    onSeeked: (event) => {
      if (ignoreSeek.current) {
        ignoreSeek.current = false;
      } else {
        counter.current = repeatOnSeek(counter.current, event.currentTarget.currentTime);
      }
    },
    onVolumeChange: (event) => setMuted(event.currentTarget.muted),
    onError: () => setFailed(true),
  };

  const style = position ? { right: position.right, bottom: position.bottom } : undefined;
  const playLabel = playing ? 'Pause' : 'Play';
  const PlayIcon = playing ? Pause : Play;
  return (
    <section
      ref={dockRef}
      role="region"
      aria-label="Mini player"
      className={`mini-player ${isVideo ? 'is-video' : 'is-audio'}${minimized ? ' is-minimized' : ''}`}
      style={style}
    >
      <div className="mini-player-head">
        <button
          type="button"
          className="mini-player-button mini-player-grip"
          data-mini="grip"
          aria-label="Move mini player"
          title="Drag to move, or use the arrow keys (hold Shift for larger steps)"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <GripVertical size={16} aria-hidden="true" />
        </button>
        <KindIcon size={16} className="mini-player-kind" aria-hidden="true" />
        <strong className="mini-player-title" title={item.name}>
          {item.name}
        </strong>
        {minimized && (
          <button
            type="button"
            className="mini-player-button"
            aria-label={playLabel}
            title={playLabel}
            onClick={toggle}
          >
            <PlayIcon size={16} aria-hidden="true" />
          </button>
        )}
        {(minimized || isVideo) && (
          <RepeatToggle repeat={repeat} className="mini-player-button mini-player-repeat" />
        )}
        {!minimized && item.origin && (
          <button
            type="button"
            className="mini-player-button"
            aria-label="Back to full preview"
            title="Back to full preview"
            onClick={backToPreview}
          >
            <CornerUpLeft size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="mini-player-button"
          data-mini="toggle"
          aria-label={minimized ? 'Expand mini player' : 'Minimize mini player'}
          aria-expanded={!minimized}
          title={minimized ? 'Expand mini player' : 'Minimize mini player'}
          onClick={() => setMinimized(!minimized)}
        >
          {minimized ? (
            <Maximize2 size={16} aria-hidden="true" />
          ) : (
            <Minimize2 size={16} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="mini-player-button"
          aria-label="Close mini player"
          title="Close mini player"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {isVideo ? (
        <div className="mini-player-video">
          <video {...mediaProps} controls playsInline />
        </div>
      ) : (
        <audio {...mediaProps} />
      )}
      {!isVideo && !minimized && (
        <div className="mini-player-controls">
          <button
            type="button"
            className="mini-player-button mini-player-play"
            aria-label={playLabel}
            title={playLabel}
            onClick={toggle}
          >
            <PlayIcon size={16} aria-hidden="true" />
          </button>
          <input
            type="range"
            className="mini-player-seek"
            aria-label="Seek"
            aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
            min={0}
            max={duration || 0}
            step="any"
            value={Math.min(time, duration || 0)}
            disabled={!duration}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setTime(value);
              if (mediaRef.current) {
                mediaRef.current.currentTime = value;
              }
            }}
          />
          <span className="mini-player-time">
            {formatTime(time)} / {formatTime(duration)}
          </span>
          <RepeatToggle repeat={repeat} className="mini-player-button mini-player-repeat" />
          <button
            type="button"
            className="mini-player-button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            title={muted ? 'Unmute' : 'Mute'}
            onClick={() => {
              if (mediaRef.current) {
                mediaRef.current.muted = !mediaRef.current.muted;
              }
            }}
          >
            {muted ? (
              <VolumeX size={16} aria-hidden="true" />
            ) : (
              <Volume2 size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      )}
      {failed && !playing && !minimized && (
        <p className="mini-player-error" role="alert">
          Could not play this file. Press play to try again.
        </p>
      )}
    </section>
  );
}
