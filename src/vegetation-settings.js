// Page state for the Vegetation page: what lives in the address bar, how it becomes queue
// requests, and when the form counts as changed. Pure functions, tested without a browser.
import {
  DEFAULT_BUDGET,
  VEGETATION_BUDGETS,
  VEGETATION_MAX_VARIATIONS,
  checkControlValue,
  controlMap,
  findSpecies,
  vegetationVariations,
} from '../runtime/vegetation-request.js';
import { createLog } from './app-log.js';

const log = createLog('vegetation');

export const DEFAULT_SPECIES = 'whiteOak';
export const BUDGET_NAMES = { low: 'Low', medium: 'Medium', high: 'High' };

/** "species=...&seed=...&budget=...&n=...&tune=height:20,levels:3" */
export function serializeTune(params) {
  return Object.keys(params)
    .sort()
    .map((id) => `${id}:${params[id]}`)
    .join(',');
}

/** Reads a tune string; unknown ids and invalid values are dropped. */
export function parseTune(text, speciesEntry) {
  const params = {};
  if (typeof text !== 'string' || !speciesEntry) {
    return params;
  }
  const controls = controlMap(speciesEntry);
  for (const part of text.split(',').slice(0, 120)) {
    const split = part.lastIndexOf(':');
    const control = split > 0 ? controls.get(part.slice(0, split)) : null;
    if (!control) {
      continue;
    }
    const raw = part.slice(split + 1);
    const value = control.type === 'boolean' ? raw === 'true' : Number(raw);
    const checked = checkControlValue(control, value, { clamp: false });
    if (!checked.error && checked.value !== control.default) {
      params[control.id] = checked.value;
    }
  }
  return params;
}

function whole(text, min, max, fallback) {
  const number = Number(text);
  return text !== null && text !== '' && Number.isInteger(number) && number >= min && number <= max
    ? number
    : fallback;
}

/** The form state described by the address bar, validated against the schema. */
export function stateFromSearch(search, schema) {
  const requested = findSpecies(schema, search.get('species'));
  const species = requested || findSpecies(schema, DEFAULT_SPECIES) || schema.species[0];
  const budget = search.get('budget');
  return {
    species: species.key,
    seed: whole(search.get('seed'), schema.seed.min, schema.seed.max, schema.seed.default),
    budget: VEGETATION_BUDGETS.includes(budget) ? budget : DEFAULT_BUDGET,
    variations: whole(search.get('n'), 1, VEGETATION_MAX_VARIATIONS, 1),
    params: parseTune(search.get('tune'), species),
  };
}

/** Address-bar changes for a state; defaults are omitted so a clean page has a clean address. */
export function searchFromState(state, schema) {
  return {
    species: state.species === DEFAULT_SPECIES ? null : state.species,
    seed: state.seed === schema.seed.default ? null : state.seed,
    budget: state.budget === DEFAULT_BUDGET ? null : state.budget,
    n: state.variations === 1 ? null : state.variations,
    tune: serializeTune(state.params) || null,
  };
}

export function isDefaultState(state, schema) {
  return (
    state.species === DEFAULT_SPECIES &&
    state.seed === schema.seed.default &&
    state.budget === DEFAULT_BUDGET &&
    state.variations === 1 &&
    Object.keys(state.params).length === 0
  );
}

/** The first problem with a state, as {message, id}, or null. */
export function firstProblem(state, schema, values = {}) {
  const speciesEntry = findSpecies(schema, state.species);
  if (!speciesEntry) {
    return { message: 'Choose a plant species.', id: 'vegetation-species' };
  }
  const { min, max } = schema.seed;
  if (!Number.isInteger(state.seed) || state.seed < min || state.seed > max) {
    return { message: `Use a seed from ${min} to ${max}.`, id: 'vegetation-seed' };
  }
  if (state.seed + state.variations - 1 > max) {
    return {
      message: `Seeds go up to ${max}: use a seed of ${max - state.variations + 1} or lower for ${state.variations} variations.`,
      id: 'vegetation-seed',
    };
  }
  // `values` holds text the person typed that is not a valid number yet, keyed by control id.
  for (const control of speciesEntry.controls) {
    if (Object.hasOwn(values, control.id)) {
      return {
        message: `${control.name}: enter a number from ${control.min} to ${control.max}.`,
        id: `vegetation-control-${control.id}`,
      };
    }
  }
  return null;
}

/** The queue requests for a state: one, or N siblings with consecutive seeds. */
export function buildRequests(state, makeGroup = () => crypto.randomUUID()) {
  const base = {
    species: state.species,
    seed: state.seed,
    budget: state.budget,
    params: state.params,
  };
  return vegetationVariations(base, state.variations, makeGroup);
}

export function randomSeed(schema, random = Math.random) {
  const { min, max } = schema.seed;
  return min + Math.floor(random() * (max - min + 1));
}

/** Triangle text for a budget, from the measured table when it matches this species. */
export function budgetCount(measured, species, budget) {
  const count = measured?.[species]?.[budget];
  return Number.isFinite(count) ? count : null;
}

export function formatCount(count) {
  return Number(count).toLocaleString('en-US');
}

const REUSE_KEY = 'forge-vegetation-reuse';

/** A reused asset's settings are handed to the page once, through session storage. */
export function stashReuse(request) {
  try {
    window.sessionStorage.setItem(REUSE_KEY, JSON.stringify(request));
  } catch (error) {
    // Without session storage the page just opens with its own state.
    log.debug('vegetation.reuse.stash.failed', { error });
  }
}

export function takeReuse() {
  try {
    const text = window.sessionStorage.getItem(REUSE_KEY);
    window.sessionStorage.removeItem(REUSE_KEY);
    return text ? JSON.parse(text) : null;
  } catch (error) {
    log.debug('vegetation.reuse.take.failed', { error });
    return null;
  }
}

/** Turns a reused request (untrusted) into a state, dropping anything the schema rejects. */
export function stateFromReuse(request, schema) {
  const species = findSpecies(schema, request?.species);
  if (!species) {
    return null;
  }
  const params = {};
  const controls = controlMap(species);
  for (const [id, value] of Object.entries(request.params || {})) {
    const control = controls.get(id);
    const checked = control ? checkControlValue(control, value) : { error: true };
    if (!checked.error && checked.value !== control.default) {
      params[id] = checked.value;
    }
  }
  const seed = Number.isInteger(request.seed) ? request.seed : schema.seed.default;
  return {
    species: species.key,
    seed: seed >= schema.seed.min && seed <= schema.seed.max ? seed : schema.seed.default,
    budget: VEGETATION_BUDGETS.includes(request.budget) ? request.budget : DEFAULT_BUDGET,
    variations: 1,
    params,
  };
}
