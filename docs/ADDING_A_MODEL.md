# Adding a model or engine

This is an ordered checklist for integrating a new model into Forge, written from how the existing models were integrated. It names the files to touch and why. It does not promise that any step is small: a GPU model touches the installer, the engine table, the durable queue, the admission code, the UI, MCP, the docs and the project site.

Read first: [AGENTS.md](../AGENTS.md), the [code style guide](CODE_STYLE.md), the [runtime map](../runtime/README.md), [Windows ARM64 notes](WINDOWS_ARM64.md) and [Model sources](MODEL_SOURCES.md). If you add a page or service without a model, use [Adding a feature](ADDING_A_FEATURE.md). Planned integrations and their feasibility notes are in the [roadmap](ROADMAP.md); start from the entry for your model if it has one.

Line endings matter here: `runtime/jobs.js`, `runtime/engines.js`, `runtime/supervisor.js`, `runtime/service-preparation.js` and `src/main.jsx` are CRLF. Detect and preserve them ([Line endings](CODE_STYLE.md#line-endings-the-repository-is-mixed)).

## Four worked examples

The checklist below refers to these four integrations. They differ in how much of the system they use.

| Example                                      | Kind                                             | What it shows                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SAM 3.1** (`segmentation`)                 | Engine-backed GPU model; the main example        | Gated weights, a separately supervised Python worker, load and offload, memory admission, a queue job type, a creation panel, MCP tools, removal, a site card. Files: `runtime/sam31_worker.py`, `runtime/sam31_backend.py`, `runtime/sam31-preparation.js`, `runtime/sam31-job.js`, `runtime/sam31-options.js`.                                                                                                  |
| **HY-Motion** (`motion`, engine `motion-hy`) | Engine-backed GPU model; a second path           | Same shape, but the job type (`motion`) differs from the engine id (`motion-hy`), output is a BVH clip, and the controls are a separate component. Files: `runtime/hymotion_worker.py`, `runtime/hymotion_backend.py`, `runtime/hymotion-preparation.js`, `runtime/hymotion-job.js`, `src/HyMotionControls.jsx`, `src/hymotion-settings.js`.                                                                      |
| **SeedThree** (`vegetation`)                 | CPU only, linked source, no engine, no GPU       | A pinned third-party repository fetched on request, an isolated child process, a job type that skips engine health and memory admission. Files: `runtime/vegetation-checkout.js`, `runtime/vegetation-adapter.js`, `runtime/vegetation-runner.js`, `runtime/vegetation-child.js`, `runtime/vegetation-job.js`, `runtime/vegetation-request.js`, `runtime/vegetation-service.js`. See [Vegetation](VEGETATION.md). |
| **Megascans** (Fab)                          | Pure external service, no model, no render queue | A polite read-only HTTP client, its own SQLite database and its own small import queue, a service under `/api/megascans`, a page, MCP tools with a consent gate. Files: `runtime/megascans-service.js`, `runtime/megascans-fab.js`, `runtime/megascans-queue.js`, `src/Megascans.jsx`. See [Megascans](MEGASCANS.md).                                                                                             |

Use the SAM 3.1 path as your template for a GPU model, the SeedThree path for local code that needs no GPU, and the Megascans path when the "model" is an outside service.

## Step 0: feasibility, licence and gating (before any code)

1. **Platform check against [Windows ARM64 notes](WINDOWS_ARM64.md).** Forge runs native Windows ARM64 with an NVIDIA GPU. Compare the model's requirements with what the notes record (the Python versions and PyTorch CUDA builds it lists, Triton for Windows, the native extensions that were hand-built for TRELLIS.2). Do a dry import in the target environment before you commit to a model. If it cannot run natively, record why in the roadmap entry. **No WSL. No silent CPU inference.** CPU work is allowed only for preprocessing and file operations.
2. **Licence and gating.** Read the model card and code licence. Record: the licence, whether the weights are gated (SAM 3.1 and DINOv3 need approved access), non-commercial terms (FLUX.1 dev, Tencent Hunyuan non-commercial for Paint), and anything the user must accept. A gated model must say so in the UI (`modelNotes` in `src/Models.jsx`), the installer notes and [Model sources](MODEL_SOURCES.md). Never put a token in a command, manifest, source file or log.
3. **Size and memory.** Estimate the weights on disk, GPU memory to load and to render, and host memory. These are estimates until you measure them; write them as budgets with that wording (`SAM31_GPU_LOAD_MIB` in `runtime/sam31-preparation.js` says "conservative estimates, not reservations").
4. **Decide the shape.** GPU model with a worker (SAM path)? CPU library with a child process (SeedThree path)? Outside service (Megascans path)? The shape decides which of the steps below apply.

## Step 1: pin the source

Everything that is downloaded must be pinned and reproducible, and nothing may download as a side effect of a render.

- **Weights: `install-models.json`.** Add an object to `models` with `id`, `name`, `sources` (URLs), `destination` (documentation text, e.g. `models/sam3.1`), `notes`, and `downloads`. Each download has `repo`, a full `revision` commit, a safe `destination` (only `[A-Za-z0-9._/-]`, no `..`; the installer enforces this), `files` or `include`, and for one representative file `sha256File` plus `sha256`. Optional extras that are not part of the default set get `"optional": true` and are only staged when named explicitly (`tts-base`, `tts-voicedesign`). Entries with no `downloads` are treated as manual setup.
- **Linked repository (no weights): `linkedRepositories`** in the same file, with `id`, `name`, `repository`, `commit`, `license`, `destination` (under `external/`) and `summary`. SeedThree is the example. Also add the git submodule entry in `.gitmodules` pointing at the same commit; the two must agree. The fetch is an explicit action (`runtime/vegetation-checkout.js`, a page button, or an installer flag).
- **Document it in [Model sources](MODEL_SOURCES.md):** a row in the inventory table (folder, upstream files, recorded revision, representative SHA-256), the restore command in the download-commands block, any companion-application change, any compatibility patch (with upstream source, version, reason and removal condition), and the licence. For a linked repository, add a row to "Linked repositories". A `revision` from a metadata file records provenance; it is not a substitute for rehashing a copied file.
- **Document the user steps in [Installation](INSTALLATION.md)** (the table row: id, sources, what the installer stages, what stays manual).

## Step 2: the installer (`install.ps1`)

- A new model id works with `-Models <id>`, `-Plan` and `-ListModels` as soon as it is in the manifest; no script change is needed for staging.
- For `-Activate` support (copy staged files into `models/`), add the id and its target folder to the `$managedFolders` table in `install.ps1`. Activation only ever creates a new folder and refuses an existing one. Do not add an id whose folder layout needs merging.
- The special order for `-Models all` puts access-sensitive models first (`3d-trellis`, `segmentation`, `sfx`) so a missing approval is found before the large downloads. Add a gated model to that list.
- A linked repository needs its own switch following `-Vegetation` (preview with `-Plan`, fetch without it).
- Tests: `test/installer.test.js`, `test/coverage-installer.test.js`. Inspect them before running; they should not download anything.

## Step 3: catalog, inventory, storage and removal

- **`runtime/model-catalog.js`**: add an entry to `modelCatalog` (descriptive only; it does not imply the model is installed). Fields in use: `id`, optional `serviceId` (when the catalog id differs from the engine id, e.g. `hy-world` to `world`), `name`, `category`, `folder`, `icon`, `tone`, `panel` (the page id), `purpose`, `gpu` (a text estimate), `inputs`, `outputs`, `engine`, `mcpTools`, optional `notes` and `api`. Supporting checkpoints use `role: 'dependency'` and `usedBy`.
- **`runtime/model-inventory.js`**: add `{ id, folder }` to `managedModels` so the asynchronous storage scan measures it. Set `removable: false` for anything shared with a standalone application or another consumer. The scan never follows links and adds each hard-linked name, so its total can exceed `du`; see [CODE_STYLE](CODE_STYLE.md#things-this-repository-learned-the-hard-way).
- **Removal** is opt-in: the id must be in the `removable` set in `buildModelCatalog` (`runtime/model-catalog.js`), in the `removeMatch` pattern in `runtime/supervisor.js`, and in the `id` enum of `forge_remove_managed_model` in `runtime/mcp-server.js`. Removal is journaled and explicitly confirmed (`runtime/model-removal.js`); never make it automatic. These three lists are not identical today (for example `motion-bricks` is in the route pattern and the MCP enum but is `removable: false` in the inventory). The inventory flag decides at removal time, because `runtime/model-removal.js` refuses an entry marked `removable: false`; keep the lists consistent when you add yours.
- Tests: `test/model-catalog.test.js`, `test/model-inventory.test.js`, `test/model-removal.test.js`, `test/model-removal-http.test.js`.

## Step 4: the engine definition (`runtime/engines.js`)

Add an object to `engineDefinitions`. Fields in use by SAM 3.1: `id`, `name`, `port`, `endpoint` (`/api/status`), `kind` (the health-interpreter key), `cwd`, `command` (the environment's `python.exe`), `args` (`-u`, the worker script, `--port`), `env`, and `quiesce` (the stop-guard name, `sam31-v1`). Other flags you may need: `onDemand` (not started with the others), `noRestart` (a restart would bypass a fresh memory check; used by engines that load at startup), `consoleLauncher` (engines whose entry point is outside this repository, wrapped by `runtime/console_launch.py`).

Then the places that key on the engine id:

1. `customEndpoints` (the `FORGE_<NAME>_URL` and optional `_MODEL` variables), and `recoverableGuards` plus the `quiesce` string, which mark the engine recoverable.
2. The three `quiesce` conditions in `EngineManager`: `canOffload`, the `controlToken` creation in `start`, and the id list in `offloadOnce`. A guarded engine gets a per-start control token so only Forge can stop it.
3. `runtime/catalog.js`: the `services` table if the engine is shown there, `configuredOrigins` (the URL variable), and a `case '<kind>'` in the health interpreter that checks the exact engine identity string, `phase`, `loaded` and `model_downloaded` types. **A port alone is not proof of the expected engine.**
4. `runtime/jobs.js`: `engineUrl`, `engineId`, `engineName` for the job type.
5. `runtime/recover-service.js`: the definition for a worker that Forge may restart after a crash, and `engines.autoStart.<name>` in `runtime/core-settings.js` (the `ENGINE_AUTO_START` list). Add `autoStartSetting('<name>')` in `runtime/worker.js` (Step 6).
6. `runtime/diagnostics.js`: the engine log file entry (`engine-<id>.log`) and the port list, so logs and status appear in Diagnostics and the Errors review reads them.
7. Windows launch behavior is automatic: `runtime/engine-launch.js` replaces a venv launcher with the base interpreter, and your worker must import `engine_identity` so the hidden console is attached ([Windows ARM64 notes](WINDOWS_ARM64.md#how-engines-are-launched-on-windows-no-console-windows)).

Pick a port that is free in `engineDefinitions` and `runtime/diagnostics.js` (8284 SAM, 8285 TRELLIS.2, 8286 HY-Motion, 8287 MotionBricks, 8288 World are taken). Bind `127.0.0.1` only.

## Step 5: the Python worker (`runtime/<name>_worker.py`, `runtime/<name>_backend.py`)

Use `runtime/sam31_worker.py` as the template. The backend (`runtime/sam31_backend.py`) is pure model code; the worker owns the HTTP service, busy state and lifecycle.

- FastAPI app on `127.0.0.1`. Endpoints: `GET /api/status` returning at least `engine` (the identity string, e.g. `forge-sam31-image-experimental-v1`), `phase` (`idle`, `loading`, `ready`, `preparing`, `generating`, `error`), `loaded`, `model_downloaded`, `error`, and an optional `features` list that lets the queue refuse options an older running worker would ignore; `POST /api/model/load` (202, background thread, refuses while busy); `POST /api/generate` (202, returns `{ "id": <32 hex> }`); `GET /api/jobs/{id}`; `GET /api/jobs/{id}/<output>`; `POST /api/forge/{action}` with `stop` and `resume`, guarded by `FORGE_ENGINE_CONTROL_TOKEN` and `hmac.compare_digest`, refusing `stop` while work is active.
- `install_identity_endpoint(app, TOKEN, "<engine id>")` from `engine_identity` (imports `hidden_console`). Insert the script folder into `sys.path` first and mark following imports `# noqa: E402`.
- Validate the request with Pydantic (`Field` limits, `Literal`, `strict=True`, `allow_inf_nan=False`) and check the image/size limits yourself. Reject inconsistent option pairs with a 422 before any work.
- Memory: `host_bytes_needed` from `runtime/host_memory.py` for host RAM (soft by default) and `torch.cuda.mem_get_info()` for the GPU; raise if CUDA is unavailable. Never run inference on the CPU.
- Write the result to `.<id>.part` then `os.replace` into the output folder so `runtime/worker_outputs.py` (`recovered_job`) can recover a completed output after a restart. Remove the part file on failure and call `torch.cuda.empty_cache()`.
- Logging: `log = get_logger("<component>")` and `install_excepthook("<component>")` from `runtime/app_log.py`, `flush()` before a controlled exit, constant event ids such as `segmentation.model.load.failed` with allow-listed fields (`jobId`, `modelId`, `error`), and `log.time(...)` for durations; never prompts or paths. `runtime/sam31_worker.py` shows the pattern; see the [logging conversion guide](LOGGING_CONVERSION_GUIDE.md).
- Tests: `test/test_<name>_worker.py` and `test/test_<name>_backend.py` with fake tensors and detectors (see `test/test_sam31_worker.py`). No weights.

## Step 6: preparation and the load barrier (`runtime/<name>-preparation.js`, `runtime/worker.js`)

`runtime/sam31-preparation.js` exports three factories; copy their structure.

- `createXLoader({ hardware, services, baseUrl, freeMemory, fetcher })` returns `loadX()`: check `/api/status` identity and shape, return `already_loaded`, `loading` or `model_missing` without touching memory, check host memory with `hostMemoryShort`, plan GPU admission with `planModelLoad(snapshot, services, budgetMiB)`, then `POST /api/model/load`. Return `{ status, body: { code, message, ... } }`. A lost response is `load_unknown` (503), never "failed": the load may have started.
- `createXPreparation({ startEngine, loadModel, autoStart })` returns the function the queue calls with `{ health, reachable, claimLoad, retryModel }` and answers with a queue status: `waiting_engine`, `waiting_memory`, `needs_attention`, plus `loadBarrier: true` while a load may be in flight. It starts the engine only when `resolveAutoStart(autoStart)` allows (`runtime/service-preparation.js`).
- `createXRenderPreparation({ hardware, services })` admits one render (the additional working memory) and returns `null` when it may proceed.
- Wire them in `runtime/worker.js`: build the loader and both preparations, add the loader to the manual-load map and the barrier clearing function (`manualSam31Load`, `clearSam31LoadBarrier`), add the identity check to the load monitor (the `health.engine === ...` chain) and the engine id to the list in `ensureModelLoadMonitor`, and pass the preparations into the `JobQueue` options.
- **Memory admission rules.** GPU free memory is the real admission limit: `planModelLoad` needs `budget + GPU_RESERVE_MIB (2 GiB)` and refuses an unverifiable or multi-GPU reading. Host RAM is a soft check (a 2 GiB floor unless `memory.hostPolicy` is `strict`). Estimates are not reservations and not proof. If the budget depends on the request, make it a function of the request in one module the queue, the UI and the metadata all use (`videoGpuBudget` in `runtime/video-options.js`). Add the engine to `runtime/auto-memory.js` only if an idle, Forge-owned, unloaded worker can be safely stopped to make room.
- **Barriers.** Never clear a persisted model-load barrier because a request timed out; the clear function must verify the service is no longer loading first (`clearSam31LoadBarrier`).

## Step 7: the job module (`runtime/<name>-job.js`)

A forked process the queue starts per job. `runtime/sam31-job.js` is the template.

1. Receive `{ job, projectFolder, baseUrl }` once; read staged inputs with `readReferences` (`runtime/references.js`); exit when the IPC channel disconnects.
2. Check the worker's `features` if the request uses a newer option; refuse before submitting (a known outcome).
3. Submit with a timeout and `redirect: 'error'`. Network error or unusable answer: send `interrupted` ("Submission result is unknown"). HTTP 4xx: `failed`. 5xx: `interrupted`. A valid id: send `accepted` with the `remoteId`. **Never retry a submission whose outcome is unknown.**
4. Poll `GET /api/jobs/{id}`. A 404 means the worker forgot the job: `interrupted`. A transient error: report a progress stage and keep polling. An engine-reported failure: send `failed` with `engineFailure: true`, which marks it a known outcome so a manual Retry may submit fresh.
5. Send `finalizing`, then `saveAsset(projectFolder, folder, job.id, extension, url)` from `runtime/job-io.js` (staged, fsynced, committed without overwriting; an existing conflicting file is preserved).
6. Send `complete` with the project-relative `output` and an optional small `result` object. Truncate error text and never include secrets or private paths.
7. Register the file in the `workerFile` map in `runtime/jobs.js`, and add the output folder and extension to `OUTPUTS` in `runtime/job-recovery.js` so a job killed during `finalizing` can be checked from disk.

- Tests: a queue test with the real `JobQueue` and a loopback fake worker, covering submit, poll, success, engine failure, lost response, restart, cancel and retry (`test/sam31-queue.test.js`, `test/hymotion-queue.test.js`).

For a CPU-only integration (SeedThree), the job module does not talk to an engine: `runtime/vegetation-job.js` runs `runtime/vegetation-runner.js`, which starts `runtime/vegetation-child.js` with a timeout, a heap cap and a watchdog. The job type is special-cased in `runtime/jobs.js` (`startVegetation`) to skip engine health, load barriers and memory admission; a job left running by a stopped studio is simply run again, because there is no remote job to be uncertain about.

## Step 8: the queue (`runtime/jobs.js`)

`runtime/jobs.js` has no registry; each job type is added at several sites. Search the file for the id of the newest GPU type (`grep -n "motion-bricks" runtime/jobs.js`) and add yours beside it. The sites are:

1. `validateType`: the type name in the allowed list, and a validation branch that checks every field, clamps or rejects out-of-range values, and returns the normalized request. Reject unknown fields. Check reference ids with the staged-id pattern, never a path. Chained renders: add the type to `CHAIN_CHILD_TYPES` or `CHAIN_PARENT_TYPES` only if it consumes or produces an image another render can use.
2. `profile()`: the request keys that identify a comparable render for time estimates.
3. The job-type set in `logLifecycle`: the queue's lifecycle log records drop any type that is not listed.
4. `model_loads`: an `INSERT OR IGNORE INTO model_loads(id,state)` row for the engine id, and the engine id in `suspendForModelLoad` and `claimQueuedModelLoad`.
5. The health check in the scheduling tick (the `job.type === ... health.engine === ...` chain) and the preparation dispatch (`prepareX`, `prepareXRender`), plus the constructor options for them.
6. `workerFile` (the job module), `engineUrl`, `engineId`, `engineName`.
7. Any `CHAIN_*` handling and the cancel/dependency code if the type chains.

Queue semantics that must survive your change: leases and fencing, `submitting` becomes `interrupted` on takeover, `preparing` becomes `waiting_engine`, one render at a time, the order SQL in `runtime/queue-order.js`. Add focused tests for the failure and recovery paths (`test/worker-recovery.test.js` and `test/coverage-restore-recovery.test.js` show the style).

Also: `runtime/queue-timing.js` `work()` (a number proportional to the work, or `1` when the exact-profile estimate is enough), `runtime/supervisor.js` (`ENGINE_OPERATIONS` entries for the load and clear-barrier methods, the `/models/<id>/load` and `/clear-load-barrier` routes, and the id in the `offload`, `force-stop`, `close` and `remove` patterns), and the corresponding HTTP tests (`test/queue-move-http.test.js` shows how the real route is exercised).

## Step 9: asset metadata, generation details and Reuse settings

- `runtime/asset-metadata.js`: map the job type to a catalog id (`jobModelId`) and a kind (`jobKind`), and record the settings and results the page should show later (for SAM, the match report). Never store prompts where the log can see them; the metadata database is per project.
- `src/generation-details.js`: a section for the type, with human labels (display strings are separate from stored values). Test: `test/generation-details.test.js`, `test/asset-metadata.test.js`.
- `src/rerun-request.js` and the Reuse settings flow in `src/main.jsx`: make "Reuse settings" and Retry rebuild the request from the stored one.
- `runtime/job-recovery.js` `OUTPUTS` (Step 7).

## Step 10: the UI

A model with a creation panel touches these (compare `segmentation`, `motion-bricks` in each file):

1. `src/useNav.js` (`panels`) and the panel tables in `src/main.jsx` (navigation entry with an icon, the page's copy and button label, the validation and enqueue code, Reset to defaults, estimates). Panels are route sections, so Back, forward and direct links work.
2. A settings module (`src/<name>-settings.js`) that builds and validates the request from the draft, shares limits with the server through a pure module in `runtime/` (`src/segmentation-settings.js` imports `runtime/sam31-options.js`), and a controls component (`src/<Name>Controls.jsx` with its CSS) using the visible labels, inline `FieldError` messages and field help. Cover them in `test/<name>-settings.test.js` and a jsdom test.
3. `src/creation-validation.js`: the required-field messages and focus targets.
4. Tooltips: `src/tooltips/pages/<section>.js` plus the import in `src/tooltips/index.js`. Keys are the English labels.
5. i18n: add the section to `src/i18n/namespaces.js`, wrap strings with `t()`, and run `npm run i18n:extract` once, then `npm run i18n:check` (see [I18N](I18N.md) and the [conversion guide](I18N_CONVERSION_GUIDE.md)). Commit the regenerated catalog.
6. Queue and notification surfaces that list job types: `src/RuntimeQueue.jsx`, `src/queue-groups.js`, `src/nav-queue-status.js`, `src/useRuntimeNotifications.js`, `src/MemoryAlerts.jsx`, `src/PreviewArea.jsx`.
7. Models page: `src/Models.jsx` (status notes such as "Gated", the load-monitor engine list, the display name map).
8. Accessibility and copy: labels, `aria-live` for progress, keyboard operation, reduced motion, tokens, and a layout check at desktop, ultrawide and phone widths. Unavailable capabilities must say so in the UI (for example SAM states which prompt types are not supported).

## Step 11: MCP tools (`runtime/mcp-server.js`, `runtime/mcp-studio-tools.js`)

- `forge_queue_<name>`: a Zod `inputSchema` that mirrors the server validation (bounded numbers, enums imported from the shared options module), `annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }`, and a handler that calls `write('/api/runtime/jobs', { type, projectId, request })`. The description must state what the output is and what is not supported.
- `forge_load_<name>_model` and `forge_clear_<name>_load_barrier` follow the existing pairs; the barrier tool takes `confirmNotLoading: z.literal(true)` and is annotated `destructiveHint: true`.
- Add the engine id to the lists that enumerate engines (`forge_start_engine`, offload, close, force stop). Force stop and removal need their literal confirmations; never expose credentials, consent gates or anything that downloads weights.
- Update [MCP](MCP.md). Test through the real stdio bridge (`test/mcp-engine-control.test.js`, `test/three-d-mcp.test.js`).

## Step 12: settings, logging, resilience

- **Settings.** `engines.autoStart.<name>` comes from the `ENGINE_AUTO_START` list in `runtime/core-settings.js` and is read by the queue through `getSetting`. Add a registry entry for any other behavior a person may reasonably change (a precision switch, a limit), with `effect` (`live`, `next-job`, `restart-required`), an `environment` rule if a variable already exists, and a plain description. Never register credentials, consent, security checks, folders or executables. Add the key to the table in [Studio behaviour settings](SETTINGS.md) (`test/settings-docs.test.js` fails when a registered key is missing there), and test it in `test/core-settings.test.js`.
- **Logging.** Use the component that owns the file (SAM uses `segmentation`; the list is `LOG_COMPONENTS` in `runtime/log-fields.js`). Log lifecycle transitions, engine start and stop, model load and offload, admission waits, retries and failures with allow-listed field names; never prompts, paths or credentials. Check each file with `npm run log:check -- <file>`. The design and routes are in [Studio log](LOGGING.md).
- **Resilience.** State what happens on a crash at each point and test it:

  | State when the studio or worker dies         | Expected result                                                                                                                                        |
  | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `queued`, `waiting_engine`, `waiting_memory` | Nothing was sent. The next runtime re-evaluates the job.                                                                                               |
  | `preparing`                                  | Becomes `waiting_engine` ("Rechecking the engine after a runtime restart"). A `checking` model-load row becomes `loading`; the barrier is not cleared. |
  | `submitting` (no remote id)                  | Becomes `interrupted`; a person checks the engine and resolves it. Never resubmitted automatically.                                                    |
  | `running` with a remote id                   | The new runtime polls the remote job; a 404 becomes `interrupted`.                                                                                     |
  | `finalizing`                                 | The output is checked on disk (`runtime/job-recovery.js`); a complete file is accepted, a partial one is not.                                          |
  | Worker process crash                         | The engine is isolated; Forge restarts only recoverable, Forge-owned workers and only if `engines.autoStart.<name>` allows it.                         |

  Details for each row, the Recovery report and the manual drills are in [Resilience](RESILIENCE.md). Two points matter for a new model:

  - **Outputs.** Save through `saveAsset` (stage, flush, then rename). A `finalizing` job is completed automatically only when size and signature prove the file whole: today GLB (length field), PNG (end marker), WAV (RIFF length) and BVH (frame count). Formats with only a header check (FLAC, WebM, PLY) are never auto-completed; add a check for your output format in `runtime/job-recovery.js` or the job stays `interrupted` for a person to resolve.
  - **Re-adoption.** After a studio restart Forge reconnects only to engines it can prove it owns (an identity endpoint plus the ownership journal). The speech and video guards and the engines on the journal are re-adopted; the music, sound effects, world and chat engines are not. Say in the guide which your new engine does.

## Step 13: documentation

Update every document whose truth you changed, in the same change:

- [Studio guide](STUDIO_GUIDE.md): what works today, the model table, a section describing the page and its limits. State plainly what is verified and what is not.
- [Model sources](MODEL_SOURCES.md) and [Installation](INSTALLATION.md) (Step 1), [MCP](MCP.md) (Step 11), [Windows ARM64 notes](WINDOWS_ARM64.md) (any adaptation of the upstream code), the [runtime map](../runtime/README.md) (a row for the new files), the [test guide](../test/README.md) (what the new tests cover and do not), and `README.md` (the Models table).
- [Roadmap](ROADMAP.md): move the entry out when the model ships.
- The docs index [docs/README.md](README.md) if you add a guide.

## Step 14: the project site

- Add the model card to `site/index.html` (the `id` of the card is what the capacity table links to).
- Add the model's folders to `ROW_DEFINITIONS` in `tools/model-capacity.mjs`. The tool refuses to run when a folder over 100 MiB under `models/` is not listed, so a new model cannot be forgotten.
- On the reference machine, with the studio running, `npm run site:capacity` re-measures and rewrites `site/model-capacity.json` and the static table; commit them together. Without the weights you cannot produce honest figures: say so in the handoff instead of editing the numbers by hand.
- Tests: `test/site-capacity.test.js`, `test/site.test.js`. The site deploys when `site/**` changes on `main`.

## Step 15: tests at each layer

| Layer                    | What to cover                                                                             | Example                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Request validation       | Every field, clamping, hostile input, unknown fields                                      | `test/vegetation-request.test.js`                         |
| Admission and loader     | Host short, GPU short with candidates, lost load response, barrier                        | `test/sam31-queue.test.js`                                |
| Queue with a fake engine | Submit, poll, success, engine failure, lost response, restart, cancel, retry              | `test/hymotion-queue.test.js`                             |
| Python worker            | Request validation, status shape, atomic output, stop guard (fake tensors)                | `test/test_sam31_worker.py`                               |
| UI in jsdom              | Labels, validation, disabled reasons, reset to defaults, keyboard, error and empty states | `test/hymotion-controls-ui.test.js`                       |
| MCP over stdio           | Schema bounds, request body sent to the fake studio                                       | `test/mcp-engine-control.test.js`                         |
| Metadata and details     | Stored settings, labels, Reuse                                                            | `test/generation-details.test.js`                         |
| Installer and docs       | Manifest shape, `-Plan` output, doc paths                                                 | `test/installer.test.js`, `test/docs-contributor.test.js` |

None of these loads a model. They prove protocol and recovery behavior, not output quality.

## Step 16: verifying against the real engine

Only after the substitute tests pass, and only with the user's agreement to use the GPU:

1. **One model at a time.** Inspect `GET /api/runtime/jobs`, `/api/runtime/services` and `/api/runtime/hardware` first. Do not stop unrelated work. Check Windows commit/system memory and GPU memory separately; they are different constraints.
2. Take a GPU-use lock the way your team does (a lock file or an agreement); the principle is that two real-engine runs never overlap.
3. Start the engine through Forge, load the model through the Models page or the load route, run **one small render** with clearly identified inputs in a dedicated project, and watch Diagnostics.
4. Record the numbers you measured: weights on disk, GPU memory at load and at the peak of the render, host memory, time. Update the budgets from them and say they come from one run on one machine.
5. Open the resulting asset and look at it (or listen to it). Report visible defects. Never claim quality you did not inspect.
6. Offload when done (`POST /api/runtime/models/<id>/offload`), confirm the engine is idle, and leave the queue as you found it.

## Definition of done

```powershell
node --test test/<your-tests>.test.js          # then: npm test
npm run build                                   # React or frontend changes
npm run i18n:check                              # any UI string
npm run log:check -- <changed files>            # when logging was added
npx eslint <changed js and jsx files>
npx prettier --check <changed files, including docs>
.\.venv-dev\Scripts\python.exe -m ruff check runtime/<name>_worker.py runtime/<name>_backend.py
.\.venv-dev\Scripts\python.exe -m ruff format --check runtime/<name>_worker.py runtime/<name>_backend.py
git diff --check
git status
```

Then confirm:

- [ ] Feasibility, licence and gating recorded; nothing downloads implicitly.
- [ ] Source pinned (`install-models.json` and the submodule, if any) and documented with revision and checksum.
- [ ] Engine definition, health interpreter, preparation, load barrier and job module wired; identity strings match on both sides.
- [ ] Validation at the runtime boundary; unknown outcomes never auto-retried; output written atomically.
- [ ] Memory admission uses GPU as the real limit and host RAM as a soft check; budgets labelled as estimates.
- [ ] UI states (empty, loading, error, unavailable), keyboard use, labels, tooltips, i18n keys, reset to defaults.
- [ ] MCP tools bounded and annotated; nothing destructive or credential-related exposed.
- [ ] Docs, site card and capacity mapping updated; the runtime map and test guide list the new files.
- [ ] Tests at each layer; the handoff says what was real inference, what was a substitute worker and what was not verified.

## Minimal diff map

For a typical engine-backed GPU model:

| Category            | Files (new in bold)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source pinning      | `install-models.json`, `install.ps1` (if `-Activate`), `docs/MODEL_SOURCES.md`, `docs/INSTALLATION.md`, `.gitmodules` (linked repository only)                                                                                                                                                                                                                                                                                                                                    |
| Catalog and storage | `runtime/model-catalog.js`, `runtime/model-inventory.js`, `runtime/supervisor.js` (removal), `runtime/mcp-server.js` (removal enum)                                                                                                                                                                                                                                                                                                                                               |
| Engine              | `runtime/engines.js`, `runtime/catalog.js`, `runtime/recover-service.js`, `runtime/diagnostics.js`, `runtime/core-settings.js`                                                                                                                                                                                                                                                                                                                                                    |
| Worker              | **`runtime/<name>_worker.py`**, **`runtime/<name>_backend.py`**                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Admission and queue | **`runtime/<name>-preparation.js`**, **`runtime/<name>-job.js`**, **`runtime/<name>-options.js`** (shared limits), `runtime/jobs.js`, `runtime/worker.js`, `runtime/supervisor.js`, `runtime/queue-timing.js`, `runtime/auto-memory.js`, `runtime/job-recovery.js`                                                                                                                                                                                                                |
| Metadata            | `runtime/asset-metadata.js`, `src/generation-details.js`, `src/rerun-request.js`                                                                                                                                                                                                                                                                                                                                                                                                  |
| UI                  | `src/useNav.js`, `src/main.jsx`, **`src/<Name>Controls.jsx`**, **`src/<name>-settings.js`**, **a CSS file**, `src/creation-validation.js`, `src/tooltips/pages/<section>.js`, `src/tooltips/index.js`, `src/i18n/namespaces.js`, generated `src/i18n/locales/en/*.json` and `src/i18n/manifest.json`, `src/RuntimeQueue.jsx`, `src/queue-groups.js`, `src/nav-queue-status.js`, `src/useRuntimeNotifications.js`, `src/MemoryAlerts.jsx`, `src/PreviewArea.jsx`, `src/Models.jsx` |
| MCP                 | `runtime/mcp-server.js`, `runtime/mcp-studio-tools.js`, `docs/MCP.md`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Tests               | **`test/<name>-queue.test.js`**, **`test/test_<name>_worker.py`**, **`test/test_<name>_backend.py`**, **`test/<name>-settings.test.js`**, **a jsdom UI test**, an MCP test                                                                                                                                                                                                                                                                                                        |
| Docs and site       | `docs/STUDIO_GUIDE.md`, `docs/WINDOWS_ARM64.md`, `runtime/README.md`, `test/README.md`, `README.md`, `docs/ROADMAP.md`, `site/index.html`, `tools/model-capacity.mjs`, `site/model-capacity.json`                                                                                                                                                                                                                                                                                 |

A CPU-only linked-source integration drops the engine, worker, preparation and admission rows and adds a checkout module, an adapter, an isolated runner and a service (Vegetation). An external-service integration drops the whole queue and engine rows and adds a service, its own database and an import queue (Megascans).
