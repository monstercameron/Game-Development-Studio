import { useEffect, useId, useRef, useState } from 'react';
import { Box, RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { parsePlyPreview } from './ply-preview';
import './model-preview.css';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PLY_BYTES = 256 * 1024 * 1024;

function disposeScene(root) {
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set();
  root?.traverse((object) => {
    if (object.geometry) {
      geometries.add(object.geometry);
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) {
        continue;
      }
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) {
          textures.add(value);
        }
      }
    }
  });
  for (const texture of textures) {
    texture.source?.data?.close?.();
    texture.dispose();
  }
  for (const material of materials) {
    material.dispose();
  }
  for (const geometry of geometries) {
    geometry.dispose();
  }
}

export default function ModelPreview({ url, name }) {
  const host = useRef(null),
    controlsRef = useRef(null),
    cameraRef = useRef(null),
    renderRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const hintId = useId();
  const supported = /\.(glb|gltf|fbx|ply)$/i.test(name || '');
  useEffect(() => {
    if (!supported || !host.current) {
      return;
    }
    let active = true,
      renderer,
      controls,
      observer,
      scene,
      root,
      frame = 0;
    const controller = new AbortController(),
      element = host.current;
    setStatus('loading');
    function draw() {
      if (!active || frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (active && renderer && scene) {
          renderer.render(scene, cameraRef.current);
        }
      });
    }
    function resize() {
      if (!renderer || !cameraRef.current) {
        return;
      }
      const width = element.clientWidth,
        height = element.clientHeight;
      if (!width || !height) {
        return;
      }
      renderer.setSize(width, height, false);
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      draw();
    }
    async function setup() {
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: true,
          powerPreference: 'low-power',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        element.appendChild(renderer.domElement);
        scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
        cameraRef.current = camera;
        scene.add(new THREE.HemisphereLight(0xf2e9ff, 0x4c3344, 0.85));
        const key = new THREE.DirectionalLight(0xffffff, 1.3);
        key.position.set(4, 6, 5);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffba9d, 0.55);
        fill.position.set(-4, 2, -3);
        scene.add(fill);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.enablePan = false;
        controls.enableDamping = false;
        controls.addEventListener('change', draw);
        controlsRef.current = controls;
        renderRef.current = draw;
        observer = new ResizeObserver(resize);
        observer.observe(element);
        resize();
        const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          throw Error('Could not read the 3D file.');
        }
        const maxBytes = /\.ply$/i.test(name) ? MAX_PLY_BYTES : MAX_BYTES;
        const length = Number(response.headers.get('content-length'));
        if (length > maxBytes) {
          throw Error('This file is too large to preview here.');
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) {
          throw Error('This file is too large to preview here.');
        }
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((value) => {
          if (value.startsWith('blob:') || value.startsWith('data:')) {
            return value;
          }
          throw Error('External model resources are not supported.');
        });
        const loaded = /\.ply$/i.test(name)
          ? parsePlyPreview(bytes)
          : /\.fbx$/i.test(name)
            ? new FBXLoader(manager).parse(bytes, '')
            : (await new GLTFLoader(manager).parseAsync(bytes, '')).scene;
        if (!active) {
          disposeScene(loaded);
          return;
        }
        root = loaded;
        const bounds = new THREE.Box3().setFromObject(root);
        if (bounds.isEmpty()) {
          throw Error('This 3D file has no visible geometry.');
        }
        const center = bounds.getCenter(new THREE.Vector3()),
          size = bounds.getSize(new THREE.Vector3()),
          largest = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(largest) || largest <= 0) {
          throw Error('This 3D file has invalid dimensions.');
        }
        root.position.sub(center);
        scene.add(root);
        const distance =
          (largest / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) * 1.55;
        camera.position.set(distance * 0.75, distance * 0.45, distance);
        camera.near = Math.max(largest / 1000, 0.001);
        camera.far = largest * 100;
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.minDistance = largest * 0.25;
        controls.maxDistance = largest * 12;
        controls.update();
        controls.saveState();
        setStatus('ready');
        draw();
      } catch (error) {
        if (active && error.name !== 'AbortError') {
          setStatus(error.message || 'Could not preview this 3D file.');
        }
      }
    }
    setup();
    return () => {
      active = false;
      controller.abort();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      controls?.dispose();
      disposeScene(root);
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      controlsRef.current = null;
      cameraRef.current = null;
      renderRef.current = null;
    };
  }, [url, name, supported]);
  function rotate(direction) {
    const camera = cameraRef.current,
      controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), (direction * Math.PI) / 8);
    camera.position.copy(controls.target).add(offset);
    controls.update();
    renderRef.current?.();
  }
  function zoom(factor) {
    const camera = cameraRef.current,
      controls = controlsRef.current;
    if (!camera || !controls) {
      return;
    }
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      controls.minDistance,
      controls.maxDistance,
    );
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
    renderRef.current?.();
  }
  if (!supported) {
    return (
      <div className="model-preview-message">
        <Box size={26} />
        <strong>Preview unavailable</strong>
        <span>
          GLB, self-contained glTF, FBX and PLY files can be previewed here. Download this file to
          open it in a 3D editor.
        </span>
      </div>
    );
  }
  return (
    <div className="model-preview">
      <div
        ref={host}
        className="model-preview-canvas"
        role="img"
        aria-label={`3D preview of ${name}`}
        aria-describedby={hintId}
      />
      {status !== 'ready' && (
        <div className="model-preview-overlay" role={status === 'loading' ? 'status' : 'alert'}>
          {status === 'loading' ? 'Loading 3D preview…' : status}
        </div>
      )}
      {status === 'ready' && (
        <>
          <div id={hintId} className="model-preview-hint">
            {/\.ply$/i.test(name) ? 'PLY point preview. ' : ''}
            Drag to rotate; scroll or pinch to zoom. Use the controls for keyboard operation.
          </div>
          <div className="model-preview-tools" role="group" aria-label="3D preview controls">
            <button
              type="button"
              aria-label="Rotate left"
              title="Rotate left"
              onClick={() => rotate(1)}
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button"
              aria-label="Rotate right"
              title="Rotate right"
              onClick={() => rotate(-1)}
            >
              <RotateCw size={16} />
            </button>
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.8)}>
              <ZoomIn size={16} />
            </button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1.25)}>
              <ZoomOut size={16} />
            </button>
            <button
              type="button"
              aria-label="Reset 3D preview"
              title="Reset 3D preview"
              onClick={() => controlsRef.current?.reset()}
            >
              Reset view
            </button>
          </div>
        </>
      )}
    </div>
  );
}
