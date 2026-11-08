import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

// Gaussian PLY is shown as a colored point cloud; a point preview does not
// reproduce the opacity, orientation, or spherical-harmonic splat renderer.

/**
 * Builds a three.js preview object from PLY bytes.
 *
 * @param {ArrayBuffer} bytes Raw PLY file contents.
 * @returns {THREE.Mesh|THREE.Points} A Mesh when the file has faces, otherwise Points.
 * Throws when PLYLoader rejects the bytes.
 */
export function parsePlyPreview(bytes) {
  const loader = new PLYLoader();
  loader.setCustomPropertyNameMapping({ sh: ['f_dc_0', 'f_dc_1', 'f_dc_2'] });
  const geometry = loader.parse(bytes);
  const sh = geometry.getAttribute('sh');
  if (!geometry.getAttribute('color') && sh) {
    const colors = new Float32Array(sh.count * 3);
    for (let i = 0; i < colors.length; i++) {
      // 1 / (2 * sqrt(pi)) is the degree-0 spherical-harmonic basis; it maps the
      // f_dc_* coefficient to a color offset around mid-gray (0.5).
      colors[i] = Math.max(0, Math.min(1, 0.5 + 0.28209479177387814 * sh.array[i]));
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const vertexColors = !!geometry.getAttribute('color');
  if (geometry.index) {
    if (!geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
    }
    return new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: vertexColors ? 0xffffff : 0xe8c2b3,
        vertexColors,
        side: THREE.DoubleSide,
        roughness: 0.85,
      }),
    );
  }
  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new THREE.Vector3());
  const extent = size ? Math.max(size.x, size.y, size.z) : 1;
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size: Math.max(extent / 500, 0.0001),
      vertexColors,
      color: vertexColors ? 0xffffff : 0xe8c2b3,
      sizeAttenuation: true,
    }),
  );
}
