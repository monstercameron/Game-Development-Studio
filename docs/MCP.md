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
| Read how an asset was made, or find assets by prompt or model                                              | `forge_asset_details`, `forge_search_asset_details`                                                                                                                                                                                                                                                                                                                                                   |
| 3D from a picture or a description; higher TRELLIS.2 pipelines                                             | `forge_queue_text_to_3d`; `removeBackground` on `forge_queue_trellis` and `forge_queue_hunyuan_shape` (SAM 3.1 cutout, then a chained 3D job); `pipeline` (`512`, `1024`, `1024_cascade`, `1536_cascade`) on `forge_queue_trellis`; `texture_views` and `texture_view_size` on `forge_queue_hunyuan_shape`. These queue two chained jobs through `POST /api/runtime/jobs/chain`; see the Studio guide |
| Convert a project image, audio, video or 3D file                                                           | `forge_convert_asset` (video to `mp4` or `gif`; 3D between `glb`, `gltf`, `obj`, `ply`, `stl`)                                                                                                                                                                                                                                                                                                        |
| Save text                                                                                                  | `forge_save_text_asset` (transcript, chat, or JSON decision; optional `model` and `prompt` are recorded as its generation details)                                                                                                                                                                                                                                                                    |
| Prepare inputs and generate                                                                                | `forge_stage_reference`, `forge_stage_video_clip` (reference video or audio for H3), `forge_stage_soma_pose`, and the `forge_queue_*` tools; check `forge_models` for supported workflows                                                                                                                                                                                                             |
| Image variations and LoRA; extend or re-synthesize music; start a sound from another sound; speech latency | `forge_queue_image` (`variations`, `lora`, `lora_scale`, `output_resolution`, `use_kv_cache`, `sigmas`), `forge_image_loras`, `forge_extend_music`, `forge_resynth_music`, `forge_stage_audio_source` then `forge_queue_sound` (`source_audio`, `edit_mode`), `forge_asr_latency`, `forge_set_asr_latency`                                                                                            |
| Monitor and manage the render queue                                                                        | `forge_jobs`, `forge_job`, `forge_estimate_render`, `forge_estimate_queue`, `forge_cancel_queued_job`, `forge_retry_job`, `forge_clear_waiting_jobs`, `forge_resolve_interrupted_job`                                                                                                                                                                                                                 |
| Manage models                                                                                              | `forge_start_engines`, `forge_load_*`, `forge_offload_model`, `forge_close_model`, `forge_force_stop_model`, `forge_remove_managed_model`                                                                                                                                                                                                                                                             |
| Chat and structured responses                                                                              | `forge_chat_models`, `forge_estimate_chat_memory`, `forge_load_chat_model`, `forge_chat`                                                                                                                                                                                                                                                                                                              |
| Speech and game decisions                                                                                  | `forge_transcribe_project_audio`, `forge_game_decide`                                                                                                                                                                                                                                                                                                                                                 |
| Diagnose the service and manage wakefulness                                                                | `forge_diagnostics`, `forge_logs`, `forge_runtime_health`, `forge_power_status`, `forge_set_keep_awake`                                                                                                                                                                                                                                                                                               |

`forge_projects` returns project IDs, local project folders, asset-relative paths,
and download URLs. `forge_view_thumbnail` returns the cached image created by the
Studio; it does not generate a missing thumbnail. `forge_read_text_asset` accepts
indexed text and JSON assets up to 400 KB. Use the project's asset URL for other
files; MCP does not embed arbitrarily large media.

`forge_asset_details` returns the model, prompt, settings, seed, references, and timing recorded for an asset (or `metadata: null`), recovering older assets from render history when possible. `forge_search_asset_details` finds asset paths whose prompt or model name matches given words.

To generate, select or create a project, stage existing project references if the
model needs them, call the matching queue tool, and poll `forge_job`. Estimates use
completed render history when available and are not guarantees. A retry of a job
with a remote ID checks that existing job; it does not automatically generate a
new variation. Submit a new request with a different seed for a new render.

`forge_chat` supports local compatible servers and OpenAI, text/JSON/JSON Schema
output, thinking effort, temperature, and a maximum output token count. It waits for
the streaming response and returns the response text, usage when the provider
supplies it, time to first token, and a completion-rate estimate. The stream must
finish successfully and is limited to 2 MB. Provider support for thinking,
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
