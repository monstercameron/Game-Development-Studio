// MCP tools for the Vegetation generator (SeedThree). They only call Forge's own loopback
// routes. There is deliberately no tool that fetches SeedThree: downloading a repository is the
// person's explicit choice (Fetch SeedThree on the Vegetation page, or install.ps1 -Vegetation).
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  VEGETATION_BUDGETS,
  VEGETATION_MAX_VARIATIONS,
  vegetationVariations,
} from './vegetation-request.js';

const change = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function textResult(value, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** forge_vegetation_schema: the species list, or one species with all its controls. */
export async function vegetationSchemaResult(read, species) {
  const reply = await read('/api/vegetation/schema');
  if (reply.isError) {
    return reply;
  }
  const { schema, measured } = JSON.parse(reply.content[0].text);
  const common = {
    seedthree: schema.seedthree,
    seed: schema.seed,
    budgets: schema.budgets,
    limits: schema.limits,
  };
  if (!species) {
    return textResult({
      ...common,
      species: schema.species.map((item) => ({
        key: item.key,
        name: item.name,
        latin: item.latin,
        biome: item.biome,
        generator: item.generator,
        controlCount: item.controls.length,
        measuredTriangles: measured?.[item.key] ?? null,
      })),
      next: 'Call forge_vegetation_schema with species to see its controls and ranges.',
    });
  }
  const entry = schema.species.find((item) => item.key === species);
  if (!entry) {
    return textResult(
      {
        error: `Unknown species. Use one of: ${schema.species.map((item) => item.key).join(', ')}`,
      },
      true,
    );
  }
  return textResult({
    ...common,
    species: { ...entry, measuredTriangles: measured?.[species] ?? null },
  });
}

/** One job per variation, with consecutive seeds. Jobs queued before a failure stay queued. */
export async function queueVegetation(write, input) {
  const { projectId, variations = 1, seed, ...rest } = input;
  const firstSeed = seed ?? randomInt(1, 9999 - (variations - 1) + 1);
  if (firstSeed + variations - 1 > 9999) {
    return textResult(
      {
        error: `Seeds go up to 9999: use a seed of ${9999 - variations + 1} or lower for ${variations} variations.`,
      },
      true,
    );
  }
  const requests = vegetationVariations({ ...rest, seed: firstSeed }, variations, randomUUID);
  const results = [];
  for (const request of requests) {
    const result = await write('/api/runtime/jobs', { type: 'vegetation', projectId, request });
    results.push(result);
    if (result.isError) {
      break;
    }
  }
  if (requests.length === 1) {
    return results[0];
  }
  return textResult(
    {
      queued: results.filter((result) => !result.isError).length,
      requested: requests.length,
      results: results.map((result) => result.content[0].text),
    },
    results.some((result) => result.isError),
  );
}

export function registerVegetationTools(server, { read, write, readonly }) {
  server.registerTool(
    'forge_vegetation_status',
    {
      description:
        'Report whether the linked SeedThree plant generator is ready (state missing, outdated, dependencies_missing or ready), the pinned commit, and how "Describe it" is configured. If it is not ready, ask the user to press Fetch SeedThree on the Vegetation page; there is no tool that downloads it.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/vegetation/status'),
  );

  server.registerTool(
    'forge_vegetation_schema',
    {
      description:
        "SeedThree's species and control schema as Forge uses it. Without species: the 20 species with triangle counts measured at each budget for their default design. With species: every control (id, name, group, type number|integer|choice|boolean, min, max, step, default, options) that forge_queue_vegetation accepts in params. Fails with Fetch instructions when SeedThree has not been fetched.",
      inputSchema: {
        species: z.string().max(40).optional().describe('A species key, for example whiteOak.'),
      },
      annotations: readonly,
    },
    ({ species }) => vegetationSchemaResult(read, species),
  );

  server.registerTool(
    'forge_queue_vegetation',
    {
      description:
        'Queue procedural plants with SeedThree. Runs on the CPU in a separate process: it needs no model, no GPU memory and takes a few seconds; the queue still runs one render at a time. Each render saves forge-<job id>.glb (standard replacement materials, no textures, no wind or billboard LODs) and forge-<job id>.preset.json (a SeedThree preset that opens in the SeedThree app) in the project 3d folder. Unknown params are rejected. Read results with forge_job and forge_assets.',
      inputSchema: {
        projectId: z.string().uuid(),
        species: z.string().max(40).describe('A species key from forge_vegetation_schema.'),
        seed: z
          .number()
          .int()
          .min(1)
          .max(9999)
          .optional()
          .describe('Same seed and settings give the same plant. Random when omitted.'),
        budget: z
          .enum(VEGETATION_BUDGETS)
          .default('medium')
          .describe('Triangle budget: the level of detail exported (low = fewest triangles).'),
        params: z
          .record(z.string().max(60), z.union([z.number(), z.boolean()]))
          .default({})
          .describe('Control values keyed by control id, validated against the species schema.'),
        variations: z
          .number()
          .int()
          .min(1)
          .max(VEGETATION_MAX_VARIATIONS)
          .default(1)
          .describe('Queue this many sibling plants with consecutive seeds (variation i of N).'),
      },
      annotations: change,
    },
    (input) => queueVegetation(write, input),
  );
}
