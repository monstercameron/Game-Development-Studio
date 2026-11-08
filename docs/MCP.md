# Agent access through MCP

Forge offers the same MCP tools over Streamable HTTP at `http://127.0.0.1:5173/mcp`
and the stdio bridge in `runtime/mcp.js`. Both use the shared tool registry and require
the 2026-07-28 MCP protocol. Start Forge first; the bridge only connects to a local
HTTP Studio origin. Restart the Studio service after updating its MCP implementation.
Use the client's `tools/list` for the current input schemas and descriptions.

## Workflows

| Task                                                                                                       | Tools                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover models and their inputs, outputs, and current observations                                        | `forge_models`, `forge_services`, `forge_hardware`, `forge_model_storage`                                                                                                                                                                                                                                                                                                                             |
| Create a project and find its assets                                                                       | `forge_create_project`, `forge_projects`                                                                                                                                                                                                                                                                                                                                                              |
| Inspect and organize an asset                                                                              | `forge_read_text_asset`, `forge_view_thumbnail`, `forge_update_asset`, `forge_rename_asset`, `forge_trash_asset`, `forge_project_trash`, `forge_restore_asset`, `forge_clear_project_trash`                                                                                                                                                                                                           |
| Search the Megascans cache, read more from Fab slowly, check imports                                       | `forge_megascans_search`, `forge_megascans_listing`, `forge_megascans_refresh`, `forge_megascans_scan`, `forge_megascans_add_listing`, `forge_megascans_download`, `forge_megascans_downloads`
| Grow procedural trees and shrubs (SeedThree, CPU only, no model): check readiness, read species and controls, queue plants | `forge_vegetation_status`, `forge_vegetation_schema`, `forge_queue_vegetation` |
| Review captured errors and stack traces (redacted, read-only)                                              | `forge_errors_list`, `forge_error_detail`                                                                                                                                                                                                                                                                                                                                                             |
| Read how an asset was made, or find assets by prompt or model                                              | `forge_asset_details`, `forge_search_asset_details`                                                                                                                                                                                                                                                                                                                                                   |
| 3D from a picture or a description; higher TRELLIS.2 pipelines                                             | `forge_queue_text_to_3d`; `removeBackground` on `forge_queue_trellis` and `forge_queue_hunyuan_shape` (SAM 3.1 cutout, then a chained 3D job); `pipeline` (`512`, `1024`, `1024_cascade`, `1536_cascade`) on `forge_queue_trellis`; `texture_views` and `texture_view_size` on `forge_queue_hunyuan_shape`. These queue two chained jobs through `POST /api/runtime/jobs/chain`; see the Studio guide |
| Convert a project image, audio, video or 3D file                                                           | `forge_convert_asset` (video to `mp4` or `gif`; 3D between `glb`, `gltf`, `obj`, `ply`, `stl`)                                                                                                                                                                                                                                                                                                        |
| Save text                                                                                                  | `forge_save_text_asset` (transcript, chat, or JSON decision; optional `model` and `prompt` are recorded as its generation details)                                                                                                                                                                                                                                                                    |
| Prepare inputs and generate                                                                                | `forge_stage_reference`, `forge_stage_video_clip` (reference video or audio for H3), `forge_stage_soma_pose`, and the `forge_queue_*` tools; check `forge_models` for supported workflows                                                                                                                                                                                                             |
| Image variations and LoRA; extend or re-synthesize music; start a sound from another sound; speech latency | `forge_queue_image` (`variations`, `lora`, `lora_scale`, `output_resolution`, `use_kv_cache`, `sigmas`), `forge_image_loras`, `forge_extend_music`, `forge_resynth_music`, `forge_stage_audio_source` then `forge_queue_sound` (`source_audio`, `edit_mode`), `forge_asr_latency`, `forge_set_asr_latency`                                                                                            |
| Monitor and manage the render queue                                                                        | `forge_jobs`, `forge_job`, `forge_estimate_render`, `forge_estimate_queue`, `forge_cancel_queued_job`, `forge_move_job`, `forge_retry_job`, `forge_clear_waiting_jobs`, `forge_resolve_interrupted_job`                                                                                                                                                                                                                 |
| Manage models                                                                                              | `forge_start_engines`, `forge_load_*`, `forge_offload_model`, `forge_close_model`, `forge_force_stop_model`, `forge_remove_managed_model`                                                                                                                                                                                                                                                             |
| Chat and structured responses                                                                              | `forge_chat_models`, `forge_estimate_chat_memory`, `forge_load_chat_model`, `forge_chat`                                                                                                                                                                                                                                                                                                              |
| Speech and game decisions                                                                                  | `forge_transcribe_project_audio`, `forge_game_decide`                                                                                                                                                                                                                                                                                                                                                 |
| Diagnose the service and manage wakefulness                                                                | `forge_diagnostics`, `forge_logs`, `forge_runtime_health`, `forge_power_status`, `forge_set_keep_awake`                                                                                                                                                                                                                                                                                               |

`forge_projects` returns project IDs, local project folders, asset-relative paths,
and download URLs. `forge_view_thumbnail` returns the cached image created by the
Studio; it does not generate a missing thumbnail. `forge_read_text_asset` accepts
indexed text and JSON assets up to 400 KB. Use the project's asset URL for other
files; MCP does not embed arbitrarily large media.

`forge_queue_vegetation` takes a `projectId`, a `species` key from `forge_vegetation_schema`, an optional `seed` (1 to 9999; the same seed and settings give the same plant), a `budget` (`low`, `medium` or `high`, the level of detail exported), `params` (control values keyed by the control ids that `forge_vegetation_schema` returns for that species; unknown ids and out-of-range values are rejected) and `variations` (1 to 4 sibling plants with consecutive seeds, queued as one job each). It runs on the CPU in a separate process and needs no model, GPU memory or engine; the queue still runs one render at a time. Each job saves `3d/forge-<job id>.glb` (flat standard materials, no textures, wind or billboards) and `3d/forge-<job id>.preset.json` (a SeedThree preset); read the result with `forge_job` and `forge_asset_details`, which records the species, seed, controls, triangle counts and SeedThree commit. `forge_vegetation_status` reports whether the linked SeedThree repository is fetched and current. There is deliberately no tool that fetches it: the person presses Fetch SeedThree on the Vegetation page or runs `install.ps1 -Vegetation`. See [Vegetation](VEGETATION.md).

The Megascans tools work on Forge's local cache of free Quixel Megascans 3D models from Fab. `forge_megascans_search` and `forge_megascans_listing` read only the cache (no request to Fab); a listing's `detail.groups` lists its downloadable files with `uid`, `quality`, `size` and `isLarge`. `forge_megascans_refresh` reads page one of the newest models, or one listing's description and file list, from Fab (slow, at most once a minute, cached). `forge_megascans_scan` starts, resumes, cancels or reports the capped background catalog scan. If Fab blocks Forge these return `blocked: true`; stop and tell the user, do not retry. `forge_megascans_add_listing` saves a listing from an address the user supplied. `forge_megascans_download` queues a download of one file (by `fileUid`, or `format` glb, gltf, fbx or ue plus `quality`; the recommended default is glb at mid) into a project; it **refuses with `needsConfirmation` until the user has ticked the Fab license-agreement checkbox on the Megascans page**, there is no tool to tick it for them, and files over 100 MB need `confirmLarge: true` only after the user agreed to that size. `forge_megascans_downloads` shows the queue (statuses `queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`; at most 2 run at once; `source` is `fab` for downloads Forge made and `upload` for files the user imported). See [Megascans](MEGASCANS.md).

`forge_asset_details` returns the model, prompt, settings, seed, references, and timing recorded for an asset (or `metadata: null`), recovering older assets from render history when possible. `forge_search_asset_details` finds asset paths whose prompt or model name matches given words.

To generate, select or create a project, stage existing project references if the
model needs them, call the matching queue tool, and poll `forge_job`. Estimates use
completed render history when available and are not guarantees. A retry of a job
with a remote ID checks that existing job; it does not automatically generate a
new variation. Submit a new request with a different seed for a new render. The
one exception is a SAM segmentation that failed with the engine's own answer (for
example "No matching objects were found"): `forge_retry_job` then clears the old
engine job and queues a fresh attempt, because that outcome is final and a
restarted SAM worker no longer remembers the old job.

`forge_move_job` changes when a waiting render starts. Give the render `id` and exactly one of `to` (`next` or `top` for first in the waiting line, `end` for last), `before` or `after` (another waiting render's ID) or `direction` (`up` or `down` one place). Only renders that are queued, waiting for their engine or waiting for memory, and have no engine job yet, can move; running, preparing, interrupted, needs-attention, failed, cancelled and finished renders are refused with a 409 and `code: "not_movable"`. The new order applies to the next render to start and never interrupts a running one. A render that uses the result of an earlier render is placed right after it (the answer sets `clamped`), and renders that wait for a moved render move with it (`carried`). Pass `expectedRank` (the `queueRank` from `forge_jobs`, or `null` for an older row) to make the move conditional: if someone else moved that render first the answer is a 409 `stale` carrying the current `order` and `ranks` and nothing changes. The answer lists the waiting render IDs in their new order. `forge_jobs` and `forge_estimate_queue` already follow that order.

`forge_queue_segmentation` takes `output` (`transparent`, `mask`, `outline` or
`cropped`), `confidence`, and `select`, which chooses the matches SAM found to
keep: `all` (default, every match combined), `best` (highest score), `largest`
(most pixels) or `top` (the `max_instances` highest scores, 1 to 50; required with
`top`, rejected otherwise). `outline` saves the original with each kept match
outlined; `cropped` saves a transparent cutout trimmed to the kept matches. Only
`transparent` and `cropped` cutouts can feed a chained 3D job. When the job
completes, `forge_job` returns `details.result` with `found`, `used`, `scores`
(up to 20, best first) and `usedScores`; jobs recovered after a worker restart have
none. `select` and the two new outputs need a SAM worker started after this
update (it lists `match-selection` in `/api/status` `features`); an older worker
makes the job fail before submission, so stop the SAM 3.1 engine, start it again
and retry. Box and point prompts, several descriptions per image and video
tracking are not available.

`forge_chat` supports local compatible servers and OpenAI, text/JSON/JSON Schema
output, thinking effort, temperature, and a maximum output token count. It waits for
the streaming response and returns the response text, usage when the provider
supplies it, time to first token, and a completion-rate estimate. The stream must
finish successfully and is limited to 2 MB. Optional `images` (up to four project
asset paths, PNG, JPEG or WebP, 8 MiB each, plus `projectId`) are attached to the last
user message; they work only with the local Qwen engine started with its vision
projector and are refused for OpenAI and other servers. Provider support for thinking,
structured output, usage, and speculative decoding varies. Context size and
speculative decoding are launch settings, so changing them requires a model restart.
Use a saved Studio credential or the server's environment for OpenAI; never put an
API key in MCP arguments. A cloud chat request sends its conversation to that provider.

Stopping and removal are separate actions. Gentle close checks activity and process
identity; force stop can interrupt active work and requires the literal confirmation
specified by the tool. Bulk cancellation excludes running and uncertain remote jobs.
Only resolve an interrupted job after verifying its remote engine is no longer
running. Permanent model deletion and emptying project trash require their own
explicit confirmations. Ask the user before destructive actions.

Browser-only settings such as notifications, panel navigation, and realtime
microphone capture are not exposed as MCP tools. The project WAV transcription tool
is buffered rather than realtime. Availability of a tool does not establish that its
model is installed, loaded, or that a particular generation workflow has been verified.
