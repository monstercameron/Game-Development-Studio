// Shared jsdom + Vite SSR harness for the 3D viewer UI tests. WebGL cannot run here, so the
// engine and the source loaders are replaced with recording fakes; everything else (the
// React components, the shell, shortcut mapping and preference storage) is real.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const FAKE_ENGINE = `
  import { ViewerError } from '/src/viewer-core.js';
  export const log = globalThis.__viewerLog;
  export class FakeEngine {
    constructor(options) {
      if (log.engineFails) {
        throw new ViewerError('NO_WEBGL', 'WebGL is unavailable.');
      }
      this.options = options;
      this.prefs = options.prefs;
      this.applied = [];
      this.calls = [];
      this.disposed = false;
      this.kind = 'mesh';
      this.caps = { wireframe: true, ground: true, lighting: true, pointSize: false, animation: !!log.animated };
      this.stats = { vertices: 100, triangles: 50, meshes: 1, materials: 1, size: [1, 2, 3] };
      this.clip = { time: 0, playing: false, speed: 1 };
      log.engines.push(this);
    }
    snapshotPlayback() {
      return {
        clips: [{ name: 'Walk', duration: 4 }, { name: 'Run', duration: 2 }],
        index: 0,
        time: this.clip.time,
        duration: 4,
        playing: this.clip.playing,
        speed: this.clip.speed,
      };
    }
    playback() { return log.animated ? this.snapshotPlayback() : null; }
    selectClip(index, state) {
      this.calls.push('selectClip:' + index + ':' + state.playing);
      this.clip.playing = state.playing;
      this.clip.time = state.time;
      this.options.onPlayback(this.snapshotPlayback());
    }
    setPlaying(value) { this.calls.push('setPlaying:' + value); this.clip.playing = value; this.options.onPlayback(this.snapshotPlayback()); }
    seek(time) { this.calls.push('seek:' + time); this.clip.time = time; }
    applyPrefs(prefs) { this.prefs = prefs; this.applied.push(prefs); }
    reset() { this.calls.push('reset'); }
    frame() { this.calls.push('frame'); }
    setView(id) { this.calls.push('view:' + id); }
    orbitBy(a, p) { this.calls.push('orbit:' + a + ',' + p); }
    panBy(x, y) { this.calls.push('pan:' + x + ',' + y); }
    zoomBy(f) { this.calls.push('zoom:' + f); }
    snapshot() { this.calls.push('snapshot'); return Promise.resolve(new Blob(['png'])); }
    getCameraState() { return { position: [1, 2, 3], target: [0, 0, 0] }; }
    restoreCameraState(state) { this.calls.push('restore:' + state.position.join(',')); }
    dispose() { this.disposed = true; }
  }
  export function createViewerEngine(options) { return new FakeEngine(options); }
`;

const FAKE_SOURCES = `
  const log = globalThis.__viewerLog;
  async function load(engine, { url, name }) {
    log.loads.push({ url, name });
    if (log.sourceError) { throw log.sourceError; }
    return { kind: 'mesh', byteLength: 1234 };
  }
  export const loadModelSource = load;
  export const loadMotionSource = load;
`;

const stubs = {
  name: 'viewer-test-stubs',
  enforce: 'pre',
  resolveId(source) {
    if (source === './viewer-engine') {
      return '\0viewer-fake-engine';
    }
    if (source === './viewer-sources') {
      return '\0viewer-fake-sources';
    }
    if (source === './useNav') {
      return '\0viewer-fake-nav';
    }
    return null;
  },
  load(id) {
    if (id === '\0viewer-fake-nav') {
      return "import { useState } from 'react'; export const useRouteToggle = () => useState(false);";
    }
    return id === '\0viewer-fake-engine'
      ? FAKE_ENGINE
      : id === '\0viewer-fake-sources'
        ? FAKE_SOURCES
        : null;
  },
};

const GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'ResizeObserver',
  'IntersectionObserver',
  'matchMedia',
  'getComputedStyle',
  'Blob',
  'HTMLElement',
  'IS_REACT_ACT_ENVIRONMENT',
  '__viewerLog',
];

export async function createViewerHarness(t, { reducedMotion = false, storage = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previous = new Map(
    GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const define = (key, value) =>
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  define('localStorage', dom.window.localStorage);
  define('HTMLElement', dom.window.HTMLElement);
  define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  define('Blob', dom.window.Blob);
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  define(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const media = {
    matches: reducedMotion,
    addEventListener() {},
    removeEventListener() {},
  };
  dom.window.matchMedia = () => media;
  define('matchMedia', dom.window.matchMedia);
  for (const [key, value] of Object.entries(storage)) {
    dom.window.localStorage.setItem(key, value);
  }
  // The viewer logs load failures for diagnostics; keep expected ones out of the test output.
  const consoleError = console.error;
  console.error = (...args) => {
    // React also warns when a lazily imported chunk resolves between awaited act() calls.
    const message = String(args[0]);
    if (!message.startsWith('3D viewer') && !message.startsWith('A suspended resource finished')) {
      consoleError(...args);
    }
  };
  const log = { engines: [], loads: [], engineFails: false, sourceError: null, animated: false };
  define('__viewerLog', log);

  const server = await createServer({
    configFile: false,
    root: repositoryRoot,
    esbuild: { jsx: 'automatic' },
    plugins: [stubs],
    server: { middlewareMode: true, watch: null },
    appType: 'custom',
    logLevel: 'silent',
  });
  const { createRoot } = await import('react-dom/client');
  const container = dom.window.document.getElementById('root');
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await server.close();
    console.error = consoleError;
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  });
  return {
    dom,
    container,
    root,
    log,
    load: (file) => server.ssrLoadModule(path.posix.join('/src', file)),
    key: (target, key, init = {}) =>
      act(async () => {
        target.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      }),
    click: (target) => act(async () => target.click()),
    settle: () => act(async () => new Promise((resolve) => setTimeout(resolve, 0))),
    // Lazy chunks load through Vite's module runner, so wait for what the test needs.
    waitFor: async (predicate, label = 'condition') => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (predicate()) {
          return;
        }
        await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      throw new Error(`Timed out waiting for ${label}`);
    },
  };
}
