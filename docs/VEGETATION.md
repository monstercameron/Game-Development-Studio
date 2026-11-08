# Vegetation (SeedThree)

The **Vegetation** page grows procedural trees, shrubs and cacti with [SeedThree](https://github.com/SkyeShark/SeedThree), an open-source (MIT) plant generator for JavaScript and Three.js. It needs **no model, no GPU and no engine**: SeedThree runs on the CPU in a separate Node process and a plant takes about a third of a second.

SeedThree is **alpha software** (`0.1.0-alpha`). Forge links to it and wraps it; it does not vendor, copy or fork it.

## What you get, and what you do not

You get:

- 20 species: White Oak, Red Maple, Tulip Poplar, Sweetgum, American Beech, Ponderosa Pine, Loblolly Pine, Douglas Fir, Cultivated Apple, Sweet Cherry, Paper Birch, Quaking Aspen, American Sycamore, Flowering Dogwood, Weeping Willow, Joshua Tree, Saguaro, Creosote Bush, Blackbrush and Big Sagebrush.
- One plant per seed (1 to 9999). The same species, seed and settings give **byte-identical** files.
- Controls generated from SeedThree's own schema: roughly 10 shape and leaf controls per species plus 10 to 30 advanced branch controls.
- Three triangle budgets (Low, Medium, High). Each exports one of the three levels of detail that SeedThree builds; the page shows the measured triangle counts of the default design.
- A binary glTF (`3d/forge-<job id>.glb`) that opens in the Forge viewer and in any glTF tool, plus the design as a SeedThree preset (`3d/forge-<job id>.preset.json`, format `seedthree-preset/1`) that opens in the SeedThree app (Load).
- Provenance in the asset details: species, seed, budget, every changed control, measured triangles, vertices, size, timings, peak memory, and the SeedThree version and commit.
- Variations (1 to 4 sibling plants with consecutive seeds), time estimates from your own history, MCP tools, and an optional "Describe it" assistant.

You do **not** get:

- **Textures.** The headless export uses two flat standard materials (brown for wood, green for leaves; cacti are green with brown spines). SeedThree's textured, wind-animated look is a live-render feature of its web app.
- **Wind animation, billboard impostors or baked branch-card levels of detail.** SeedThree bakes those on a GPU renderer; the headless export contains only the real-geometry levels.
- **Transparent leaves.** Leaves are opaque quads (without an alpha texture they read as green squares). A game engine would normally put an alpha-tested leaf texture on them.
- Tint, bark and alpha controls. They only change SeedThree's live materials, so the page does not offer them.
- A guarantee about quality: see [Quality findings](#quality-findings).

## Getting SeedThree (the linked repository)

SeedThree is linked, not bundled. Forge records **the repository URL, one exact commit and the licence** in two places and nowhere else:

- `install-models.json`, under `linkedRepositories` (read by the installer and by the app).
- `external/SeedThree`, a git submodule entry (`.gitmodules` plus a gitlink) that points at the same commit.

Current pin: `cf2eaad39d9b7355ed086aca2a95fb785e539242` (SeedThree `0.1.0-alpha`, MIT).

Nothing is downloaded by a render, by starting the studio, or by running the tests. You fetch it explicitly, in any of three ways:

1. **Vegetation page:** it shows **Fetch SeedThree** (or **Update SeedThree** / **Install SeedThree dependencies**) until the checkout is ready.
2. **Installer:** `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Vegetation` (add `-Plan` to preview).
3. **Command line:** `node runtime/vegetation-checkout.js fetch` (and `status`).

All three run the same code (`runtime/vegetation-checkout.js`), which:

1. initializes `external/SeedThree` as a git repository with `origin` set to the pinned URL (or checks the existing one),
2. restricts the working tree with a sparse checkout that leaves out `assets/` (about 330 MiB of textures that headless generation never reads) and `docs/media/`,
3. fetches only the pinned commit (`git fetch --depth 1 --filter=blob:none origin <sha>`) and checks it out detached, about 1 MiB of source,
4. runs `npm ci --ignore-scripts --omit=dev` **inside the checkout only**. This installs exactly two packages from SeedThree's lockfile: `three@0.184.0` and `lil-gui`. No install script runs.

It refuses to touch a folder that is not a git checkout, has a different `origin`, or has local changes. A submodule-aware clone also works: `git submodule update --init external/SeedThree` fetches the whole history (about 370 MiB); the Fetch step above is the lighter route and ends in the same commit, so `git submodule status` stays clean.

The page and the queue check readiness before every job. A missing, outdated (not the pinned commit) or dependency-less checkout produces an actionable state, and a queued job in that state fails with the same instruction rather than downloading anything.

`external/` is excluded from ESLint and Prettier. No SeedThree file is committed, and `node_modules` inside it is ignored by SeedThree's own `.gitignore`.

### Updating the pinned commit

1. Review the new SeedThree commit (licence, `src/api/seedthree.js`, `package.json` and lockfile).
2. Edit `commit` in `install-models.json`, then in the checkout run `git fetch` and `git checkout <sha>` (or press **Update SeedThree** on the page, which does it for you).
3. Run `node --test test/vegetation-*.test.js`. The adapter test runs the real SeedThree when it is present.
4. Re-measure the table below (see [Reproducing the measurements](#reproducing-the-measurements)) and update `docs/MODEL_SOURCES.md`.
5. `git add external/SeedThree install-models.json`.

Only `runtime/vegetation-adapter.js` knows SeedThree's API. If an upgrade changes it, only that file (and the pin) should need to change. To try a commit before editing the manifest, set `FORGE_SEEDTHREE_PIN` to its full SHA.

## Licence and attribution

SeedThree is Copyright (c) 2026 SkyeShark and released under the **MIT License**. The licence requires that its copyright and permission notice be kept with copies of the software. Forge keeps no copy: the checkout contains the upstream `LICENSE`, which stays with it. Files exported by Forge are your own designs; if you ship SeedThree itself or its code, include its MIT notice. SeedThree's textures and audio (not used or checked out by Forge) have their own provenance described in its README.

## How it works

```text
Vegetation page / MCP --> /api/runtime/jobs (type vegetation) --> durable queue (runtime/jobs.js)
                                                                        |
                                                  vegetation-job.js (forked queue worker)
                                                                        |
                                          vegetation-runner.js --> vegetation-child.js --> vegetation-adapter.js --> SeedThree
```

- **Queue.** `vegetation` is an ordinary job type in the durable queue: persisted request, timing profile, details, cancel, retry and Retry-after-fetch. It skips engine health checks, model loads and GPU/system memory admission because it uses no model. The queue still runs **one render at a time** and in order, so a plant waits behind an earlier GPU render.
- **Isolation.** SeedThree and three.js are never imported by the studio. Each plant is grown in a fresh child process with a **120 s timeout**, a **3 GiB V8 heap cap** and a watchdog thread that ends the process if its parent dies or the deadline passes. A crash, hang or out-of-memory only fails that job.
- **Limits.** A design above **1,500,000 triangles** or **96 MiB** is refused after it is grown, before anything is saved. With every control at its maximum SeedThree grows up to 6.7 million triangles and about 2.1 GiB of memory, so the guard matters. Native buffers are not covered by the heap cap.
- **Atomic output.** The child writes hidden `.part` files inside the project's `3d/` folder. The runner checks the GLB (header, JSON chunk, triangles) and the preset, then renames the preset and finally the GLB into place. A failure or cancel removes the parts. An existing output path that is not a regular file is refused.
- **Restart recovery.** There is no remote job, so nothing is uncertain: a job left running by a stopped studio is simply grown again (same bytes). If the worker dies the job fails with a Retry.
- **Cancel.** A queued job cancels as usual. A running job is asked to stop (it removes its parts) and is ended after 3 s if it does not.
- **Validation.** Requests are checked against the schema built from SeedThree's own `getSchema()`: species, `seed` (1 to 9999), `budget`, `params` (each control's type, range and options) and variation fields. Unknown fields are rejected. Values equal to the default are not stored. The child validates again.
- **Adapter fix.** SeedThree's `exportGLB()` colours meshes by name; at the pinned commit its wood is unnamed and its foliage is named differently from what it expects, so every plant came out with green wood and brown leaves. The adapter renames meshes by material kind before exporting (see `nameMeshesForExport`). Remove it if SeedThree fixes this upstream.
- **What is stored.** Each GLB records species, seed, budget, changed controls (`p_<control id>`), triangles, vertices, height, width, depth, file size, grow and export times, peak memory, SeedThree version and commit. **Reuse settings** on a result reopens the page with the same design.

The triangle count in the details is SeedThree's own (`statsOf`), which counts instanced leaf cards once per instance, like the viewer. The GLB statistics shown elsewhere in the library count an instanced mesh once and can be lower for the same file.

## Describe it (prompt to parameters)

**Describe it** turns a typed description (up to 600 characters) into a species, a seed and control values. It never queues anything: the result is written into the normal controls, with a note saying which model made it and what was adjusted or ignored.

- **Provider and model.** Chosen in **Settings, AI assist, Vegetation "Describe it"** (provider **OpenAI (cloud)** or **Local (Qwen engine)**, and a model id, default `gpt-6-luna`). The setting is stored by the server in `.forge-runtime/settings.sqlite` (`runtime/ai-assist-settings.js`, shared with the Errors feature). The model id is a free text field: the page can ask OpenAI whether it exists (**Check model id**) and shows the provider's own message, and a list of ids the key can use, when it does not.
- **OpenAI.** The key comes only from the credential store (Settings, API keys). The call is made by the Node backend, never the browser, with the Responses API, `store: false`, a 90 s timeout and a 2,000 token output cap. Errors 401, 403, 404, 429, 5xx and timeouts get plain messages without the key. With no saved key the page shows **Add your OpenAI key in Settings**, which opens the Settings dialog.
- **Local.** Uses the running Qwen3.8 chat engine on `127.0.0.1:8098`. If it is not running the page shows **Start chat model**, which calls the same endpoint as the Chat page (so Forge's memory checks apply). Nothing starts it for you. The rest of the page works fully by hand either way.
- **What is sent.** The description you typed, the species list (names) or one species' controls (names, ranges, options), and a fixed instruction. The notice "Your description and the plant parameter list are sent to OpenAI" sits next to the button. No project names, paths, files or settings are sent. The species is picked first (a short request) unless you keep the selected one.
- **Never trusted.** The reply is parsed as JSON, only controls that were offered are accepted, numbers are clamped and snapped to their step, choices must match, and everything else is listed as ignored.

## MCP

`forge_vegetation_status`, `forge_vegetation_schema` and `forge_queue_vegetation`; see [docs/MCP.md](MCP.md). There is no tool that fetches SeedThree.

## Quality findings

Measured on this machine (Windows ARM64, Node 26.13, no GPU involved) with the pinned commit, seed 1 and default controls. A plant took 269 to 776 ms from start to saved file (median 393 ms), including starting a Node process. Each child process peaked at 96 to 219 MiB resident memory. Triangles are SeedThree's own counts of the exported level.

| Species | Low | Medium | High | High vertices | High file (KiB) | Wall time per plant (ms, low-high) | Peak RSS (MiB) |
|---|---:|---:|---:|---:|---:|---:|---:|
| White Oak | 9,450 | 28,104 | 56,208 | 22,446 | 1783 | 304-320 | 122 |
| Red Maple | 6,972 | 17,320 | 34,044 | 16,599 | 1172 | 285-310 | 117 |
| Tulip Poplar | 7,428 | 18,648 | 36,624 | 17,591 | 1249 | 279-324 | 117 |
| Sweetgum | 8,868 | 22,312 | 43,648 | 20,897 | 1487 | 310-373 | 119 |
| American Beech | 21,327 | 33,163 | 60,524 | 15,767 | 1727 | 330-448 | 141 |
| Ponderosa Pine | 8,046 | 21,980 | 34,928 | 13,957 | 1145 | 278-369 | 113 |
| Loblolly Pine | 7,002 | 17,524 | 28,816 | 12,163 | 961 | 269-329 | 113 |
| Douglas Fir | 9,906 | 27,124 | 45,264 | 17,051 | 1459 | 284-320 | 122 |
| Cultivated Apple | 8,433 | 19,369 | 34,961 | 4,221 | 898 | 396-483 | 108 |
| Sweet Cherry | 7,393 | 13,491 | 26,394 | 4,221 | 703 | 459-776 | 99 |
| Paper Birch | 8,432 | 33,576 | 60,720 | 11,527 | 1681 | 463-547 | 117 |
| Quaking Aspen | 7,768 | 28,672 | 52,960 | 7,991 | 1415 | 410-460 | 111 |
| American Sycamore | 27,684 | 43,600 | 88,760 | 9,079 | 3969 | 529-545 | 158 |
| Flowering Dogwood | 9,396 | 31,902 | 61,516 | 10,705 | 1660 | 380-417 | 112 |
| Weeping Willow | 31,020 | 49,746 | 53,924 | 55,951 | 3553 | 455-533 | 219 |
| Joshua Tree | 10,156 | 21,644 | 55,096 | 3,607 | 1220 | 321-560 | 114 |
| Saguaro | 2,048 | 6,008 | 18,048 | 17,061 | 1434 | 405-440 | 117 |
| Creosote Bush | 2,964 | 3,744 | 6,806 | 3,232 | 220 | 373-425 | 103 |
| Blackbrush | 3,460 | 4,416 | 7,552 | 4,076 | 251 | 393-429 | 106 |
| Big Sagebrush | 1,314 | 1,660 | 3,426 | 1,840 | 118 | 359-371 | 99 |

Observations (visual checks in the Forge viewer; these are looks at a few species, not an art review):

- Every species grows, exports a valid GLB and opens in the Forge viewer with correct triangle counts. Output is deterministic. Materials: always two (wood and foliage), no textures, UVs present.
- White Oak (medium), Ponderosa Pine (medium) and Flowering Dogwood read clearly as trees: brown trunk and limbs with many green leaf quads. The leaves are flat opaque squares and the canopy looks like confetti up close.
- Saguaro is the best result: a smooth green column with arms and brown spines. Joshua Tree is also recognisable (branching trunk, green rosettes).
- Weeping Willow at its medium level is a dense dome of hanging green curtains with the trunk hidden. Its levels are not ordered like other species: its LOD2 has more triangles than LOD1, so Low is LOD1 and Medium is LOD2 (budgets rank by triangle count).
- The Low budget of the temperate trees is SeedThree's farthest real-geometry level (LOD2): fewer limbs and leaves, roughly a sixth of High.
- A design can be extreme: with every control at its maximum SeedThree reaches 6.7 million triangles and about 2.1 GiB of memory (measured while checking the limits); Forge refuses those. Some combinations are wasteful or odd (for example 4 branch levels on a White Oak lost its leaves).
- Control changes were checked per species to be real: shape and leaf controls change the file; bark and leaf tint, alpha test, bark damage and tiling do not, so they are not offered.
- The genuine unknowns: how the models look in an actual game engine with real leaf textures and alpha, performance of the instanced leaf cards in other renderers, and long-term stability of an alpha project's API.

### Reproducing the measurements

`test/vegetation-adapter.test.js` runs the real SeedThree (skipped when it is not fetched) for valid GLBs, budget ordering, determinism and timing. For the table, generate each species at each budget with `generateVegetationAsset()` from `runtime/vegetation-runner.js` into a temporary project (see the test for the call) and read `result`.

## Troubleshooting

- **"SeedThree is not ready"**: press Fetch (or Update) on the page, or run `install.ps1 -Vegetation`. A failed step names itself (`git fetch failed (exit 128)` means no network or no git).
- **A job failed with "stopped unexpectedly (exit code ...)"**: the generator crashed; Retry. If it repeats, check the design (extreme controls) and Diagnostics.
- **"longer than 120 seconds"**: the design is very heavy. Lower branch levels, density or leaf counts.
- **Describe it says the model was not found**: the model id in Settings, AI assist does not exist for your key. Use Check model id.
- **Everything after a SeedThree upgrade looks wrong**: delete `.forge-runtime/vegetation/` (cached schemas and measurements) and run the tests.
