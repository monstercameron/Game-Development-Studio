import * as THREE from 'three';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import {
  buildSkeletonBody,
  computeSceneStats,
  disposeObject3D,
  fetchAssetBytes,
  parseModelBytes,
  parseMotionBytes,
  skeletonBounds,
} from './viewer-assets';
import { createEnvironmentTexture, createLightRig } from './viewer-lighting';
import { fileExtension, fitDistance, viewDirection } from './viewer-core';

const side = 320;
function canvas() {
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  return c;
}
function fit(c, source, width, height) {
  if (!width || !height) {
    throw Error('No visual frame.');
  }
  const scale = Math.min(side / width, side / height),
    w = width * scale,
    h = height * scale;
  c.getContext('2d').drawImage(source, (side - w) / 2, (side - h) / 2, w, h);
}
async function fetchBytes(url, max = 64 * 1024 * 1024) {
  const r = await fetch(url);
  if (!r.ok) {
    throw Error('Cannot read asset.');
  }
  if (Number(r.headers.get('content-length')) > max) {
    throw Error('Asset is too large to preview.');
  }
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > max) {
    throw Error('Asset is too large to preview.');
  }
  return bytes;
}
async function imageThumbnail(url, name) {
  const c = canvas();
  if (/\.tga$/i.test(name)) {
    const { data, width, height } = new TGALoader().parse(await fetchBytes(url));
    const raw = document.createElement('canvas');
    raw.width = width;
    raw.height = height;
    raw
      .getContext('2d')
      .putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    fit(c, raw, width, height);
  } else {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    fit(c, image, image.naturalWidth, image.naturalHeight);
  }
  return c.toDataURL('image/png');
}
async function videoThumbnail(url) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Video preview timed out.')), 15000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(Error('Cannot decode video.'));
      };
      video.src = url;
      video.load();
    });
    const c = canvas();
    fit(c, video, video.videoWidth, video.videoHeight);
    return c.toDataURL('image/png');
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
// Heavier meshes skip the ground shadow so one tile can never stall the queue.
const SHADOW_TRIANGLE_LIMIT = 1_000_000;
// Rendered at twice the tile size and scaled down for smoother edges.
const SUPERSAMPLE = 2;

async function modelThumbnail(url, name) {
  const bytes = await fetchAssetBytes(url, { name }),
    extension = fileExtension(name),
    scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  let renderer, content, body, rig, environment, shadowPlane;
  try {
    const bounds = new THREE.Box3();
    let kind = 'mesh';
    if (extension === 'bvh') {
      const motion = parseMotionBytes(bytes);
      content = new THREE.Group();
      content.add(motion.root);
      scene.add(content);
      const mixer = new THREE.AnimationMixer(motion.root);
      mixer.clipAction(motion.clip).play();
      mixer.update(0);
      bounds.copy(skeletonBounds(motion.bones, content));
      const extent = bounds.getSize(new THREE.Vector3());
      body = buildSkeletonBody(motion.bones, content, Math.max(extent.x, extent.y, extent.z));
      scene.add(body.object);
      kind = 'skeleton';
    } else {
      const parsed = await parseModelBytes(bytes, name);
      content = parsed.root;
      kind = parsed.kind;
      scene.add(content);
      bounds.setFromObject(content);
    }
    if (bounds.isEmpty()) {
      throw Error('No visible geometry.');
    }
    const center = bounds.getCenter(new THREE.Vector3()),
      size = bounds.getSize(new THREE.Vector3()),
      largest = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(largest) || largest <= 0) {
      throw Error('Invalid model dimensions.');
    }
    content.position.sub(center);
    content.updateMatrixWorld(true);
    body?.update();
    const radius = size.length() / 2,
      distance = fitDistance(size.toArray(), camera.fov, 1, 0.9),
      direction = viewDirection('iso');
    camera.position.set(direction[0] * distance, direction[1] * distance, direction[2] * distance);
    camera.near = Math.max(radius * 0.002, 1e-4);
    camera.far = radius * 80;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    const triangles = kind === 'mesh' ? computeSceneStats(content).triangles : 0;
    const shadows = kind === 'mesh' && triangles > 0 && triangles <= SHADOW_TRIANGLE_LIMIT;
    rig = createLightRig('studio', { radius, castShadow: shadows });
    scene.add(rig.group);

    const pixels = side * SUPERSAMPLE;
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(pixels, pixels, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    if (kind === 'mesh') {
      environment = createEnvironmentTexture(renderer);
      scene.environment = environment;
      scene.environmentIntensity = rig.environment;
    }
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      content.traverse((object) => {
        object.castShadow = !!object.isMesh;
      });
      shadowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(radius * 8, radius * 8).rotateX(-Math.PI / 2),
        new THREE.ShadowMaterial({ opacity: 0.4 }),
      );
      shadowPlane.position.y = -size.y / 2 - radius * 0.001;
      shadowPlane.receiveShadow = true;
      scene.add(shadowPlane);
    }
    renderer.render(scene, camera);
    const out = canvas();
    const context = out.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(renderer.domElement, 0, 0, side, side);
    return out.toDataURL('image/png');
  } finally {
    rig?.dispose();
    environment?.dispose();
    body?.dispose();
    if (shadowPlane) {
      shadowPlane.geometry.dispose();
      shadowPlane.material.dispose();
    }
    disposeObject3D(content);
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}
export async function renderThumbnail(asset) {
  const url = asset.url || asset.file,
    name = asset.name || asset.title || asset.id;
  if (['Images', 'Masks'].includes(asset.category)) {
    return imageThumbnail(url, name);
  }
  if (asset.category === 'Video') {
    return videoThumbnail(url);
  }
  if (asset.category === '3D') {
    return modelThumbnail(url, name);
  }
  throw Error('Not a visual asset.');
}
