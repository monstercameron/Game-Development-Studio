// Vegetation requests: validation against the Forge vegetation schema (built by
// vegetation-adapter.js from SeedThree's own getSchema()), variations, and clamping of untrusted
// suggestions. Pure functions with no Node-only imports, so the browser and the tests use them too.
//
// A request is {species, seed, budget, params, variation_group?, variation_index?,
// variation_count?}. `params` maps a control id from the schema to a value; only values that
// differ from the species default are kept, so equal designs have equal requests.

export const VEGETATION_MAX_VARIATIONS = 4;
export const VEGETATION_BUDGETS = Object.freeze(['low', 'medium', 'high']);
export const DEFAULT_BUDGET = 'medium';
const REQUEST_KEYS = new Set([
  'species',
  'seed',
  'budget',
  'params',
  'variation_group',
  'variation_index',
  'variation_count',
]);
const GROUP_PATTERN = /^[a-f0-9-]{36}$/i;

/**
 * Finds the species entry whose key matches. Returns null for a non-string key or a schema with
 * no species list, so a bad client value never throws here.
 */
export function findSpecies(schema, key) {
  if (typeof key !== 'string' || !Array.isArray(schema?.species)) {
    return null;
  }
  return schema.species.find((item) => item.key === key) || null;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** The control definitions of one species keyed by id (a Map: ids are never object keys). */
export function controlMap(speciesEntry) {
  return new Map((speciesEntry?.controls || []).map((control) => [control.id, control]));
}

/**
 * Checks one value against its control. Returns {value} or {error}. With `clamp`, numbers are
 * brought into range and snapped to the step instead of being rejected.
 */
export function checkControlValue(control, raw, { clamp = false } = {}) {
  if (control.type === 'boolean') {
    return typeof raw === 'boolean'
      ? { value: raw }
      : { error: `${control.name} must be true or false.` };
  }
  if (control.type === 'choice') {
    const match = control.options.find((option) => option.value === raw);
    if (match) {
      return { value: match.value };
    }
    if (clamp && typeof raw === 'string') {
      const byLabel = control.options.find(
        (option) => option.label.toLowerCase() === raw.trim().toLowerCase(),
      );
      if (byLabel) {
        return { value: byLabel.value };
      }
    }
    return {
      error: `${control.name} must be one of: ${control.options.map((o) => o.label).join(', ')}.`,
    };
  }
  let number = raw;
  if (clamp && typeof raw === 'string' && raw.trim() !== '') {
    number = Number(raw);
  }
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    return { error: `${control.name} must be a number from ${control.min} to ${control.max}.` };
  }
  if (clamp) {
    let value = Math.min(control.max, Math.max(control.min, number));
    if (control.step > 0) {
      value = control.min + Math.round((value - control.min) / control.step) * control.step;
      value = Math.min(control.max, Math.max(control.min, value));
    }
    value = control.type === 'integer' ? Math.round(value) : round(value);
    return { value };
  }
  if (number < control.min || number > control.max) {
    return { error: `${control.name} must be from ${control.min} to ${control.max}.` };
  }
  if (control.type === 'integer' && !Number.isInteger(number)) {
    return { error: `${control.name} must be a whole number.` };
  }
  return { value: round(number) };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a queue request. Throws a plain-language Error for the first problem. Unknown fields
 * (at the top level or inside `params`) are rejected rather than ignored.
 */
export function normalizeVegetationRequest(input, schema) {
  if (!isPlainObject(input)) {
    throw Error('Vegetation settings must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) {
      throw Error(`Unknown vegetation setting "${key.slice(0, 40)}".`);
    }
  }
  const speciesEntry = findSpecies(schema, input.species);
  if (!speciesEntry) {
    throw Error('Choose one of the available plant species.');
  }
  const { min, max } = schema.seed;
  const seed = input.seed === undefined ? schema.seed.default : input.seed;
  if (!Number.isInteger(seed) || seed < min || seed > max) {
    throw Error(`Seed must be a whole number from ${min} to ${max}.`);
  }
  const budget = input.budget === undefined ? DEFAULT_BUDGET : input.budget;
  if (!VEGETATION_BUDGETS.includes(budget)) {
    throw Error('Triangle budget must be low, medium or high.');
  }
  const rawParams = input.params === undefined ? {} : input.params;
  if (!isPlainObject(rawParams)) {
    throw Error('Parameters must be an object of control values.');
  }
  const controls = controlMap(speciesEntry);
  const params = {};
  for (const id of Object.keys(rawParams)) {
    const control = controls.get(id);
    if (!control) {
      throw Error(`"${id.slice(0, 60)}" is not a control of ${speciesEntry.name}.`);
    }
    const checked = checkControlValue(control, rawParams[id]);
    if (checked.error) {
      throw Error(checked.error);
    }
    if (checked.value !== control.default) {
      params[id] = checked.value;
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(params)
      .sort()
      .map((id) => [id, params[id]]),
  );
  const out = { species: speciesEntry.key, seed, budget, params: sorted };
  const variationFields = [input.variation_group, input.variation_index, input.variation_count];
  if (variationFields.some((item) => item !== undefined && item !== null)) {
    if (
      typeof input.variation_group !== 'string' ||
      !GROUP_PATTERN.test(input.variation_group) ||
      !Number.isInteger(input.variation_count) ||
      input.variation_count < 2 ||
      input.variation_count > VEGETATION_MAX_VARIATIONS ||
      !Number.isInteger(input.variation_index) ||
      input.variation_index < 1 ||
      input.variation_index > input.variation_count
    ) {
      throw Error(
        `Variation needs a group ID, a position from 1 and a count from 2 to ${VEGETATION_MAX_VARIATIONS}.`,
      );
    }
    out.variation_group = input.variation_group;
    out.variation_index = input.variation_index;
    out.variation_count = input.variation_count;
  }
  return out;
}

/**
 * Turns untrusted output (for example a language model's JSON) into valid control values for one
 * species. Never throws on bad content: unknown names, wrong types and out-of-range numbers are
 * dropped or clamped, and reported so the person can see what changed.
 *
 * @returns {{params: object, ignored: string[], adjusted: string[]}}
 */
export function clampSuggestedParams(raw, speciesEntry) {
  const params = {};
  const ignored = [];
  const adjusted = [];
  if (!isPlainObject(raw)) {
    return { params, ignored, adjusted };
  }
  const controls = controlMap(speciesEntry);
  let seen = 0;
  for (const id of Object.keys(raw)) {
    seen += 1;
    if (seen > 200) {
      ignored.push('(more than 200 entries)');
      break;
    }
    const control = controls.get(id);
    if (!control) {
      ignored.push(id.slice(0, 40));
      continue;
    }
    const checked = checkControlValue(control, raw[id], { clamp: true });
    if (checked.error) {
      ignored.push(control.name);
      continue;
    }
    if (checked.value !== raw[id] && control.type !== 'choice') {
      adjusted.push(control.name);
    }
    if (checked.value !== control.default) {
      params[id] = checked.value;
    }
  }
  return { params, ignored, adjusted };
}

/**
 * Values to show in the form: defaults for the species with `params` applied.
 * Returns a Map from control id to value (ids are never object keys).
 */
export function effectiveValues(speciesEntry, params = {}) {
  const values = new Map();
  for (const control of speciesEntry?.controls || []) {
    values.set(
      control.id,
      Object.hasOwn(params, control.id) ? params[control.id] : control.default,
    );
  }
  return values;
}

const RESULT_STRINGS = [
  'species',
  'speciesName',
  'budget',
  'lodName',
  'seedthreeVersion',
  'seedthreeCommit',
];
const RESULT_NUMBERS = [
  'seed',
  'triangles',
  'vertices',
  'meshes',
  'instances',
  'widthMeters',
  'heightMeters',
  'depthMeters',
  'glbBytes',
  'growMs',
  'exportMs',
  'totalMs',
  'peakRssMiB',
  'glbPrimitiveTriangles',
];

/** Keeps only the known, bounded fields of a generation result before it is stored. */
export function cleanVegetationResult(result) {
  if (!isPlainObject(result)) {
    return null;
  }
  const out = {};
  for (const key of RESULT_STRINGS) {
    if (typeof result[key] === 'string') {
      out[key] = result[key].slice(0, 80);
    }
  }
  for (const key of RESULT_NUMBERS) {
    if (typeof result[key] === 'number' && Number.isFinite(result[key])) {
      out[key] = result[key];
    }
  }
  if (Array.isArray(result.levelTriangles)) {
    out.levelTriangles = result.levelTriangles
      .filter((value) => Number.isSafeInteger(value) && value >= 0)
      .slice(0, 6);
  }
  return Number.isSafeInteger(out.triangles) ? out : null;
}

const PARAM_PREFIX = 'p_';
const RESULT_SETTINGS = {
  triangles: 'triangles',
  vertices: 'vertices',
  heightMeters: 'height_m',
  widthMeters: 'width_m',
  depthMeters: 'depth_m',
  glbBytes: 'glb_bytes',
  growMs: 'grow_ms',
  exportMs: 'export_ms',
  peakRssMiB: 'peak_rss_mib',
  lodName: 'lod',
  seedthreeVersion: 'seedthree_version',
  seedthreeCommit: 'seedthree_commit',
};

/**
 * Asset metadata stores only flat scalar settings, so each control value becomes `p_<id>` with
 * dots written as double underscores (SeedThree ids contain no underscores), next to the
 * measured result. vegetationRequestFromSettings() reverses it for "Reuse settings".
 */
export function vegetationSettings(request, result = null) {
  const settings = { species: request.species, budget: request.budget };
  for (const [id, value] of Object.entries(request.params || {})) {
    settings[`${PARAM_PREFIX}${id.replaceAll('.', '__')}`] = value;
  }
  for (const [from, to] of Object.entries(RESULT_SETTINGS)) {
    if (result && result[from] !== undefined) {
      settings[to] = result[from];
    }
  }
  return settings;
}

/** Rebuilds {species, seed, budget, params} from recorded settings (unvalidated). */
export function vegetationRequestFromSettings(settings = {}, seed = null) {
  const params = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(PARAM_PREFIX)) {
      params[key.slice(PARAM_PREFIX.length).replaceAll('__', '.')] = value;
    }
  }
  return {
    species: settings.species,
    seed: Number.isInteger(seed) ? seed : settings.seed,
    budget: settings.budget,
    params,
  };
}

export function vegetationTitle(request, result = null) {
  const name = result?.speciesName || request.species;
  return `${name} · seed ${request.seed}`;
}

/**
 * N sibling requests that share every setting; seeds count up from the given one. Kept here (not
 * imported from the image options) so the browser bundle stays free of Node-only modules.
 */
export function vegetationVariations(request, count, makeGroup) {
  if (!Number.isInteger(count) || count < 1 || count > VEGETATION_MAX_VARIATIONS) {
    throw Error(`Variations must be from 1 to ${VEGETATION_MAX_VARIATIONS}.`);
  }
  if (count === 1) {
    return [request];
  }
  const group = makeGroup();
  return Array.from({ length: count }, (_, position) => ({
    ...request,
    seed: request.seed + position,
    variation_group: group,
    variation_index: position + 1,
    variation_count: count,
  }));
}
