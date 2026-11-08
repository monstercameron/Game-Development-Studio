// Shared tool definitions for the local HTTP and stdio MCP transports.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { registerExtendedTools } from './mcp-studio-tools.js';
import {
  MAX_VIDEO_FRAMES,
  validFrameCount,
  VIDEO_ASPECTS,
  VIDEO_RESOLUTIONS,
} from './video-options.js';
import { imageOptionSchema, queueImageRender, registerMediaTools } from './mcp-media-tools.js';
import {
  REMOVE_BACKGROUND_DEFAULT_PROMPT,
  TEXT_TO_3D_IMAGE_SIZE,
  TEXT_TO_3D_IMAGE_STEPS,
  removeBackgroundChain,
  textTo3dChain,
} from './three-d-chain.js';

// Optional on the 3D tools: cut the object out of the reference first with SAM 3.1, then build
// the model from the cutout (two chained jobs; the second waits for the first).
const removeBackgroundSchema = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(1000)
      .default(REMOVE_BACKGROUND_DEFAULT_PROMPT)
      .describe('What SAM 3.1 should isolate, for example "the dragon" or "the main object".'),
    confidence: z.number().min(0).max(1).default(0.5),
  })
  .optional()
  .describe(
    'Remove the background first with SAM 3.1 (queues a segmentation job, then the 3D job chained to its transparent output). Use it for photos and opaque images; skip it when the reference already has a transparent background.',
  );

export function createMcpServer(origin = process.env.FORGE_STUDIO_URL || 'http://127.0.0.1:5173') {
  const base = new URL(origin);
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'FORGE_STUDIO_URL must be a local http://127.0.0.1 or http://localhost studio origin.',
    );
  }
  const server = new McpServer({ name: 'forge-studio', version: '0.1.0' });
  async function read(path) {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      const body = await response.text();
      if (!response.ok) {
        return {
          isError: true,
          content: [
            { type: 'text', text: `Forge returned ${response.status}: ${body.slice(0, 2000)}` },
          ],
        };
      }
      return { content: [{ type: 'text', text: body }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Cannot reach Forge Studio: ${error.message}` }],
      };
    }
  }
  async function write(path, body, timeout = 10000, requestKind) {
    try {
      const response = await fetch(new URL(path, base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forge-Request':
            requestKind ||
            (path === '/api/projects' || path.startsWith('/api/projects/') ? 'project' : 'runtime'),
          Origin: base.origin,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
      const text = await response.text();
      return { isError: !response.ok, content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Cannot reach Forge Studio: ${error.message}` }],
      };
    }
  }
  const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  registerExtendedTools(server, { base, read, write, readonly });
  registerMediaTools(server, { read, write, readonly });
  server.registerTool(
    'forge_models',
    {
      description:
        'List Forge models and supporting checkpoints, their purposes, inputs, outputs, associated tools, and observed service and storage status. A reachable service does not prove a model is loaded.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/models'),
  );
  server.registerTool(
    'forge_services',
    {
      description: 'List configured and planned Forge engines and observed local service status.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/services'),
  );
  server.registerTool(
    'forge_hardware',
    {
      description: 'Read current NVIDIA GPU memory and device information.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/hardware'),
  );
  server.registerTool(
    'forge_runtime_health',
    {
      description: 'Read isolated runtime and supervisor health.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/health'),
  );
  server.registerTool(
    'forge_projects',
    {
      description: 'List local Forge projects and their indexed assets.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/projects'),
  );
  server.registerTool(
    'forge_create_project',
    {
      description:
        'Create a local Forge project and its asset folders. Returns its project ID and folder path.',
      inputSchema: { name: z.string().trim().min(1).max(80) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) => write('/api/projects', input),
  );
  server.registerTool(
    'forge_update_asset',
    {
      description:
        'Update the rating or keep status of an indexed project asset. Set rating to null to clear it. Supply at least one of rating or kept.',
      inputSchema: {
        projectId: z.string().uuid(),
        path: z.string().min(1).max(1000),
        rating: z.number().int().min(1).max(5).nullable().optional(),
        kept: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...input }) => write(`/api/projects/${projectId}/assets/metadata`, input),
  );
  server.registerTool(
    'forge_project_trash',
    {
      description: 'List recoverable deleted assets in one project.',
      inputSchema: { projectId: z.string().uuid() },
      annotations: readonly,
    },
    ({ projectId }) => read(`/api/projects/${projectId}/assets/trash`),
  );
  server.registerTool(
    'forge_rename_asset',
    {
      description:
        'Rename a project asset in its existing folder without replacing another file. The new name must retain the original extension. Ratings and render provenance are preserved.',
      inputSchema: {
        projectId: z.string().uuid(),
        path: z.string().min(1).max(1000),
        name: z.string().min(1).max(180),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...input }) => write(`/api/projects/${projectId}/assets/rename`, input),
  );
  server.registerTool(
    'forge_trash_asset',
    {
      description: 'Move an indexed project asset to recoverable project trash.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ projectId, path }) => write(`/api/projects/${projectId}/assets/trash`, { path }),
  );
  server.registerTool(
    'forge_restore_asset',
    {
      description:
        'Restore a trash item to its original project path without overwriting an existing file.',
      inputSchema: { projectId: z.string().uuid(), trashId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, trashId }) => write(`/api/projects/${projectId}/assets/restore`, { trashId }),
  );
  server.registerTool(
    'forge_clear_project_trash',
    {
      description:
        'Permanently delete all files currently in project trash. Cannot be undone. Requires explicit user confirmation.',
      inputSchema: {
        projectId: z.string().uuid(),
        confirmation: z.literal('permanently-delete-trash'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ projectId, confirmation }) =>
      write(`/api/projects/${projectId}/assets/clear-trash`, { confirmation }),
  );
  server.registerTool(
    'forge_diagnostics',
    {
      description: 'Read studio address, process metadata and service port status.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/diagnostics'),
  );
  server.registerTool(
    'forge_logs',
    {
      description:
        'Read recent diagnostic logs. Logs may contain prompts and other private content.',
      inputSchema: {
        source: z
          .enum([
            'all',
            'studio',
            'service-supervisor',
            'runtime-worker',
            'managed-images',
            'managed-music',
            'managed-sfx',
            'managed-video',
            'managed-game',
            'managed-tts',
            'managed-asr',
            'managed-3d-hunyuan',
            'managed-3d-trellis',
            'managed-segmentation',
            'managed-motion-hy',
            'managed-motion-bricks',
            'music',
            'music-errors',
            'sfx',
            'sfx-errors',
            'video',
            'video-errors',
            'game',
            'game-errors',
            'images',
          ])
          .default('all'),
      },
      annotations: readonly,
    },
    ({ source }) => read(`/api/logs?source=${encodeURIComponent(source)}`),
  );
  server.registerTool(
    'forge_jobs',
    {
      description: 'List durable render jobs and their current status.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/jobs'),
  );
  server.registerTool(
    'forge_model_storage',
    {
      description:
        'Read the asynchronous inventory of model files in Forge-managed storage, including measured file sizes and scan status. Models in other apps are not included.',
      inputSchema: {},
      annotations: readonly,
    },
    () => read('/api/runtime/model-storage'),
  );
  server.registerTool(
    'forge_remove_managed_model',
    {
      description:
        'Permanently delete a model folder in Forge-managed storage, or retry cleanup of a previously failed removal. Only call with an explicit user request to delete this model. Its service must be stopped. This does not remove project assets.',
      inputSchema: {
        id: z.enum(['tts', '3d-hunyuan', 'segmentation', 'motion-hy', 'motion-bricks', 'asr']),
        confirmation: z.literal('permanently-delete-model'),
        retry: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ id, ...input }) => write(`/api/runtime/models/${id}/remove`, input, 20000),
  );
  server.registerTool(
    'forge_job',
    {
      description: 'Get the status of one durable render job.',
      inputSchema: { id: z.string().uuid() },
      annotations: readonly,
    },
    ({ id }) => read(`/api/runtime/jobs/${id}`),
  );
  server.registerTool(
    'forge_queue_music',
    {
      description:
        'Queue one YuE2 music render in a project. Forge starts and loads YuE2 on demand after a GPU memory check; inspect waiting_memory jobs for offload choices. Lyrics and style are required. Omit seed for a random one (it is recorded with the render). Negative style affects generation when guidance is not 1. Optional abc is an ABC-notation score that conditions the song on your own melody (needs cot full or melody); temperature, top_p, top_k and repetition_penalty tune song-token sampling. Reference-audio covers and stems are not available; use forge_extend_music or forge_resynth_music to continue or re-synthesize a finished track.',
      inputSchema: {
        projectId: z.string().uuid(),
        style: z.string().min(1).max(2000),
        lyrics: z.string().min(1).max(20000),
        duration_seconds: z.number().min(1).max(600).default(15),
        seed: z.number().int().nonnegative().optional(),
        cot: z.enum(['full', 'melody', 'off']).default('full'),
        title: z.string().max(200).default(''),
        ode_steps: z.number().int().min(1).max(100).default(32),
        negative: z.string().max(2000).default(''),
        cfg_scale: z.number().min(0).max(20).nullable().default(null),
        abc: z.string().max(20000).optional(),
        temperature: z.number().min(0).max(5).optional(),
        top_p: z.number().gt(0).max(1).optional(),
        top_k: z.number().int().min(1).max(1000).optional(),
        repetition_penalty: z.number().min(1).max(2).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'music', projectId, request }),
  );
  server.registerTool(
    'forge_queue_sound',
    {
      description:
        'Queue one Stable Audio sound effect in a project. Forge starts the worker and requests a model load on demand after checking GPU memory. If access is needed, use the Studio model settings; do not send tokens through MCP. Seed -1 (the default) picks a random seed that is recorded with the render. The post-trained Medium model ignores negative prompts and guidance, and looping is not available. To start from an existing sound, stage it with forge_stage_audio_source and pass source_audio with an edit_mode: variation (audio-to-audio; init_noise_level 0.05-1 sets how far the result may move from the source, default 0.9), replace (regenerates only inpaint_start to inpaint_end seconds), or continue (keeps the source and generates the rest up to duration, which must be longer than the source). Needs the updated Stable Audio Lab app.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        duration: z.number().min(1).max(380).default(5),
        steps: z.number().int().min(1).max(50).default(8),
        seed: z.number().int().min(-1).max(2147483647).default(-1),
        source_audio: z.string().min(1).max(100).optional(),
        edit_mode: z.enum(['variation', 'replace', 'continue']).optional(),
        init_noise_level: z.number().min(0.05).max(1).optional(),
        inpaint_start: z.number().min(0).max(380).optional(),
        inpaint_end: z.number().gt(0).max(380).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) => write('/api/runtime/jobs', { type: 'sfx', projectId, request }),
  );
  server.registerTool(
    'forge_queue_voice',
    {
      description:
        'Queue buffered Qwen3-TTS speech. mode "preset" (default) uses one of nine preset speakers with an optional voice direction (instruct, e.g. tone, pace, emotion). mode "clone" copies a voice from reference_audio (the staged ID returned by forge_stage_audio_source for a project WAV, FLAC or MP3 of 3 to 30 seconds) and its exact transcript reference_text; set reference_consent to true only when the user has confirmed they have the right to use that voice. mode "design" creates a voice from voice_description (up to 500 characters). Clone and design need the Base or VoiceDesign checkpoint to be installed; Forge loads it, unloading the resident checkpoint first. Omit seed for a random one (it is recorded with the asset; the same seed and settings repeat a render). Optional temperature, top_p, top_k and repetition_penalty tune sampling, do_sample false switches to greedy decoding, and subtalker_dosample, subtalker_temperature, subtalker_top_p and subtalker_top_k tune the second-stage model that fills in fine acoustic detail; max_new_tokens caps speech length at about 12.5 tokens per second. Output is a 24 kHz mono WAV. Streaming output and speed or pitch controls are not available.',
      inputSchema: {
        projectId: z.string().uuid(),
        text: z.string().min(1).max(1000),
        mode: z.enum(['preset', 'clone', 'design']).default('preset'),
        reference_audio: z.string().min(1).max(100).optional(),
        reference_text: z.string().min(1).max(1000).optional(),
        reference_consent: z.literal(true).optional(),
        voice_description: z.string().min(1).max(500).optional(),
        speaker: z
          .enum([
            'Ryan',
            'Aiden',
            'Vivian',
            'Serena',
            'Uncle_Fu',
            'Dylan',
            'Eric',
            'Ono_Anna',
            'Sohee',
          ])
          .default('Ryan'),
        language: z
          .enum([
            'Auto',
            'English',
            'Chinese',
            'Japanese',
            'Korean',
            'German',
            'French',
            'Russian',
            'Portuguese',
            'Spanish',
            'Italian',
          ])
          .default('English'),
        instruct: z.string().max(500).default(''),
        max_new_tokens: z.number().int().min(64).max(4096).default(1024),
        seed: z.number().int().min(0).max(2147483647).optional(),
        temperature: z.number().min(0.05).max(2).optional(),
        top_p: z.number().min(0.01).max(1).optional(),
        top_k: z.number().int().min(1).max(1000).optional(),
        repetition_penalty: z.number().min(1).max(2).optional(),
        do_sample: z.boolean().optional(),
        subtalker_dosample: z.boolean().optional(),
        subtalker_temperature: z.number().min(0.05).max(2).optional(),
        subtalker_top_p: z.number().min(0.01).max(1).optional(),
        subtalker_top_k: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'voices', projectId, request }),
  );
  server.registerTool(
    'forge_queue_hunyuan_shape',
    {
      description:
        'Queue a Hunyuan3D 2.1 shape from one staged reference image. Untextured by default; set texture to true for an experimental textured GLB (albedo plus metallic-roughness) that needs the texture models and much more time and memory. Hunyuan reads the image alpha channel as the object mask, so cut the object out first (segmentation can make a transparent PNG) or the whole picture is treated as the object. target_faces reduces the mesh to about that many triangles (omit to keep the raw mesh, or 40,000 when texturing). Output is always a GLB. Forge starts and loads the model after GPU and host-memory checks.',
      inputSchema: {
        projectId: z.string().uuid(),
        reference: z.string().min(1),
        seed: z.number().int().min(0).max(2147483647).default(123),
        steps: z.number().int().min(1).max(100).default(30),
        resolution: z.union([z.literal(128), z.literal(256), z.literal(384)]).default(128),
        guidance: z.number().min(1).max(20).default(5),
        target_faces: z.number().int().min(1000).max(1000000).optional(),
        texture: z.boolean().default(false),
        texture_size: z.union([z.literal(1024), z.literal(2048)]).default(2048),
        texture_views: z
          .union([z.literal(6), z.literal(7), z.literal(8), z.literal(9)])
          .optional()
          .describe(
            'Advanced, with texture on: how many views the painter renders (default 6, what it was trained on). More views take longer; 8 views at 768 px used about 15 GB more GPU memory and looked no better in a test.',
          ),
        texture_view_size: z
          .union([z.literal(512), z.literal(768)])
          .optional()
          .describe(
            'Advanced, with texture on: size of each painted view in pixels (default 512).',
          ),
        removeBackground: removeBackgroundSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, reference, removeBackground, ...request }) =>
      removeBackground
        ? write('/api/runtime/jobs/chain', {
            steps: removeBackgroundChain({
              projectId,
              referenceId: reference,
              model: 'hunyuan',
              request: { model: 'hunyuan', ...request },
              ...removeBackground,
            }),
          })
        : write('/api/runtime/jobs', {
            type: '3d',
            projectId,
            request: { ...request, references: [reference] },
          }),
  );
  server.registerTool(
    'forge_queue_trellis',
    {
      description:
        'Queue an experimental TRELLIS.2 textured GLB from one staged transparent PNG or WebP (an opaque image is rejected unless removeBackground is set, which cuts the object out with SAM 3.1 first). pipeline picks the resolution: 512 (default), 1024, 1024_cascade or 1536_cascade; higher ones are slower and use more memory, and the worker rejects a pipeline whose checkpoints are not installed. target_faces sets the exported triangle count (default 100,000; upstream defaults to 1,000,000, which is too heavy for most games). Output is a GLB with WebP textures. Forge checks GPU and system memory.',
      inputSchema: {
        projectId: z.string().uuid(),
        reference: z.string().min(1),
        seed: z.number().int().min(0).max(2147483647).default(42),
        steps: z.number().int().min(1).max(50).default(12),
        texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048)]).default(1024),
        target_faces: z.number().int().min(5000).max(1000000).default(100000),
        pipeline: z.enum(['512', '1024', '1024_cascade', '1536_cascade']).optional(),
        removeBackground: removeBackgroundSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, reference, removeBackground, ...request }) =>
      removeBackground
        ? write('/api/runtime/jobs/chain', {
            steps: removeBackgroundChain({
              projectId,
              referenceId: reference,
              model: 'trellis',
              request: { model: 'trellis', ...request },
              ...removeBackground,
            }),
          })
        : write('/api/runtime/jobs', {
            type: 'trellis',
            projectId,
            request: { ...request, references: [reference] },
          }),
  );
  server.registerTool(
    'forge_queue_text_to_3d',
    {
      description:
        'Queue text-to-3D: a Qwen Image render of the description with a transparent background, then a 3D model built from that image by Hunyuan3D or TRELLIS.2. Two chained jobs are queued; the 3D job waits for the image and uses it automatically. The intermediate image is saved in the project like any image and the 3D asset records it in its generation details. The two models load one after the other, not together, so the first may be unloaded before the second loads. options are the 3D settings for the chosen model (Hunyuan: seed, steps, resolution, guidance, target_faces, texture, texture_size; TRELLIS.2: seed, steps, texture_size, target_faces, pipeline) and are validated like forge_queue_hunyuan_shape and forge_queue_trellis. If the image fails or is cancelled, the 3D job fails or is cancelled with a clear message.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        model: z.enum(['hunyuan', 'trellis']).default('hunyuan'),
        image: z
          .object({
            steps: z.number().int().min(1).max(100).default(TEXT_TO_3D_IMAGE_STEPS),
            seed: z.number().int().nonnegative().optional(),
            width: z.number().int().min(32).max(2752).multipleOf(32).default(TEXT_TO_3D_IMAGE_SIZE),
            height: z
              .number()
              .int()
              .min(32)
              .max(2752)
              .multipleOf(32)
              .default(TEXT_TO_3D_IMAGE_SIZE),
          })
          .optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, prompt, model, image = {}, options = {} }) =>
      write('/api/runtime/jobs/chain', {
        steps: textTo3dChain({
          projectId,
          model,
          image: {
            prompt,
            width: image.width ?? TEXT_TO_3D_IMAGE_SIZE,
            height: image.height ?? TEXT_TO_3D_IMAGE_SIZE,
            num_inference_steps: image.steps ?? TEXT_TO_3D_IMAGE_STEPS,
            ...(image.seed === undefined ? {} : { seed: image.seed }),
          },
          request: { model, ...options },
        }),
      }),
  );
  server.registerTool(
    'forge_queue_segmentation',
    {
      description:
        'Queue text-prompted SAM 3.1 still-image segmentation using one staged reference. The result is a transparent PNG or mask in the project.',
      inputSchema: {
        projectId: z.string().uuid(),
        reference: z.string().min(1),
        prompt: z.string().min(1).max(1000),
        output: z.enum(['transparent', 'mask']).default('transparent'),
        confidence: z.number().min(0).max(1).default(0.5),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, reference, ...request }) =>
      write('/api/runtime/jobs', {
        type: 'segmentation',
        projectId,
        request: { ...request, references: [reference] },
      }),
  );
  server.registerTool(
    'forge_queue_hymotion',
    {
      description:
        'Queue HY-Motion text-to-human-motion generation. Returns a skeletal BVH clip; retargeting to another character is separate.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(1000),
        duration: z.number().min(1).max(12).default(3),
        seed: z.number().int().min(0).max(2147483647).default(123),
        steps: z.number().int().min(1).max(100).default(50),
        guidance: z.number().min(0).max(20).default(5),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', {
        type: 'motion',
        projectId,
        request: { model: 'hy-motion', ...request },
      }),
  );
  server.registerTool(
    'forge_stage_soma_pose',
    {
      description:
        'Snapshot a project BVH asset for MotionBricks. The BVH must contain the 30 SOMA joints; other skeletons are not retargeted.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, path }) => write(`/api/projects/${projectId}/poses/from-asset`, { path }),
  );
  server.registerTool(
    'forge_queue_motionbricks',
    {
      description:
        'Queue an experimental SOMA BVH pose transition from a staged pose. Indices use 30 fps windows of four frames. Outputs a BVH in the project motion folder; no retargeting or endpoint correction.',
      inputSchema: {
        projectId: z.string().uuid(),
        pose: z.string().min(1),
        context_frame: z.number().int().nonnegative(),
        target_frame: z.number().int().nonnegative(),
        min_tokens: z.number().int().min(6).max(16).default(8),
        max_tokens: z.number().int().min(6).max(16).default(14),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'motion-bricks', projectId, request }),
  );
  server.registerTool(
    'forge_queue_image',
    {
      description:
        'Queue a Qwen image render with up to 10 staged references (editing and multi-reference composition; the prompt may refer to them as image 1, image 2 and so on). Optional negative_prompt requires true_cfg_scale greater than 1 and increases render time; omit both for the model default. transparent asks for an RGBA image with a transparent background. size_from_reference makes the model derive the size (about one megapixel) from the last reference image and ignores width and height. Width and height go up to 2752 px in multiples of 32. A render makes one image; seed is chosen randomly when omitted and recorded with the asset. variations (1-4) queues that many sibling renders that differ only in seed. lora (a file name from forge_image_loras) applies a LoRA at lora_scale 0-2. output_resolution sets the size target used with size_from_reference. use_kv_cache false turns the key/value cache off. sigmas is an expert custom sampling schedule. A painted mask is not an engine input: add a mask or marked-up copy as another reference and describe it in the prompt. Forge checks GPU memory before loading.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        width: z.number().int().min(32).max(2752).multipleOf(32).default(1024),
        height: z.number().int().min(32).max(2752).multipleOf(32).default(1024),
        num_inference_steps: z.number().int().min(1).max(100).default(40),
        references: z.array(z.string()).max(10).default([]),
        seed: z.number().int().nonnegative().optional(),
        negative_prompt: z.string().max(4000).optional(),
        true_cfg_scale: z.number().min(1).max(10).optional(),
        transparent: z.boolean().optional(),
        size_from_reference: z.boolean().optional(),
        ...imageOptionSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) => queueImageRender(write, projectId, request),
  );
  server.registerTool(
    'forge_stage_reference',
    {
      description:
        'Snapshot a PNG, JPEG, or WebP asset from the selected project for use as an image or video reference. Use forge_projects to discover its project-relative asset path.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, path }) => write(`/api/projects/${projectId}/references/from-asset`, { path }),
  );
  server.registerTool(
    'forge_queue_world',
    {
      description:
        'Queue a CUDA world render. WorldGen accepts text, one image, or one 360° panorama (2:1 equirectangular) and exports a Gaussian-splat PLY, a vertex-coloured mesh PLY (output "mesh"), or a vertex-coloured mesh GLB (output "glb"); resolution is the panorama width: 1024, 1600 or 2048 (about width × width/2 splats). For text and image modes, seed (omit for a random one that Forge records), steps 10–60 and optional FLUX guidance 1–50 (defaults 7 for text, 30 for images) apply, and save_panorama also keeps the generated panorama as a project image so it can be reused as a panorama input. HY-World reconstructs a Gaussian-splat PLY from 1–8 staged image views (mode image) or from one staged 360° panorama that it cuts into eight views (mode panorama), at resolution 336, 518, 700 or 952 per view; views of different shapes are cropped to the first one; splat_limit (100000–5000000, default 1000000) caps the splats, remove_sky drops sky pixels, and confidence_percentile (0–50, default 10; 0 keeps everything) drops that share of the least-confident points. Options that do not apply to the chosen model and mode are rejected. WorldGen negative prompts, SHARP and background inpainting are not offered. Output is saved in the project 3D folder.',
      inputSchema: {
        projectId: z.string().uuid(),
        model: z.enum(['worldgen', 'hy-world']),
        mode: z.enum(['text', 'image', 'panorama']),
        prompt: z.string().max(4000).default(''),
        output: z.enum(['splat', 'mesh', 'glb']).default('splat'),
        resolution: z.number().int(),
        references: z.array(z.string()).max(8).default([]),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2147483647)
          .optional()
          .describe('Optional. Omit for a random seed, which Forge records with the world.'),
        steps: z.number().int().min(10).max(60).default(50),
        guidance: z.number().min(1).max(50).optional(),
        save_panorama: z.boolean().optional(),
        splat_limit: z.number().int().min(100000).max(5000000).optional(),
        remove_sky: z.boolean().optional(),
        confidence_percentile: z.number().min(0).max(50).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'world', projectId, request }),
  );
  server.registerTool(
    'forge_stage_video_reference',
    {
      description:
        'Snapshot a project image for video. Also usable for image renders; forge_stage_reference provides the same operation.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, path }) => write(`/api/projects/${projectId}/references/from-asset`, { path }),
  );
  server.registerTool(
    'forge_stage_video_clip',
    {
      description:
        'Snapshot a project video (WebM or MP4, up to 64 MiB) or audio file (WAV, MP3, FLAC, OGG or Opus, up to 32 MiB) for use as an H3 reference clip. Returns an ID for forge_queue_video reference_videos or reference_audios. Use forge_projects to discover the project-relative asset path.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, path }) => write(`/api/projects/${projectId}/clips/from-asset`, { path }),
  );
  server.registerTool(
    'forge_queue_video',
    {
      description:
        'Queue an H3 (MiniMax Ref2VA) video render. source "references" (default) builds the video from 1–9 staged reference images, optionally with up to 3 reference_videos (a motion or look to follow, 3 seconds used, called <Video 1>...) and up to 3 reference_audios (a voice to follow, up to 15 seconds, called <Audio 1>...); the prompt refers to images as <Picture 1>, <Picture 2>... in order. source "frames" starts from first_frame (a staged image, required) and optionally ends on last_frame; it cannot be combined with references. source "text" renders from the prompt alone (experimental). aspect landscape, square, portrait, photo (4:3), photo-portrait (3:4) or cinema (21:9); resolution standard (about 0.2 megapixels, the tested default), medium, large or hd (1344 x 768, very slow, untested on this PC). frames must be 17 x n + 5 up to 362 (56, 124, 175, 243 and 311 are about 2, 5, 7, 10 and 13 seconds; 24 fps is fixed by the engine). The video carries generated stereo sound. Optional experimental controls: cfg_scale above 1 with a negative_prompt (the model normally runs unguided and guidance doubles the render time), turbo (a 4-step LoRA adapter), sampler, scheduler, max_vram (GiB of GPU memory for weights, default 6), reference_detail max (full-size references). also_mp4 saves an H.264 copy beside the WebM. Forge checks free GPU memory and saves the video into the selected project. A GPU check is not a reservation. Restart the video engine once after updating Forge, or the new options are refused with a clear message.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        references: z.array(z.string()).max(9).default([]),
        source: z.enum(['references', 'frames', 'text']).default('references'),
        first_frame: z
          .string()
          .optional()
          .describe('Staged image ID; required for source "frames".'),
        last_frame: z.string().optional().describe('Staged image ID the clip should end on.'),
        reference_videos: z.array(z.string()).max(3).optional(),
        reference_audios: z.array(z.string()).max(3).optional(),
        use_clip_audio: z
          .boolean()
          .optional()
          .describe('Also give the soundtrack of each reference video (all must have sound).'),
        aspect: z.enum(Object.keys(VIDEO_ASPECTS)).default('landscape'),
        resolution: z.enum(Object.keys(VIDEO_RESOLUTIONS)).default('standard'),
        frames: z
          .number()
          .int()
          .min(22)
          .max(MAX_VIDEO_FRAMES)
          .refine(validFrameCount, 'Use 17 x n + 5 frames, for example 56, 124, 175, 243 or 311.')
          .default(124),
        steps: z.number().int().min(4).max(30).optional(),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2147483647)
          .optional()
          .describe('Optional. Omit for a random seed, which Forge records with the video.'),
        negative_prompt: z.string().max(4000).optional(),
        cfg_scale: z.number().min(1).max(6).optional(),
        turbo: z.boolean().optional().describe('4-step adapter; steps must then be 4 or 8.'),
        sampler: z.enum(['euler', 'res_multistep']).optional(),
        scheduler: z.enum(['simple', 'beta', 'discrete']).optional(),
        max_vram: z.number().int().min(4).max(24).optional(),
        reference_detail: z.enum(['match', 'max']).optional(),
        also_mp4: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'video', projectId, request }),
  );
  server.registerTool(
    'forge_estimate_render',
    {
      description:
        'Estimate elapsed time from completed jobs with matching settings; returns the sample count and reports when no history is available.',
      inputSchema: {
        type: z.enum([
          'images',
          'music',
          'sfx',
          'video',
          'voices',
          '3d',
          'trellis',
          'segmentation',
          'motion',
          'motion-bricks',
          'world',
        ]),
        projectId: z.string().uuid(),
        request: z.record(z.string(), z.unknown()),
      },
      annotations: readonly,
    },
    (input) => write('/api/runtime/estimate', input),
  );
  server.registerTool(
    'forge_load_music_model',
    {
      description:
        'Request loading YuE2 in its already-running service after checking GPU memory. If memory is insufficient, returns identified loaded models and which are available for controlled offloading.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/music/load', {}),
  );
  server.registerTool(
    'forge_load_sound_model',
    {
      description:
        'Request loading Stable Audio in its already-running service after checking GPU memory. Uses credentials already configured in the engine; enter new credentials only in Studio settings, not through MCP.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/sfx/load', {}, 25000),
  );
  server.registerTool(
    'forge_load_voice_model',
    {
      description:
        'Request loading Qwen3-TTS in its already-running service after checking GPU memory.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/tts/load', {}, 25000),
  );
  server.registerTool(
    'forge_load_hunyuan_model',
    {
      description:
        'Load the Hunyuan3D shape model in its already-running worker after checking GPU and host memory.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/3d-hunyuan/load', {}, 25000),
  );
  server.registerTool(
    'forge_load_trellis_model',
    {
      description:
        'Load the experimental TRELLIS.2 model in its running worker after checking GPU and system memory.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/3d-trellis/load', {}, 25000),
  );
  server.registerTool(
    'forge_clear_trellis_load_barrier',
    {
      description:
        'Clear a stuck TRELLIS.2 model-load barrier only after verifying its worker is not loading.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/3d-trellis/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_load_sam31_model',
    {
      description: 'Load SAM 3.1 in its already-running worker after checking GPU and host memory.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/segmentation/load', {}, 25000),
  );
  server.registerTool(
    'forge_load_hymotion_model',
    {
      description:
        'Load HY-Motion and its text encoders in the running worker after GPU and host-memory checks.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/motion-hy/load', {}, 25000),
  );
  server.registerTool(
    'forge_clear_hymotion_load_barrier',
    {
      description:
        'Clear a stuck HY-Motion model-load barrier only after verifying the worker is no longer loading.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/motion-hy/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_load_motionbricks_model',
    {
      description:
        'Load the MotionBricks SOMA model in the running worker after GPU and system-memory checks.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/motion-bricks/load', {}, 25000),
  );
  server.registerTool(
    'forge_clear_motionbricks_load_barrier',
    {
      description:
        'Clear a stuck MotionBricks load barrier only after verifying the worker is no longer loading.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/motion-bricks/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_clear_sam31_load_barrier',
    {
      description:
        'Clear a stuck SAM model-load barrier only after verifying the worker is no longer loading.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/segmentation/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_clear_hunyuan_load_barrier',
    {
      description:
        'Clear a stuck Hunyuan load barrier only after verifying the worker is no longer loading.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/3d-hunyuan/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_load_asr_model',
    {
      description:
        'Start Nemotron streaming speech recognition after checking GPU memory; the render queue waits until model loading completes.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/asr/load', {}, 25000),
  );
  server.registerTool(
    'forge_transcribe_project_audio',
    {
      description:
        'Transcribe a WAV asset inside a Forge project using the running Nemotron ASR service. Start it with forge_load_asr_model first. Returns text without changing the asset. Optional: punctuation (default true; false gives lowercase text without punctuation), wordTimestamps (adds words with start and end seconds from the model token timeline: approximate, can be off by up to about a second). The English-only model has no language setting; word boosting, profanity masking, spoken-number formatting and speaker labels are not available with the installed model file.',
      inputSchema: {
        projectId: z.string().uuid(),
        path: z.string().min(1).max(1000),
        punctuation: z.boolean().optional(),
        wordTimestamps: z.boolean().optional(),
      },
      annotations: readonly,
    },
    (input) => write('/api/runtime/asr/transcribe', input, 130000),
  );
  server.registerTool(
    'forge_clear_asr_load_barrier',
    {
      description:
        'Clear a stuck ASR loading barrier only after verifying the worker is no longer loading. Do not infer this from a timeout.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/asr/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_clear_music_load_barrier',
    {
      description:
        'Clear a stuck queue barrier only after the user has verified YuE2 is neither loading nor queued to load. Never infer that confirmation from a timeout.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/music/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_clear_sound_load_barrier',
    {
      description:
        'Clear a stuck queue barrier only after the user has verified Stable Audio is not loading. Never infer that confirmation from a timeout.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/sfx/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_clear_voice_load_barrier',
    {
      description:
        'Clear a stuck queue barrier only after the user has verified Qwen3-TTS is not loading. Never infer that confirmation from a timeout.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/tts/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_start_engines',
    {
      description:
        'Start the image, music, sound, video, voice, Hunyuan shape, SAM, and HY-Motion services without loading models. Already-running services are left running.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/engines/start-all', {}),
  );
  server.registerTool(
    'forge_offload_model',
    {
      description:
        'Stop a supported idle engine started by this Forge runtime, releasing its model from memory. Does not delete files. Externally started or busy engines are not stopped.',
      inputSchema: {
        id: z.enum([
          'images',
          'music',
          'sfx',
          'tts',
          '3d-hunyuan',
          '3d-trellis',
          'segmentation',
          'motion-hy',
          'motion-bricks',
          'asr',
          'game',
        ]),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ id }) => write(`/api/runtime/models/${id}/offload`, {}, 35000),
  );
  server.registerTool(
    'forge_load_game_model',
    {
      description:
        'Start and load the Forge-managed Mammoth decision engine after checking GPU memory. Existing external Mammoth services are left untouched.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () => write('/api/runtime/models/game/load', {}, 20000),
  );
  server.registerTool(
    'forge_clear_game_load_barrier',
    {
      description:
        'Clear a stuck Mammoth model-load barrier only after verifying Mammoth is no longer loading. Never infer this from a timeout.',
      inputSchema: { confirmNotLoading: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    (input) => write('/api/runtime/models/game/clear-load-barrier', input),
  );
  server.registerTool(
    'forge_cancel_queued_job',
    {
      description:
        'Cancel a job that is queued, waiting, or needs attention; does not cancel running renders or a model load already requested.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id }) => write(`/api/runtime/jobs/${id}/cancel`, {}),
  );
  server.registerTool(
    'forge_retry_job',
    {
      description:
        'Retry a failed or blocked job. If it has an engine job ID, Forge rechecks that existing job instead of submitting another render. Interrupted jobs require manual review.',
      inputSchema: { id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ id }) => write(`/api/runtime/jobs/${id}/retry`, {}),
  );
  server.registerTool(
    'forge_game_decide',
    {
      description:
        'Ask the local Mammoth-1 System One service for a structured game decision. The service must already be running and its model loaded.',
      inputSchema: {
        state: z.unknown().optional(),
        model: z.string().default('mammoth-1'),
        questions: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input) => write('/api/runtime/game/decide', input, 65000),
  );
  return server;
}
