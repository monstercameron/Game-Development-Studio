import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { ViewerError } from './viewer-core';

const POINT_MODE_SCALE = 3;

// A few stray splats far from the scene would make the library's own radius frame an
// empty void, so the framing is derived from a sample of splat centres: the median centre
// and the 97th percentile distance from it.
function robustBounds(mesh, count) {
  const stride = Math.max(1, Math.floor(count / 40000)),
    point = new THREE.Vector3(),
    xs = [],
    ys = [],
    zs = [];
  for (let index = 0; index < count; index += stride) {
    mesh.getSplatCenter(index, point, true);
    xs.push(point.x);
    ys.push(point.y);
    zs.push(point.z);
  }
  const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
  const center = new THREE.Vector3(median(xs), median(ys), median(zs));
  const distances = xs
    .map((x, index) => Math.hypot(x - center.x, ys[index] - center.y, zs[index] - center.z))
    .sort((a, b) => a - b);
  const radius = distances[Math.floor(distances.length * 0.97)] * 1.15;
  return Number.isFinite(radius) && radius > 0 ? { center, radius } : null;
}

// Gaussian splat source. The library renders splats itself; the engine supplies the
// camera, orbit controls (so no window-level key handlers are installed), helpers and
// snapshot support through a small adapter.
export async function loadSplatSource(engine, { url, signal, onStage, onProgress }) {
  onStage('Loading Gaussian scene…');
  const viewer = new GaussianSplats3D.Viewer({
    rootElement: engine.host,
    renderer: engine.renderer,
    camera: engine.camera,
    threeScene: engine.scene,
    selfDrivenMode: false,
    useBuiltInControls: false,
    renderMode: GaussianSplats3D.RenderMode.OnChange,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
    ignoreDevicePixelRatio: true,
    sharedMemoryForWorkers: false,
    gpuAcceleratedSort: false,
    sphericalHarmonicsDegree: 0,
    logLevel: GaussianSplats3D.LogLevel.None,
  });
  viewer.controls = engine.controls;
  // The library draws a point as a fixed 1-2 px dot, which on a dense scene reads as a near-black
  // screen. Point mode therefore enlarges its dots; the size slider still scales them.
  let splatScale = 1,
    pointMode = false;
  const applyScale = () =>
    viewer.splatMesh?.setSplatScale(splatScale * (pointMode ? POINT_MODE_SCALE : 1));
  const adapter = {
    update: () => viewer.update(),
    render(force) {
      if (viewer.shouldRender() || force) {
        viewer.render();
        viewer.consecutiveRenderFrames++;
      } else {
        viewer.consecutiveRenderFrames = 0;
      }
      viewer.renderNextFrame = false;
    },
    invalidate: () => viewer.forceRenderNextFrame(),
    resize: () => viewer.forceRenderNextFrame(),
    // The library sizes splats from this value, so it must match the renderer.
    setPixelRatio(ratio) {
      viewer.devicePixelRatio = ratio;
      if (viewer.splatMesh) {
        viewer.splatMesh.devicePixelRatio = ratio;
      }
      viewer.forceRenderNextFrame();
    },
    setSplatScale(scale) {
      splatScale = scale;
      applyScale();
    },
    setPointCloudMode(enabled) {
      pointMode = enabled;
      viewer.splatMesh?.setPointCloudModeEnabled(enabled);
      applyScale();
    },
    dispose: () => viewer.dispose(),
  };
  engine.attachAdapter(adapter);
  adapter.setPixelRatio(engine.pixelRatio);

  // A HEAD request is a cheap way to learn the file size for the inspector.
  const sizeRequest = fetch(url, { method: 'HEAD', signal, redirect: 'error' })
    .then((response) => Number(response.headers.get('content-length')) || null)
    .catch(() => null);

  const loading = viewer.addSplatScene(url, {
    format: GaussianSplats3D.SceneFormat.Ply,
    showLoadingUI: false,
    progressiveLoad: false,
    splatAlphaRemovalThreshold: 5,
    onProgress: (percent, _label, status) => {
      if (status === 1) {
        onStage('Processing splats…');
        onProgress(null);
      } else {
        onProgress(Math.min(Math.max(percent / 100, 0), 1));
      }
    },
  });
  signal.addEventListener('abort', () => loading?.abort?.(), { once: true });
  try {
    await loading;
  } catch (error) {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw new ViewerError(
      'PARSE',
      error?.message && !/abort/i.test(error.message) ? error.message : 'Could not read splats.',
    );
  }
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const mesh = viewer.splatMesh;
  const splats = mesh?.getSplatCount?.() || 0;
  if (!splats) {
    throw new ViewerError('EMPTY', 'This Gaussian scene contains no visible splats.');
  }
  adapter.setPixelRatio(engine.pixelRatio);
  let bounds = null;
  try {
    bounds = robustBounds(mesh, splats);
  } catch {
    // Fall back to the library's own scene extent below.
  }
  engine.setAdapterContent({
    center: bounds?.center || mesh.calculatedSceneCenter?.clone?.() || new THREE.Vector3(),
    radius: bounds?.radius || mesh.maxSplatDistanceFromSceneCenter || 1,
    // Start inside the scene looking forward, as splat worlds are normally viewed.
    home: { position: [0, 0, -0.3], target: [0, 0, 1] },
    stats: { splats },
  });
  return { kind: 'splat', byteLength: await sizeRequest };
}
