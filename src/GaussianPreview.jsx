import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import './model-preview.css';

export default function GaussianPreview({ url, name, onFallback }) {
  const host = useRef(null),
    viewerRef = useRef(null);
  const [status, setStatus] = useState('loading');
  useEffect(() => {
    let active = true,
      viewer,
      renderer,
      observer;
    const element = host.current;
    async function setup() {
      try {
        renderer = new THREE.WebGLRenderer({
          antialias: false,
          alpha: true,
          powerPreference: 'high-performance',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setClearColor(0x000000, 0);
        element.appendChild(renderer.domElement);
        const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
        camera.up.set(0, -1, 0);
        camera.position.set(0, 0, -0.3);
        camera.lookAt(0, 0, 1);
        viewer = new GaussianSplats3D.Viewer({
          rootElement: element,
          renderer,
          camera,
          sharedMemoryForWorkers: false,
          gpuAcceleratedSort: false,
          sphericalHarmonicsDegree: 0,
          logLevel: GaussianSplats3D.LogLevel.None,
        });
        viewerRef.current = viewer;
        const resize = () => {
          const w = element.clientWidth,
            h = element.clientHeight;
          if (!w || !h) {
            return;
          }
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          viewer.forceRenderNextFrame();
        };
        observer = new ResizeObserver(resize);
        observer.observe(element);
        resize();
        await viewer.addSplatScene(url, {
          format: GaussianSplats3D.SceneFormat.Ply,
          showLoadingUI: false,
          progressiveLoad: false,
          splatAlphaRemovalThreshold: 5,
        });
        if (!active) {
          return;
        }
        viewer.controls.target.set(0, 0, 1);
        viewer.controls.update();
        viewer.start();
        setStatus('ready');
      } catch (error) {
        if (active) {
          console.error('Gaussian preview failed:', error);
          setStatus('unavailable');
        }
      }
    }
    setup();
    return () => {
      active = false;
      observer?.disconnect();
      viewerRef.current = null;
      Promise.resolve(viewer?.dispose())
        .catch(() => {})
        .finally(() => {
          renderer?.dispose();
          renderer?.forceContextLoss();
          renderer?.domElement.remove();
        });
    };
  }, [url]);
  return (
    <div className="model-preview">
      <div
        ref={host}
        className="model-preview-canvas"
        role="img"
        aria-label={`Gaussian splat preview of ${name}. Drag to look around and scroll to zoom.`}
      />
      {status !== 'ready' && (
        <div className="model-preview-overlay" role="status">
          {status === 'loading' ? (
            'Loading Gaussian scene…'
          ) : (
            <>
              Gaussian preview unavailable.{' '}
              <button type="button" className="outline-button" onClick={onFallback}>
                Show point preview
              </button>
            </>
          )}
        </div>
      )}
      {status === 'ready' && (
        <div className="model-preview-hint">
          Gaussian scene · drag to look around · scroll to zoom
        </div>
      )}
    </div>
  );
}
