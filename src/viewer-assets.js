import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { BVHLoader } from 'three/addons/loaders/BVHLoader.js';
import { parsePlyPreview } from './ply-preview';
import { ViewerError, byteLimitFor, fileExtension } from './viewer-core';
import { SHELL_SAMPLE_LIMIT, detectPanoramaShell } from './viewer-panorama';

// Loading, statistics and disposal helpers shared by the interactive viewer and the
// static thumbnail renderer.

// A short macrotask lets React paint the loading state before a large synchronous parse.
// requestAnimationFrame is avoided because it never fires in a background tab.
export const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

// Downloads a file, reporting progress when the server announces its length.
export async function fetchAssetBytes(url, { signal, max, name, onProgress } = {}) {
  const limit = max || byteLimitFor(name);
  let response;
  try {
    response = await fetch(url, { signal, redirect: 'error' });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error;
    }
    throw new ViewerError('NETWORK', 'The file could not be downloaded.');
  }
  if (!response.ok) {
    throw new ViewerError(
      'HTTP',
      response.status === 404
        ? 'This file no longer exists in the project.'
        : `The studio answered with status ${response.status}.`,
    );
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > limit) {
    throw new ViewerError('TOO_LARGE', 'File too large.', { bytes: total, limit });
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > limit) {
      throw new ViewerError('TOO_LARGE', 'File too large.', { bytes: bytes.byteLength, limit });
    }
    onProgress?.(1);
    return bytes;
  }
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new ViewerError('TOO_LARGE', 'File too large.', { bytes: received, limit });
    }
    chunks.push(value);
    if (total) {
      onProgress?.(received / total);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.(1);
  return bytes.buffer;
}

export function selfContainedManager() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((value) => {
    if (value.startsWith('blob:') || value.startsWith('data:')) {
      return value;
    }
    throw new ViewerError('EXTERNAL_RESOURCES', 'External model resources are not supported.');
  });
  return manager;
}

// Returns the scene root plus any animation clips shipped inside the file.
export async function parseModelBytes(bytes, name) {
  const extension = fileExtension(name);
  if (extension === 'ply') {
    const root = parsePlyPreview(bytes);
    return { root, animations: [], kind: root.isPoints ? 'points' : 'mesh' };
  }
  if (extension === 'obj') {
    // Geometry only: the viewer does not read the sibling .mtl or its textures.
    const root = new OBJLoader().parse(new TextDecoder().decode(bytes));
    return { root, animations: [], kind: 'mesh' };
  }
  if (extension === 'stl') {
    const geometry = new STLLoader().parse(bytes);
    if (!geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
    }
    const material = new THREE.MeshStandardMaterial({ color: 0xc8c8d0, roughness: 0.7 });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material));
    return { root, animations: [], kind: 'mesh' };
  }
  if (extension === 'fbx') {
    const root = new FBXLoader(selfContainedManager()).parse(bytes, '');
    return { root, animations: root.animations || [], kind: 'mesh' };
  }
  if (extension === 'glb' || extension === 'gltf') {
    const gltf = await new GLTFLoader(selfContainedManager()).parseAsync(bytes, '');
    return { root: gltf.scene, animations: gltf.animations || [], kind: 'mesh' };
  }
  throw new ViewerError('UNSUPPORTED', `.${extension || 'this'} files cannot be previewed here.`);
}

export function parseMotionBytes(bytes) {
  const motion = new BVHLoader().parse(new TextDecoder().decode(bytes));
  const root = motion.skeleton?.bones?.[0];
  if (!root || !motion.clip) {
    throw new ViewerError('EMPTY', 'This motion file has no playable skeleton.');
  }
  return { bones: motion.skeleton.bones, clip: motion.clip, root };
}

// Corners of the sampled triangles in world space, nine numbers per triangle. Sampling keeps
// the panorama shape check cheap on multi-million triangle meshes.
export function collectWorldTriangles(root, maxTriangles = SHELL_SAMPLE_LIMIT) {
  const meshes = [];
  let total = 0;
  root.traverse((object) => {
    const position = object.geometry?.getAttribute?.('position');
    if (object.isMesh && position) {
      meshes.push(object);
      total += Math.floor((object.geometry.index?.count ?? position.count) / 3);
    }
  });
  const stride = Math.max(1, Math.ceil(total / maxTriangles));
  const values = [];
  const corner = new THREE.Vector3();
  for (const mesh of meshes) {
    const { geometry, matrixWorld } = mesh;
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const count = Math.floor((index?.count ?? position.count) / 3);
    for (let triangle = 0; triangle < count; triangle += stride) {
      for (let vertex = 0; vertex < 3; vertex++) {
        const slot = triangle * 3 + vertex;
        corner
          .fromBufferAttribute(position, index ? index.getX(slot) : slot)
          .applyMatrix4(matrixWorld);
        values.push(corner.x, corner.y, corner.z);
      }
    }
  }
  return values;
}

// Shape-based fallback for a mesh whose stored details do not identify it as a panorama.
export function isPanoramaShellMesh(root) {
  root.updateMatrixWorld(true);
  return detectPanoramaShell(collectWorldTriangles(root)).isShell;
}

// Cheap one-pass statistics: counts come straight from buffer attributes.
export function computeSceneStats(root) {
  const stats = { vertices: 0, triangles: 0, points: 0, meshes: 0, materials: 0, textures: 0 };
  const materials = new Set(),
    textures = new Set();
  root?.traverse((object) => {
    const position = object.geometry?.getAttribute?.('position');
    if (position && (object.isMesh || object.isSkinnedMesh)) {
      const instances = object.isInstancedMesh ? object.count : 1;
      stats.meshes += 1;
      stats.vertices += position.count * instances;
      stats.triangles +=
        Math.floor((object.geometry.index?.count ?? position.count) / 3) * instances;
    } else if (position && object.isPoints) {
      stats.points += position.count;
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material && !materials.has(material)) {
        materials.add(material);
        for (const value of Object.values(material)) {
          if (value?.isTexture) {
            textures.add(value);
          }
        }
      }
    }
  });
  stats.materials = materials.size;
  stats.textures = textures.size;
  return stats;
}

export function disposeObject3D(root) {
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
    object.dispose?.();
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

// BVH skeletons are drawn with instanced joints and bone segments because WebGL line
// widths are usually fixed to one pixel, which is unreadable at any size.
export function buildSkeletonBody(bones, group, largest) {
  const members = new Set(bones),
    links = bones.filter((bone) => members.has(bone.parent));
  const jointGeometry = new THREE.SphereGeometry(1, 10, 8),
    boneGeometry = new THREE.CylinderGeometry(1, 1, 1, 8);
  const jointMaterial = new THREE.MeshBasicMaterial({ color: '#ffe0cc' }),
    boneMaterial = new THREE.MeshBasicMaterial({ color: '#f2ad96' });
  const joints = new THREE.InstancedMesh(jointGeometry, jointMaterial, bones.length),
    segments = new THREE.InstancedMesh(boneGeometry, boneMaterial, Math.max(links.length, 1));
  joints.frustumCulled = false;
  segments.frustumCulled = false;
  segments.count = links.length;
  const matrix = new THREE.Matrix4(),
    position = new THREE.Vector3(),
    end = new THREE.Vector3(),
    axis = new THREE.Vector3(),
    midpoint = new THREE.Vector3(),
    scale = new THREE.Vector3(),
    orientation = new THREE.Quaternion(),
    identity = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0);
  return {
    object: new THREE.Group().add(joints, segments),
    update() {
      group.updateMatrixWorld(true);
      bones.forEach((bone, index) => {
        bone.getWorldPosition(position);
        matrix.compose(position, identity, scale.setScalar(largest * 0.012));
        joints.setMatrixAt(index, matrix);
      });
      links.forEach((bone, index) => {
        bone.parent.getWorldPosition(position);
        bone.getWorldPosition(end);
        axis.subVectors(end, position);
        const span = axis.length();
        midpoint.addVectors(position, end).multiplyScalar(0.5);
        orientation.setFromUnitVectors(up, span > 1e-8 ? axis.multiplyScalar(1 / span) : up);
        matrix.compose(midpoint, orientation, scale.set(largest * 0.005, span, largest * 0.005));
        segments.setMatrixAt(index, matrix);
      });
      joints.instanceMatrix.needsUpdate = true;
      segments.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      jointGeometry.dispose();
      boneGeometry.dispose();
      jointMaterial.dispose();
      boneMaterial.dispose();
      joints.dispose();
      segments.dispose();
    },
  };
}

// Bounding box of every bone in its current pose.
export function skeletonBounds(bones, group) {
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const bone of bones) {
    bounds.expandByPoint(bone.getWorldPosition(new THREE.Vector3()));
  }
  return bounds;
}
