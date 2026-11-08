// MCP tools for the image, music, sound and voice options added after the first tool set:
// image variations and LoRA, extending and re-synthesizing music, and source sounds.
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { variationRequests } from './image-options.js';

const change = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const projectId = z.string().uuid();

// Extra image fields the queue_image tool accepts, spread into its input schema.
export const imageOptionSchema = {
  variations: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe(
      'Queue this many sibling renders that differ only in seed (and are grouped as variation i of N). A given seed is used for the first and counted up from there.',
    ),
  output_resolution: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .multipleOf(32)
    .optional()
    .describe(
      'With size_from_reference: the target side length in pixels used to size the render (default 1024, about one megapixel). Above about 1536 needs far more GPU memory.',
    ),
  use_kv_cache: z
    .boolean()
    .optional()
    .describe(
      'Default true. The key/value cache speeds up renders with references. Turning it off gives a different but equally valid image for the same seed.',
    ),
  sigmas: z
    .array(z.number().gt(0).max(1))
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Expert: a custom falling sigma schedule, for example [1, 0.8, 0.5, 0.2]. Its length replaces num_inference_steps. Leave unset for the model schedule.',
    ),
  lora: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'A .safetensors file name from forge_image_loras (never a path). Needs the updated Qwen Image Studio and the peft package.',
    ),
  lora_scale: z.number().min(0).max(2).optional().describe('LoRA strength, 0 to 2 (default 1).'),
};

// One job per variation. Jobs queued before a failure stay queued, and the reply lists each result.
export async function queueImageRender(write, project, input) {
  const { variations = 1, sigmas, ...request } = input;
  if (sigmas) {
    request.sigma_schedule = sigmas.join(', ');
    request.num_inference_steps = sigmas.length;
  }
  const requests = variationRequests(request, variations, {
    randomSeed: () => randomInt(0, 2147483648),
    makeGroup: randomUUID,
  });
  if (requests.length === 1) {
    return write('/api/runtime/jobs', { type: 'images', projectId: project, request });
  }
  const results = [];
  for (const item of requests) {
    const result = await write('/api/runtime/jobs', {
      type: 'images',
      projectId: project,
      request: item,
    });
    results.push(result);
    if (result.isError) {
      break;
    }
  }
  return {
    isError: results.some((result) => result.isError),
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            queued: results.filter((result) => !result.isError).length,
            requested: requests.length,
            results: results.map((result) => result.content[0].text),
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function registerMediaTools(server, { read, write, readonly }) {
  server.registerTool(
    'forge_image_loras',
    {
      description:
        'List the Qwen Image LoRA files Forge found (models/Qwen-Image-2.1-LoRA). Use a returned name as the lora field of forge_queue_image. An empty list means no LoRA files are installed.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/image-loras'),
  );
  server.registerTool(
    'forge_extend_music',
    {
      description:
        'Continue a finished YuE2 track: YuE2 generates add_seconds more song tokens that follow the saved plan and song of the source, then re-renders the whole track as a new FLAC. The source must be a music asset Forge rendered in this project (see forge_projects for its path). Optional lyrics_addition appends new lyric sections. Omit seed for a random one. The source track is not changed.',
      inputSchema: {
        projectId,
        source: z.string().min(1).max(1000).describe('Project-relative path of the music asset.'),
        add_seconds: z.number().min(1).max(300).default(30),
        lyrics_addition: z.string().max(5000).optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        title: z.string().max(200).optional(),
      },
      annotations: change,
    },
    ({ projectId: project, ...request }) =>
      write('/api/runtime/jobs', {
        type: 'music',
        projectId: project,
        request: { operation: 'extend', ...request },
      }),
  );
  server.registerTool(
    'forge_resynth_music',
    {
      description:
        'Re-synthesize a finished YuE2 track with a new seed: the planned song tokens are kept and only the synthesis and decode stages run again, so the arrangement stays and the sound changes. Faster than a full render. The source must be a music asset Forge rendered in this project. Omit seed for a random one; ode_steps overrides the synthesis steps.',
      inputSchema: {
        projectId,
        source: z.string().min(1).max(1000).describe('Project-relative path of the music asset.'),
        seed: z.number().int().min(0).max(2147483647).optional(),
        ode_steps: z.number().int().min(1).max(100).optional(),
        title: z.string().max(200).optional(),
      },
      annotations: change,
    },
    ({ projectId: project, ...request }) =>
      write('/api/runtime/jobs', {
        type: 'music',
        projectId: project,
        request: { operation: 'resynth', ...request },
      }),
  );
  server.registerTool(
    'forge_asr_latency',
    {
      description:
        'Read the saved Nemotron speech streaming latency (80, 160, 560 or 1120 ms chunks).',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/asr/latency'),
  );
  server.registerTool(
    'forge_set_asr_latency',
    {
      description:
        'Set the Nemotron speech streaming latency: 80 ms answers soonest, 160 ms is the default, 560 and 1120 ms are usually more accurate. The engine reads it only at startup, so an idle Forge-owned speech engine is stopped and started again; while a transcription session is connected the engine is left running and the choice applies at its next start.',
      inputSchema: {
        latencyMs: z.union([z.literal(80), z.literal(160), z.literal(560), z.literal(1120)]),
      },
      annotations: change,
    },
    (input) => write('/api/runtime/asr/latency', input, 30000),
  );
  server.registerTool(
    'forge_stage_audio_source',
    {
      description:
        'Snapshot a WAV, FLAC, MP3 or Ogg asset (up to 32 MiB) from the project so forge_queue_sound can start from it. Returns the staged ID to pass as source_audio.',
      inputSchema: { projectId, path: z.string().min(1).max(1000) },
      annotations: change,
    },
    ({ projectId: project, path }) => write(`/api/projects/${project}/clips/from-asset`, { path }),
  );
}
