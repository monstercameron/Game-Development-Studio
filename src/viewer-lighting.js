import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Lighting rigs shared by the interactive viewer and the static thumbnail renderer so a
// tile looks like the model does when it is opened.
export const LIGHT_RIGS = {
  studio: {
    environment: 0.35,
    lights: [
      { type: 'hemisphere', sky: 0xf2e9ff, ground: 0x4c3344, intensity: 0.7 },
      { type: 'directional', color: 0xffffff, intensity: 1.6, at: [0.55, 1, 0.75], key: true },
      { type: 'directional', color: 0xffba9d, intensity: 0.55, at: [-0.8, 0.3, -0.5] },
      { type: 'directional', color: 0xcdb8ff, intensity: 0.7, at: [-0.2, 0.5, -1] },
    ],
  },
  neutral: {
    environment: 0.7,
    lights: [
      { type: 'hemisphere', sky: 0xffffff, ground: 0x8a8a8a, intensity: 0.6 },
      { type: 'directional', color: 0xffffff, intensity: 1, at: [0.5, 1, 0.8], key: true },
      { type: 'directional', color: 0xffffff, intensity: 0.45, at: [-0.7, 0.4, 0.6] },
    ],
  },
  dark: {
    environment: 0.05,
    lights: [
      { type: 'hemisphere', sky: 0x6b5a8a, ground: 0x120a14, intensity: 0.18 },
      { type: 'directional', color: 0xffd9c4, intensity: 1.9, at: [-0.9, 0.5, -0.7], key: true },
      { type: 'directional', color: 0x7a8cff, intensity: 0.35, at: [0.8, 0.2, 0.6] },
    ],
  },
};

export function createLightRig(
  id,
  { radius = 1, center = new THREE.Vector3(), castShadow = false } = {},
) {
  const rig = LIGHT_RIGS[id] || LIGHT_RIGS.studio;
  const group = new THREE.Group();
  const scale = Math.max(radius, 0.001);
  let keyLight = null;
  for (const spec of rig.lights) {
    if (spec.type === 'hemisphere') {
      group.add(new THREE.HemisphereLight(spec.sky, spec.ground, spec.intensity));
      continue;
    }
    const light = new THREE.DirectionalLight(spec.color, spec.intensity);
    light.position
      .set(...spec.at)
      .normalize()
      .multiplyScalar(scale * 3)
      .add(center);
    light.target.position.copy(center);
    group.add(light, light.target);
    if (spec.key) {
      keyLight = light;
      light.shadow.mapSize.set(2048, 2048);
      Object.assign(light.shadow.camera, {
        left: -scale * 1.6,
        right: scale * 1.6,
        top: scale * 1.6,
        bottom: -scale * 1.6,
        near: scale * 0.2,
        far: scale * 7,
      });
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = scale * 0.004;
      light.shadow.radius = 3;
      light.castShadow = castShadow;
    }
  }
  return {
    group,
    keyLight,
    environment: rig.environment,
    dispose() {
      group.traverse((child) => {
        child.shadow?.dispose();
        child.dispose?.();
      });
      group.clear();
    },
  };
}

// Image-based lighting makes glTF PBR materials read correctly under every preset.
export function createEnvironmentTexture(renderer) {
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const texture = generator.fromScene(room, 0.04).texture;
  generator.dispose();
  room.dispose?.();
  return texture;
}
