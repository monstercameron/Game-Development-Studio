import * as THREE from 'three';
import {
  buildSkeletonBody,
  disposeObject3D,
  fetchAssetBytes,
  nextFrame,
  parseModelBytes,
  parseMotionBytes,
  skeletonBounds,
} from './viewer-assets';

// A source loader fetches and parses one asset, then hands it to the engine. Splats use
// viewer-splat.js so the Gaussian library stays out of this chunk.

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export async function loadModelSource(engine, { url, name, signal, onStage, onProgress }) {
  onStage('Downloading model…');
  const bytes = await fetchAssetBytes(url, { signal, name, onProgress });
  throwIfAborted(signal);
  onStage('Reading geometry…');
  onProgress(null);
  // Let the loading state paint before a large synchronous parse.
  await nextFrame();
  const { root, animations, kind } = await parseModelBytes(bytes, name);
  try {
    throwIfAborted(signal);
    const bounds = new THREE.Box3().setFromObject(root);
    engine.setContent({ root, bounds, animations, kind });
  } catch (error) {
    disposeObject3D(root);
    throw error;
  }
  return { kind, byteLength: bytes.byteLength };
}

export async function loadMotionSource(
  engine,
  { url, name, signal, onStage, onProgress, session },
) {
  onStage('Downloading motion…');
  const bytes = await fetchAssetBytes(url, { signal, name, onProgress });
  throwIfAborted(signal);
  onStage('Reading skeleton…');
  onProgress(null);
  await nextFrame();
  const { bones, clip, root } = parseMotionBytes(bytes);
  throwIfAborted(signal);
  const group = new THREE.Group();
  group.add(root);
  // BVH rest poses can be far from the first animated pose, so frame the pose the
  // preview actually starts from.
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.setTime(session?.time || 0);
  const bounds = skeletonBounds(bones, group);
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  const size = bounds.getSize(new THREE.Vector3());
  const body = buildSkeletonBody(bones, group, Math.max(size.x, size.y, size.z));
  try {
    engine.setContent({
      root: group,
      bounds,
      animations: [clip],
      mixerRoot: root,
      kind: 'skeleton',
      updaters: [body.update],
      disposables: [body.dispose],
      attachments: [body.object],
      stats: { bones: bones.length, vertices: 0, triangles: 0 },
    });
  } catch (error) {
    body.dispose();
    throw error;
  }
  return { kind: 'skeleton', byteLength: bytes.byteLength };
}
