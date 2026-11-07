// Shared tool definitions for the local HTTP and stdio MCP transports.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

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
  async function write(path, body, timeout = 10000) {
    try {
      const response = await fetch(new URL(path, base), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forge-Request':
            path === '/api/projects' || path.startsWith('/api/projects/') ? 'project' : 'runtime',
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
        'Queue one YuE2 music render in a project. Forge starts and loads YuE2 on demand after a GPU memory check; inspect waiting_memory jobs for offload choices. Lyrics and style are required. Negative style affects generation when guidance is not 1.',
      inputSchema: {
        projectId: z.string().uuid(),
        style: z.string().min(1).max(2000),
        lyrics: z.string().min(1).max(20000),
        duration_seconds: z.number().min(1).max(600).default(15),
        seed: z.number().int().nonnegative().default(831001),
        cot: z.enum(['full', 'melody', 'off']).default('full'),
        title: z.string().max(200).default(''),
        ode_steps: z.number().int().min(1).max(100).default(32),
        negative: z.string().max(2000).default(''),
        cfg_scale: z.number().min(0).max(20).nullable().default(null),
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
        'Queue one Stable Audio sound effect in a project. Forge starts the worker and requests a model load on demand after checking GPU memory. If access is needed, use the Studio model settings; do not send tokens through MCP.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        duration: z.number().min(1).max(380).default(5),
        steps: z.number().int().min(1).max(50).default(8),
        seed: z.number().int().min(-1).max(2147483647).default(-1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) => write('/api/runtime/jobs', { type: 'sfx', projectId, request }),
  );
  server.registerTool(
    'forge_queue_voice',
    {
      description:
        'Queue buffered Qwen3-TTS speech using a preset speaker and optional direction. This initial integration does not stream audio or clone voices.',
      inputSchema: {
        projectId: z.string().uuid(),
        text: z.string().min(1).max(1000),
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
        max_new_tokens: z.number().int().min(64).max(2048).default(1024),
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
        'Queue an untextured Hunyuan3D shape from one staged reference image. Forge starts and loads the model after GPU and host-memory checks.',
      inputSchema: {
        projectId: z.string().uuid(),
        reference: z.string().min(1),
        seed: z.number().int().min(0).max(2147483647).default(123),
        steps: z.number().int().min(1).max(100).default(30),
        resolution: z.union([z.literal(128), z.literal(256), z.literal(384)]).default(128),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, reference, ...request }) =>
      write('/api/runtime/jobs', {
        type: '3d',
        projectId,
        request: { ...request, references: [reference] },
      }),
  );
  server.registerTool(
    'forge_queue_trellis',
    {
      description:
        'Queue an experimental TRELLIS.2 512 textured GLB from one staged transparent PNG or WebP. A full render is not yet verified. Forge checks GPU and system memory; image segmentation can prepare transparent inputs.',
      inputSchema: {
        projectId: z.string().uuid(),
        reference: z.string().min(1),
        seed: z.number().int().min(0).max(2147483647).default(42),
        steps: z.number().int().min(1).max(50).default(12),
        texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048)]).default(1024),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, reference, ...request }) =>
      write('/api/runtime/jobs', {
        type: 'trellis',
        projectId,
        request: { ...request, references: [reference] },
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
        'Queue a Qwen image render with up to 10 staged references. Optional negative_prompt requires true_cfg_scale greater than 1 and increases render time; omit both for the model default. Forge checks GPU memory before loading.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        width: z.number().int().min(32).max(2048).multipleOf(32).default(1024),
        height: z.number().int().min(32).max(2048).multipleOf(32).default(1024),
        num_inference_steps: z.number().int().min(1).max(100).default(40),
        references: z.array(z.string()).max(10).default([]),
        seed: z.number().int().nonnegative().optional(),
        negative_prompt: z.string().max(4000).optional(),
        true_cfg_scale: z.number().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ projectId, ...request }) =>
      write('/api/runtime/jobs', { type: 'images', projectId, request }),
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
        'Queue a CUDA world render. WorldGen accepts text, one image, or one panorama; HY-World reconstructs 1–8 staged image views. Seed and steps apply to WorldGen text and image generation. Output is a PLY in the project 3D folder.',
      inputSchema: {
        projectId: z.string().uuid(),
        model: z.enum(['worldgen', 'hy-world']),
        mode: z.enum(['text', 'image', 'panorama']),
        prompt: z.string().max(4000).default(''),
        output: z.enum(['splat', 'mesh']).default('splat'),
        resolution: z.number().int(),
        references: z.array(z.string()).max(8).default([]),
        seed: z.number().int().min(0).max(2147483647).default(42),
        steps: z.number().int().min(10).max(60).default(50),
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
    'forge_queue_video',
    {
      description:
        'Queue an H3 video render with 1–9 staged reference IDs. Forge checks free GPU memory, and saves the video into the selected project. A GPU check is not a reservation.',
      inputSchema: {
        projectId: z.string().uuid(),
        prompt: z.string().min(1).max(4000),
        references: z.array(z.string()).min(1).max(9),
        aspect: z.enum(['landscape', 'square', 'portrait']).default('landscape'),
        frames: z
          .union([z.literal(56), z.literal(124), z.literal(175), z.literal(243)])
          .default(124),
        steps: z.union([z.literal(8), z.literal(12), z.literal(20), z.literal(30)]).default(12),
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
        'Transcribe a WAV asset inside a Forge project using the running Nemotron ASR service. Start it with forge_load_asr_model first. Returns text without changing the asset.',
      inputSchema: { projectId: z.string().uuid(), path: z.string().min(1).max(1000) },
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
