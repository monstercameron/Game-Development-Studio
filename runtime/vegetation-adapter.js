// The only module that knows SeedThree's API (src/api/seedthree.js, documented in its
// src/api/README.md): species list, schema, generate(), statsOf(), toPreset(), exportGLB().
// Everything else in Forge talks to the Forge-shaped schema and results produced here, so a
// SeedThree upgrade should only ever need changes in this file (and a new pin in
// install-models.json). It runs in the isolated child process (vegetation-child.js), never in the
// studio host, because importing three.js and growing a plant are not work for the host.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  VEGETATION_BUDGETS,
  controlMap,
  normalizeVegetationRequest,
} from './vegetation-request.js';

// Bump when the shape of buildSchema()'s output changes, so cached schemas are rebuilt.
export const SCHEMA_VERSION = 2;
const MIB = 1024 * 1024;
/** Hard limits that protect the machine: the largest plant Forge will export. */
export const VEGETATION_LIMITS = Object.freeze({
  maxTriangles: 1_500_000,
  maxGlbBytes: 96 * MIB,
  seedMin: 1,
  seedMax: 9999,
});

export const BUDGET_LABELS = Object.freeze({
  low: { label: 'Low', detail: 'Fewest triangles of the three levels of detail' },
  medium: { label: 'Medium', detail: 'The middle level of detail' },
  high: { label: 'High', detail: 'Most triangles: full detail' },
});

// Controls of SeedThree's "global" and "material" groups that change the exported geometry.
// Bark and leaf tints, alpha test, bark damage and tiling only affect SeedThree's live textured
// materials; the headless GLB uses plain replacement materials, so exposing them would offer
// sliders that do nothing.
const GEOMETRY_GLOBAL_KEYS = ['showLeaves', 'leafAngle', 'leafStart', 'leafSizeVar', 'leafQuads'];
// Verified by hand: these have no effect on the spray-cluster shrubs.
const NO_EFFECT_ON_SPRAY_CLUSTERS = new Set(['leafSizeVar', 'leafQuads']);

/** Imports SeedThree's headless API from a checkout. */
export async function loadSeedThree(directory) {
  const entry = path.join(directory, 'src', 'api', 'seedthree.js');
  const api = await import(pathToFileURL(entry).href);
  for (const name of ['listSpecies', 'getSchema', 'generate', 'toPreset', 'exportGLB']) {
    if (typeof api[name] !== 'function') {
      throw Error(`SeedThree no longer exports ${name}(). The adapter needs an update.`);
    }
  }
  return api;
}

export function readSeedThreeVersion(directory) {
  try {
    return String(
      JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version,
    );
  } catch {
    return 'unknown';
  }
}

function controlFrom(entry, group) {
  const id = entry.key ?? entry.path;
  const base = { id, name: String(entry.name), group, default: entry.default };
  if (entry.type === 'color') {
    return null;
  }
  if (entry.type === 'bool') {
    return { ...base, type: 'boolean' };
  }
  if (entry.options) {
    return {
      ...base,
      type: 'choice',
      options: Object.entries(entry.options).map(([label, value]) => ({ label, value })),
    };
  }
  const isInteger = [entry.min, entry.max, entry.step, entry.default].every(Number.isInteger);
  return {
    ...base,
    type: isInteger ? 'integer' : 'number',
    min: entry.min,
    max: entry.max,
    step: entry.step,
  };
}

/** Forge's schema, built from SeedThree's getSchema() for every species. */
export function buildSchema(api, { version = 'unknown', commit = null } = {}) {
  const species = api.listSpecies().map((descriptor) => {
    const source = api.getSchema(descriptor.key);
    const isSprayCluster = source.foliageType === 'sprayClusters';
    const controls = [
      ...source.shape.map((entry) => controlFrom(entry, 'shape')),
      ...source.global
        .filter((entry) => GEOMETRY_GLOBAL_KEYS.includes(entry.key))
        .filter((entry) => !(isSprayCluster && NO_EFFECT_ON_SPRAY_CLUSTERS.has(entry.key)))
        .map((entry) => controlFrom(entry, 'leaves')),
      ...source.advanced.map((entry) => controlFrom(entry, 'advanced')),
    ].filter(Boolean);
    return {
      key: descriptor.key,
      name: String(descriptor.name),
      latin: descriptor.latin || null,
      biome: descriptor.biome || null,
      generator: descriptor.generator,
      isCactus: descriptor.cactus === true,
      controls,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    seedthree: { version, commit },
    limits: { ...VEGETATION_LIMITS },
    seed: { min: VEGETATION_LIMITS.seedMin, max: VEGETATION_LIMITS.seedMax, default: 1 },
    budgets: VEGETATION_BUDGETS.map((id) => ({ id, ...BUDGET_LABELS[id] })),
    species,
  };
}

// SeedThree's keys for the per-level Weber-Penn dials are paths such as
// "paramOverrides.downAngle.1"; everything else is a flat key in `controls`.
function toControls(params) {
  const controls = {};
  for (const [id, value] of Object.entries(params)) {
    if (id.startsWith('paramOverrides.')) {
      const [, name, level] = id.split('.');
      controls.paramOverrides ||= {};
      controls.paramOverrides[name] ||= {};
      controls.paramOverrides[name][level] = value;
    } else {
      controls[id] = value;
    }
  }
  return controls;
}

/**
 * SeedThree's exportGLB() picks one of two flat colours per mesh from the mesh NAME (names with
 * "bark", "branch" or "trunk" get brown; instanced meshes named "leaf", "card", "frond",
 * "rosette", "spine" or "cluster" get green). At the pinned commit the wood meshes are unnamed
 * and the foliage meshes are called "foliage", "coneN" or "willow-curtains", so every mesh falls
 * through to the opposite colour: green wood and brown leaves. The two kinds are told apart by
 * their material (subsurface "SSS" materials are foliage and spines), and renamed so the exporter
 * picks the intended colour. Cacti keep a green body and get brown spines.
 */
export function nameMeshesForExport(object, { isCactus = false } = {}) {
  if (typeof object?.traverse !== 'function') {
    return;
  }
  object.traverse((mesh) => {
    if (!mesh.isMesh) {
      return;
    }
    const kind = String(mesh.material?.constructor?.name || '');
    const isFoliage = /SSS/i.test(kind);
    if (isCactus) {
      mesh.name = isFoliage ? 'bark_needles' : 'cactus_body';
    } else {
      mesh.name = isFoliage ? 'leaf_cards' : 'bark_wood';
    }
  });
}

/** Orders the built levels of detail by triangle count: [fewest, ..., most]. */
export function levelsByTriangles(stats) {
  return stats.perLod
    .map((level, index) => ({ index, triangles: level.triangles }))
    .sort((a, b) => a.triangles - b.triangles || b.index - a.index);
}

/** Which built level a budget exports: low = fewest triangles, high = most, medium = between. */
export function pickLevel(stats, budget) {
  const ranked = levelsByTriangles(stats);
  const position = { low: 0, medium: Math.floor((ranked.length - 1) / 2), high: ranked.length - 1 }[
    budget
  ];
  return ranked[position].index;
}

/**
 * Triangle counts of every species' default design (seed 1) at each budget. Shown on the page as
 * "what you get" for a budget; measured, not estimated, and cached per SeedThree commit.
 */
export function measureBudgets(api, schema) {
  const measured = {};
  for (const species of schema.species) {
    const grown = api.generate({ species: species.key, seed: 1 });
    const stats = grown.stats ?? api.statsOf(grown.group);
    measured[species.key] = Object.fromEntries(
      VEGETATION_BUDGETS.map((budget) => [
        budget,
        stats.perLod[pickLevel(stats, budget)].triangles,
      ]),
    );
  }
  return measured;
}

/**
 * Grows one plant and exports it. Throws with a plain message when the plant is too heavy.
 *
 * @param {object} api SeedThree's headless API (or a test double)
 * @param {object} schema the Forge schema from buildSchema()
 * @param {object} request a vegetation request (re-validated here, in the child)
 * @returns {Promise<{glb: Buffer, preset: object, result: object}>}
 */
export async function generateVegetation(api, schema, request) {
  const normalized = normalizeVegetationRequest(request, schema);
  const speciesEntry = schema.species.find((item) => item.key === normalized.species);
  const known = controlMap(speciesEntry);
  const controls = toControls(
    Object.fromEntries(Object.entries(normalized.params).filter(([id]) => known.has(id))),
  );
  const startedAt = performance.now();
  const grown = api.generate({ species: normalized.species, seed: normalized.seed, controls });
  const grownAt = performance.now();
  const stats = grown.stats ?? api.statsOf(grown.group);
  const levelIndex = pickLevel(stats, normalized.budget);
  const level = stats.perLod[levelIndex];
  if (level.triangles > schema.limits.maxTriangles) {
    throw Error(
      `This design has ${level.triangles.toLocaleString('en-US')} triangles at ${normalized.budget} ` +
        `detail; the limit is ${schema.limits.maxTriangles.toLocaleString('en-US')}. ` +
        'Lower the branch density, levels or leaf counts, or choose a lower triangle budget.',
    );
  }
  const object = grown.group.levels ? grown.group.levels[levelIndex].object : grown.group;
  nameMeshesForExport(object, { isCactus: speciesEntry.isCactus === true });
  const arrayBuffer = await api.exportGLB(object);
  const exportedAt = performance.now();
  const glb = Buffer.from(arrayBuffer);
  if (glb.byteLength > schema.limits.maxGlbBytes) {
    throw Error(
      `The exported model is ${(glb.byteLength / MIB).toFixed(1)} MiB; the limit is ` +
        `${schema.limits.maxGlbBytes / MIB} MiB. Lower the detail of this design.`,
    );
  }
  const preset =
    grown.preset ?? api.toPreset({ species: normalized.species, seed: normalized.seed, controls });
  const summary = stats.summary || {};
  const result = {
    species: normalized.species,
    speciesName: speciesEntry.name,
    seed: normalized.seed,
    budget: normalized.budget,
    lodName: level.name,
    triangles: level.triangles,
    vertices: level.verts,
    meshes: level.meshes,
    instances: level.instances,
    levelTriangles: stats.perLod.map((item) => item.triangles),
    widthMeters: summary.widthMeters ?? null,
    heightMeters: summary.heightMeters ?? null,
    depthMeters: summary.depthMeters ?? null,
    glbBytes: glb.byteLength,
    growMs: Math.round(grownAt - startedAt),
    exportMs: Math.round(exportedAt - grownAt),
  };
  return { glb, preset, result };
}
