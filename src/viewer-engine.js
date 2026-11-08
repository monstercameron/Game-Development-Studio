import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeSceneStats, disposeObject3D } from './viewer-assets';
import { LIGHT_RIGS, createEnvironmentTexture, createLightRig } from './viewer-lighting';
import {
  BACKGROUND_PRESETS,
  DEFAULT_PREFS,
  DEFAULT_VIEW,
  SNAPSHOT_BACKGROUNDS,
  ViewerError,
  clamp,
  fitDistance,
  niceStep,
  orbitVector,
  qualityPixelRatio,
  viewDirection,
} from './viewer-core';
import {
  PANORAMA_INSIDE_FOV,
  PANORAMA_OUTSIDE_FOV,
  dragLook,
  lookForward,
  lookFromDirection,
  turnLook,
  wheelFieldOfView,
  zoomFieldOfView,
} from './viewer-panorama';

// Shadows are skipped for very heavy meshes so toggling them can never stall the tab.
const MAX_SHADOW_TRIANGLES = 2_000_000;
// One arrow-key press turns the orbit or the look direction by 15 degrees.
const KEYBOARD_ORBIT_STEP = Math.PI / 12;

function materialsOf(object) {
  return (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean);
}

export class ViewerEngine {
  /**
   * Creates the WebGL renderer inside `host` and wires pointer, resize and visibility listeners.
   * Throws a ViewerError with code NO_WEBGL when no WebGL context can be created; in that case
   * nothing is appended to `host`. Call dispose() to release the renderer and listeners.
   */
  constructor({
    host,
    flipY = false,
    powerPreference = 'default',
    prefs = DEFAULT_PREFS,
    reducedMotion = false,
    onPlayback = () => {},
    onView = () => {},
    onContextLost = () => {},
  }) {
    this.host = host;
    this.flipY = flipY;
    this.reducedMotion = reducedMotion;
    this.onPlayback = onPlayback;
    this.onView = onView;
    this.onContextLost = onContextLost;
    this.prefs = { ...DEFAULT_PREFS, ...prefs };
    this.disposed = false;
    this.visible = true;
    this.frameId = 0;
    this.lastTime = 0;
    this.frameDelta = 0;
    this.tween = null;
    this.activeView = null;
    this.adapter = null;
    this.content = null;
    this.updaters = [];
    this.disposables = [];
    this.caps = {};
    this.stats = null;
    this.center = new THREE.Vector3();
    this.size = new THREE.Vector3(1, 1, 1);
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    this.radius = 1;
    this.groundY = -0.5;
    this.homeView = null;
    this.mixer = null;
    this.clips = [];
    this.action = null;
    this.playing = false;
    this.speed = this.prefs.playbackSpeed;
    this.lastPlaybackNotice = 0;
    this.envTexture = null;
    this.rig = null;
    this.keyLight = null;
    this.helpers = {};

    // Panorama shells: detected at load, then switched between the orbit camera (outside)
    // and a camera fixed at the shell centre that turns in place (inside).
    this.panorama = { detected: false, inside: false, source: null };
    this.look = { yaw: 0, pitch: 0 };
    this.lookDrag = null;

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference });
    } catch {
      throw new ViewerError('NO_WEBGL', 'WebGL is unavailable.');
    }
    const renderer = this.renderer;
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyPixelRatio();
    renderer.domElement.style.touchAction = 'none';
    host.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.world = new THREE.Group();
    this.helperGroup = new THREE.Group();
    this.lightGroup = new THREE.Group();
    this.scene.add(this.lightGroup, this.helperGroup, this.world);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
    // OrbitControls reads camera.up once when it is created.
    this.camera.up.set(0, flipY ? -1 : 1, 0);
    this.camera.position.set(0, 0, 3);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.9;
    this.controls.panSpeed = 0.9;
    const update = this.controls.update.bind(this.controls);
    // Auto-rotate speed must not depend on the display's refresh rate.
    this.controls.update = () => update(this.controls.autoRotate ? this.frameDelta : null);
    this.controlsUpdate = this.controls.update;
    this.onControlsChange = () => this.requestRender();
    this.onControlsStart = () => {
      this.tween = null;
      this.setActiveView(null);
    };
    this.controls.addEventListener('change', this.onControlsChange);
    this.controls.addEventListener('start', this.onControlsStart);

    this.onContextLostEvent = (event) => {
      event.preventDefault();
      this.onContextLost();
    };
    renderer.domElement.addEventListener('webglcontextlost', this.onContextLostEvent);
    this.onLookPointerDown = this.handleLookPointerDown.bind(this);
    this.onLookPointerMove = this.handleLookPointerMove.bind(this);
    this.onLookPointerUp = this.handleLookPointerUp.bind(this);
    this.onLookWheel = this.handleLookWheel.bind(this);
    renderer.domElement.addEventListener('pointerdown', this.onLookPointerDown);
    renderer.domElement.addEventListener('pointermove', this.onLookPointerMove);
    renderer.domElement.addEventListener('pointerup', this.onLookPointerUp);
    renderer.domElement.addEventListener('pointercancel', this.onLookPointerUp);
    renderer.domElement.addEventListener('wheel', this.onLookWheel, { passive: false });
    this.onVisibility = () => {
      this.lastTime = 0;
      this.requestRender();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    if (typeof IntersectionObserver === 'function') {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        this.visible = !!entries[entries.length - 1]?.isIntersecting;
        this.lastTime = 0;
        if (this.visible) {
          this.requestRender();
        }
      });
      this.intersectionObserver.observe(host);
    }
    this.resize();
    this.applyLighting(this.prefs.lighting);
  }

  // ---- sizing and loop ----------------------------------------------------

  applyPixelRatio() {
    this.pixelRatio = qualityPixelRatio(this.prefs.quality, window.devicePixelRatio || 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.adapter?.setPixelRatio?.(this.pixelRatio);
  }

  resize() {
    if (this.disposed) {
      return;
    }
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (!width || !height) {
      return;
    }
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.adapter?.resize?.(width, height);
    this.invalidate();
  }

  get continuous() {
    return !!(
      this.adapter ||
      this.controls?.autoRotate ||
      this.tween ||
      (this.playing && this.mixer)
    );
  }

  requestRender() {
    if (this.frameId || this.disposed) {
      return;
    }
    this.frameId = requestAnimationFrame((now) => this.tick(now));
  }

  invalidate() {
    this.adapter?.invalidate?.();
    this.requestRender();
  }

  tick(now) {
    this.frameId = 0;
    if (this.disposed) {
      return;
    }
    if (!this.visible || document.hidden) {
      this.lastTime = 0;
      return;
    }
    this.frameDelta = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = now;
    this.stepTween(now);
    if (this.playing && this.mixer) {
      this.mixer.update(this.frameDelta);
      if (now - this.lastPlaybackNotice > 100) {
        this.lastPlaybackNotice = now;
        this.onPlayback(this.playback());
      }
    }
    // Inside a panorama the camera is set by applyLook(); OrbitControls would re-aim it.
    if (!this.adapter && !this.panorama.inside) {
      this.controlsUpdate();
    }
    this.renderNow();
    if (this.continuous) {
      this.requestRender();
    } else {
      this.lastTime = 0;
    }
  }

  renderNow(force = false) {
    if (this.disposed) {
      return;
    }
    for (const updater of this.updaters) {
      updater();
    }
    if (this.adapter) {
      this.adapter.update();
      this.adapter.render(force);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ---- content ------------------------------------------------------------

  // Adds a loaded object, centres it on the origin and builds scale-aware helpers.
  setContent({
    root,
    bounds,
    animations = [],
    mixerRoot = null,
    kind = 'mesh',
    updaters = [],
    disposables = [],
    attachments = [],
    stats = null,
    panorama = null,
  }) {
    if (!bounds || bounds.isEmpty()) {
      throw new ViewerError('EMPTY', 'This 3D file has no visible geometry.');
    }
    const center = bounds.getCenter(new THREE.Vector3()),
      size = bounds.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(largest) || largest <= 0) {
      throw new ViewerError('EMPTY', 'This 3D file has invalid dimensions.');
    }
    root.position.sub(center);
    root.updateMatrixWorld(true);
    this.world.add(root, ...attachments);
    this.content = root;
    this.updaters = updaters;
    this.disposables = disposables;
    this.kind = kind;
    this.center.set(0, 0, 0);
    this.bounds = bounds.clone().translate(center.negate());
    this.size = size;
    this.radius = size.length() / 2;
    this.groundY = this.bounds.min.y;
    this.stats = { ...(stats || computeSceneStats(root)), size: size.toArray() };
    const meshes = [],
      points = [];
    root.traverse((object) => {
      if (object.isMesh) {
        meshes.push(object);
      } else if (object.isPoints) {
        points.push(object);
      }
    });
    this.meshes = meshes;
    this.points = points;
    for (const mesh of meshes) {
      for (const material of materialsOf(mesh)) {
        // The side the file asked for, restored when leaving the inside view.
        material.userData.baseSide ??= material.side;
      }
    }
    for (const point of points) {
      for (const material of materialsOf(point)) {
        material.userData.baseSize = material.size;
      }
    }
    const canShadow =
      meshes.length > 0 && kind === 'mesh' && this.stats.triangles <= MAX_SHADOW_TRIANGLES;
    for (const mesh of meshes) {
      mesh.castShadow = canShadow;
    }
    this.panorama = { detected: !!panorama, inside: !!panorama, source: panorama || null };
    this.caps = {
      wireframe: meshes.length > 0 && kind !== 'skeleton',
      ground: canShadow,
      lighting: meshes.length > 0 && kind === 'mesh',
      pointSize: points.length > 0,
      splat: false,
      animation: animations.length > 0,
    };
    if (animations.length) {
      this.setAnimation(mixerRoot || root, animations);
    }
    this.finishContent();
  }

  // Splat renderers own their drawing; the engine supplies camera, controls and helpers.
  // Attaching before the scene finishes loading lets dispose() always drain the renderer.
  attachAdapter(adapter) {
    this.adapter = adapter;
    adapter.setPixelRatio?.(this.pixelRatio);
    this.requestRender();
  }

  setAdapterContent({ center, radius, home, stats = null }) {
    const adapter = this.adapter;
    if (!adapter || !(radius > 0) || !Number.isFinite(radius)) {
      throw new ViewerError('EMPTY', 'This scene has no visible splats.');
    }
    this.kind = 'splat';
    this.center.copy(center);
    this.radius = radius;
    this.size = new THREE.Vector3(radius * 2, radius * 2, radius * 2);
    this.bounds = new THREE.Box3(
      center.clone().subScalar(radius),
      center.clone().addScalar(radius),
    );
    this.groundY = center.y + radius * 0.5 * (this.flipY ? 1 : -1);
    this.homeView = home || null;
    this.caps = {
      wireframe: false,
      ground: false,
      lighting: false,
      pointSize: false,
      splat: true,
      animation: false,
    };
    this.stats = stats ? { ...stats, size: this.size.toArray() } : null;
    this.finishContent();
  }

  finishContent() {
    const radius = this.radius;
    this.camera.near = Math.max(radius * 0.002, 1e-4);
    this.camera.far = Math.max(radius * 80, 10);
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.adapter ? 0 : radius * 0.05;
    this.controls.maxDistance = radius * 30;
    this.applyLighting(this.prefs.lighting);
    this.applyPrefs(this.prefs, true);
    if (this.panorama.detected) {
      this.applyPanoramaMode();
    }
    this.goHome({ animate: false });
    this.controls.saveState();
    this.requestRender();
  }

  // ---- camera -------------------------------------------------------------

  frameDistance() {
    return fitDistance(this.size.toArray(), this.camera.fov, this.camera.aspect);
  }

  setActiveView(view) {
    if (this.activeView !== view) {
      this.activeView = view;
      this.onView(view);
    }
  }

  moveCamera(position, target, { animate = true } = {}) {
    const toPosition = new THREE.Vector3().fromArray(position),
      toTarget = target.clone();
    if (!animate || this.reducedMotion || this.disposed) {
      this.tween = null;
      this.camera.position.copy(toPosition);
      this.controls.target.copy(toTarget);
      this.controlsUpdate();
      this.requestRender();
      return;
    }
    this.tween = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPosition,
      toTarget,
      start: 0,
      duration: 320,
    };
    this.requestRender();
  }

  stepTween(now) {
    const tween = this.tween;
    if (!tween) {
      return;
    }
    tween.start ||= now;
    const progress = clamp((now - tween.start) / tween.duration, 0, 1);
    const eased = 1 - (1 - progress) ** 3;
    this.camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
    this.controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    if (progress >= 1) {
      this.tween = null;
    }
  }

  setView(id, options) {
    if (this.panorama.inside) {
      this.look = lookFromDirection(viewDirection(id, { flipY: this.flipY }));
      this.applyLook();
      this.setActiveView(id);
      return;
    }
    const direction = viewDirection(id, { flipY: this.flipY });
    const distance = this.frameDistance();
    this.moveCamera(
      [
        this.center.x + direction[0] * distance,
        this.center.y + direction[1] * distance,
        this.center.z + direction[2] * distance,
      ],
      this.center,
      options,
    );
    this.setActiveView(id);
  }

  goHome(options) {
    if (this.panorama.inside) {
      this.look = { yaw: 0, pitch: 0 };
      this.setActiveView(null);
      this.applyLook();
      return;
    }
    if (this.homeView) {
      this.moveCamera(
        this.homeView.position,
        new THREE.Vector3().fromArray(this.homeView.target),
        options,
      );
      this.setActiveView(null);
    } else {
      this.setView(DEFAULT_VIEW, options);
      this.setActiveView(null);
    }
  }

  reset() {
    this.goHome();
  }

  // Fits the whole model in view from the current direction and re-centres the orbit.
  frame() {
    if (this.panorama.inside) {
      this.goHome();
      return;
    }
    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-12) {
      direction.set(...viewDirection(DEFAULT_VIEW, { flipY: this.flipY }));
    }
    direction.normalize().multiplyScalar(this.frameDistance()).add(this.center);
    this.moveCamera(direction.toArray(), this.center);
  }

  orbitBy(azimuthSteps, polarSteps) {
    if (this.panorama.inside) {
      this.look = turnLook(
        this.look,
        azimuthSteps * KEYBOARD_ORBIT_STEP,
        polarSteps * KEYBOARD_ORBIT_STEP,
      );
      this.setActiveView(null);
      this.applyLook();
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const next = orbitVector(
      offset.toArray(),
      azimuthSteps * KEYBOARD_ORBIT_STEP,
      polarSteps * KEYBOARD_ORBIT_STEP,
      { flipY: this.flipY },
    );
    this.tween = null;
    this.setActiveView(null);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3().fromArray(next));
    this.controlsUpdate();
    this.requestRender();
  }

  panBy(dx, dy) {
    // Panning would move the camera off the shell centre, so inside it is not offered.
    if (this.panorama.inside) {
      return;
    }
    const distance = this.camera.position.distanceTo(this.controls.target);
    const step = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 0.1;
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0),
      up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const move = right.multiplyScalar(dx * step).add(up.multiplyScalar(dy * step));
    this.tween = null;
    this.setActiveView(null);
    this.camera.position.add(move);
    this.controls.target.add(move);
    this.controlsUpdate();
    this.requestRender();
  }

  zoomBy(factor) {
    if (this.panorama.inside) {
      this.setFieldOfView(zoomFieldOfView(this.camera.fov, factor));
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = clamp(
      offset.length() * factor,
      this.controls.minDistance || 1e-6,
      this.controls.maxDistance,
    );
    this.tween = null;
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance));
    this.controlsUpdate();
    this.requestRender();
  }

  getCameraState() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  restoreCameraState(state) {
    if (!state?.position || !state?.target) {
      return;
    }
    if (this.panorama.inside) {
      // A stored outside pose only contributes its look direction; the camera stays central.
      const direction = state.position.map((value, axis) => value - state.target[axis]);
      if (direction.some((value) => value !== 0)) {
        this.look = lookFromDirection(direction);
      }
      this.applyLook();
      this.setActiveView(null);
      return;
    }
    this.moveCamera(state.position, new THREE.Vector3().fromArray(state.target), {
      animate: false,
    });
    this.setActiveView(null);
  }

  // ---- panorama shells ------------------------------------------------------

  panoramaState() {
    return { ...this.panorama };
  }

  // Inside stands the camera at the shell centre and turns it in place. Outside returns to
  // the orbit camera. Only shells detected when the file loaded can switch.
  setPanoramaInside(inside) {
    if (!this.panorama.detected) {
      return;
    }
    const next = !!inside;
    if (next === this.panorama.inside) {
      return;
    }
    this.panorama.inside = next;
    this.tween = null;
    this.lookDrag = null;
    this.applyPanoramaMode();
    if (next) {
      this.look = { yaw: 0, pitch: 0 };
      this.applyLook();
    } else {
      this.goHome({ animate: false });
    }
    this.requestRender();
  }

  // Sets the lens, the orbit controls and face culling for the current state.
  applyPanoramaMode() {
    const inside = this.panorama.inside;
    this.controls.enabled = !inside;
    this.camera.fov = inside ? PANORAMA_INSIDE_FOV : PANORAMA_OUTSIDE_FOV;
    this.camera.updateProjectionMatrix();
    for (const mesh of this.meshes || []) {
      for (const material of materialsOf(mesh)) {
        // Seen from inside, the faces point away from the viewer, so both sides must draw.
        const side = inside ? THREE.DoubleSide : (material.userData.baseSide ?? THREE.FrontSide);
        if (material.side !== side) {
          material.side = side;
          material.needsUpdate = true;
        }
      }
    }
  }

  applyLook() {
    this.camera.position.copy(this.center);
    this.camera.rotation.set(this.look.pitch, this.look.yaw, 0, 'YXZ');
    const [x, y, z] = lookForward(this.look);
    this.controls.target.copy(this.camera.position).add(new THREE.Vector3(x, y, z));
    this.requestRender();
  }

  setFieldOfView(fovDegrees) {
    this.camera.fov = fovDegrees;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  handleLookPointerDown(event) {
    if (!this.panorama.inside || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    this.lookDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
    this.tween = null;
    this.setActiveView(null);
  }

  handleLookPointerMove(event) {
    if (!this.lookDrag || event.pointerId !== this.lookDrag.id) {
      return;
    }
    const deltaX = event.clientX - this.lookDrag.x;
    const deltaY = event.clientY - this.lookDrag.y;
    this.lookDrag.x = event.clientX;
    this.lookDrag.y = event.clientY;
    this.look = dragLook(this.look, deltaX, deltaY);
    this.applyLook();
  }

  handleLookPointerUp(event) {
    if (this.lookDrag?.id === event.pointerId) {
      this.lookDrag = null;
      this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    }
  }

  handleLookWheel(event) {
    if (!this.panorama.inside) {
      return;
    }
    event.preventDefault();
    this.setFieldOfView(wheelFieldOfView(this.camera.fov, event.deltaY));
  }

  // ---- helpers: grid, axes, bounds, ground ---------------------------------

  disposeHelpers() {
    for (const object of Object.values(this.helpers)) {
      this.helperGroup.remove(object);
      object.geometry?.dispose();
      for (const material of materialsOf(object)) {
        material.dispose();
      }
    }
    this.helpers = {};
  }

  get backgroundIsLight() {
    return !!BACKGROUND_PRESETS.find((preset) => preset.id === this.prefs.background)?.light;
  }

  buildHelpers() {
    this.disposeHelpers();
    const { grid, axes, bounds, ground } = this.prefs;
    const largest = Math.max(this.size.x, this.size.z, this.size.y * 0.5, 1e-6);
    const step = niceStep(largest / 5);
    let divisions = Math.ceil((largest * 2.4) / step);
    divisions += divisions % 2;
    divisions = clamp(divisions, 4, 80);
    const extent = divisions * step;
    const epsilon = this.radius * 0.001;
    const light = this.backgroundIsLight;

    const gridHelper = new THREE.GridHelper(
      extent,
      divisions,
      light ? 0x8e7f89 : 0x9a7388,
      light ? 0xb8adb4 : 0x4f3446,
    );
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = light ? 0.75 : 0.7;
    gridHelper.material.depthWrite = false;
    gridHelper.position.set(this.center.x, this.groundY - epsilon, this.center.z);
    gridHelper.visible = grid;
    this.helpers.grid = gridHelper;

    const axesHelper = new THREE.AxesHelper(Math.max(this.size.x, this.size.y, this.size.z) * 0.45);
    axesHelper.position.set(this.bounds.min.x, this.groundY, this.bounds.min.z);
    axesHelper.material.depthTest = false;
    axesHelper.renderOrder = 10;
    axesHelper.visible = axes;
    this.helpers.axes = axesHelper;

    const boxHelper = new THREE.Box3Helper(this.bounds, 0xf2ad96);
    boxHelper.visible = bounds;
    this.helpers.bounds = boxHelper;

    if (this.caps.ground) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(extent, extent).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: light ? 0.28 : 0.42 }),
      );
      plane.position.set(this.center.x, this.groundY - epsilon * 0.5, this.center.z);
      plane.receiveShadow = true;
      plane.visible = ground;
      this.helpers.ground = plane;
    }
    for (const object of Object.values(this.helpers)) {
      this.helperGroup.add(object);
    }
  }

  // ---- lighting -------------------------------------------------------------

  ensureEnvironment() {
    if (!this.envTexture && !this.flipY) {
      this.envTexture = createEnvironmentTexture(this.renderer);
    }
  }

  applyLighting(id) {
    this.rig?.dispose();
    this.lightGroup.clear();
    this.rig = createLightRig(id, {
      radius: this.radius,
      center: this.center,
      castShadow: !!this.caps.ground && this.prefs.ground,
    });
    this.keyLight = this.rig.keyLight;
    this.lightGroup.add(this.rig.group);
    if (this.caps.lighting !== false) {
      this.ensureEnvironment();
    }
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = (LIGHT_RIGS[id] || LIGHT_RIGS.studio).environment;
  }

  // ---- preferences --------------------------------------------------------------

  applyPrefs(next, force = false) {
    const previous = this.prefs;
    const prefs = { ...DEFAULT_PREFS, ...next };
    const changed = (key) => force || previous[key] !== prefs[key];
    this.prefs = prefs;
    if (changed('quality')) {
      this.applyPixelRatio();
      this.resize();
    }
    if (changed('background')) {
      this.buildHelpers();
    }
    if (changed('lighting') && !force) {
      this.applyLighting(prefs.lighting);
    }
    if (changed('grid') && this.helpers.grid) {
      this.helpers.grid.visible = prefs.grid;
    }
    if (changed('axes') && this.helpers.axes) {
      this.helpers.axes.visible = prefs.axes;
    }
    if (changed('bounds') && this.helpers.bounds) {
      this.helpers.bounds.visible = prefs.bounds;
    }
    if (changed('ground')) {
      if (this.helpers.ground) {
        this.helpers.ground.visible = prefs.ground;
      }
      if (this.keyLight) {
        this.keyLight.castShadow = !!this.caps.ground && prefs.ground;
      }
    }
    if (changed('wireframe') && this.meshes) {
      for (const mesh of this.meshes) {
        for (const material of materialsOf(mesh)) {
          material.wireframe = !!this.caps.wireframe && prefs.wireframe;
        }
      }
    }
    if ((changed('pointSize') || force) && this.points) {
      for (const point of this.points) {
        for (const material of materialsOf(point)) {
          material.size = (material.userData.baseSize || material.size) * prefs.pointSize;
          material.needsUpdate = true;
        }
      }
    }
    if (changed('autoRotate') || changed('autoRotateSpeed')) {
      this.controls.autoRotate = prefs.autoRotate;
      // OrbitControls: 2 is one revolution per 30 s.
      this.controls.autoRotateSpeed = 2 * prefs.autoRotateSpeed;
      this.lastTime = 0;
    }
    if (changed('splatScale') || changed('splatPoints')) {
      this.adapter?.setSplatScale?.(prefs.splatScale);
      this.adapter?.setPointCloudMode?.(prefs.splatPoints);
    }
    if (changed('playbackSpeed')) {
      this.setSpeed(prefs.playbackSpeed);
    }
    this.invalidate();
  }

  // ---- animation ------------------------------------------------------------------

  setAnimation(root, clips) {
    this.mixerRoot = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = clips;
    this.selectClip(0);
  }

  selectClip(index, { time = 0, playing = this.playing } = {}) {
    if (!this.mixer || !this.clips[index]) {
      return;
    }
    this.action?.stop();
    this.clipIndex = index;
    this.action = this.mixer.clipAction(this.clips[index]);
    this.action.reset().play();
    this.mixer.timeScale = this.speed;
    this.seek(time);
    this.playing = playing;
    this.requestRender();
    this.onPlayback(this.playback());
  }

  setPlaying(playing) {
    if (!this.mixer) {
      return;
    }
    this.playing = playing;
    this.lastTime = 0;
    this.requestRender();
    this.onPlayback(this.playback());
  }

  setSpeed(speed) {
    this.speed = speed;
    if (this.mixer) {
      this.mixer.timeScale = speed;
      this.onPlayback(this.playback());
    }
  }

  seek(time) {
    if (!this.action) {
      return;
    }
    const duration = this.action.getClip().duration;
    this.action.time = clamp(time, 0, duration);
    this.mixer.update(0);
    this.requestRender();
  }

  playback() {
    if (!this.mixer || !this.action) {
      return null;
    }
    return {
      clips: this.clips.map((clip) => ({ name: clip.name || 'Clip', duration: clip.duration })),
      index: this.clipIndex,
      time: this.action.time,
      duration: this.action.getClip().duration,
      playing: this.playing,
      speed: this.speed,
    };
  }

  // ---- snapshot ---------------------------------------------------------------------

  // Renders the current view and returns a PNG. Dark/light backgrounds are composited in;
  // checker and transparent keep the alpha channel.
  snapshot() {
    this.renderNow(true);
    const source = this.renderer.domElement;
    const output = document.createElement('canvas');
    output.width = source.width;
    output.height = source.height;
    const context = output.getContext('2d');
    const fill = SNAPSHOT_BACKGROUNDS[this.prefs.background];
    if (fill) {
      context.fillStyle = fill;
      context.fillRect(0, 0, output.width, output.height);
    }
    context.drawImage(source, 0, 0);
    return new Promise((resolve, reject) => {
      output.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))),
        'image/png',
      );
    });
  }

  // ---- teardown -----------------------------------------------------------------------

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
    this.tween = null;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLostEvent);
    const element = this.renderer.domElement;
    element.removeEventListener('pointerdown', this.onLookPointerDown);
    element.removeEventListener('pointermove', this.onLookPointerMove);
    element.removeEventListener('pointerup', this.onLookPointerUp);
    element.removeEventListener('pointercancel', this.onLookPointerUp);
    element.removeEventListener('wheel', this.onLookWheel);
    this.controls.removeEventListener('change', this.onControlsChange);
    this.controls.removeEventListener('start', this.onControlsStart);
    this.controls.dispose();
    this.mixer?.stopAllAction();
    if (this.mixerRoot) {
      this.mixer?.uncacheRoot(this.mixerRoot);
    }
    this.mixer = null;
    const adapter = this.adapter;
    this.adapter = null;
    for (const dispose of this.disposables) {
      dispose();
    }
    this.disposeHelpers();
    this.rig?.dispose();
    this.lightGroup.clear();
    disposeObject3D(this.world);
    this.world.clear();
    this.scene.environment = null;
    this.envTexture?.dispose();
    // The splat library drains its workers asynchronously and still needs the renderer.
    Promise.resolve(adapter?.dispose?.())
      .catch(() => {})
      .finally(() => this.releaseRenderer());
  }

  releaseRenderer() {
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}

export function createViewerEngine(options) {
  return new ViewerEngine(options);
}
