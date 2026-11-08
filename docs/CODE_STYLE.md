# Code style guide

This is the practical style guide for people and agents who change Forge. It describes what the repository actually does and what its tools enforce. It adds detail to the rules in [AGENTS.md](../AGENTS.md); it does not replace them. Tool installation and commands are in [Linting and formatting](CODE_QUALITY.md) and are not repeated here.

Related guides: [Adding a model](ADDING_A_MODEL.md), [Adding a feature](ADDING_A_FEATURE.md), [runtime map](../runtime/README.md), [test guide](../test/README.md).

## What is enforced and what is a convention

| Layer       | Source of truth                          | What it checks                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint      | `eslint.config.js`                       | ESLint recommended rules (this includes `no-empty` with empty `catch` blocks forbidden, and `preserve-caught-error`), plus `no-unused-vars` (`args: 'all'`, unused arguments allowed only with a leading `_`), `no-var`, `prefer-const`, `eqeqeq`, `curly: all`. React Hooks rules in `src/`. |
| Prettier    | `.prettierrc.json`, `.prettierignore`    | Print width 100, 2-space indent, no tabs, semicolons, single quotes in JavaScript, double quotes in JSX attributes, trailing commas everywhere, `endOfLine: auto`.                                                                                                                            |
| Ruff        | `ruff.toml`                              | Python 3.10 target, line length 100, 4 spaces, double quotes; lint rules `E4`, `E7`, `E9`, `F`, `B`, `I` (syntax, common errors, bug-prone constructs, import order).                                                                                                                         |
| Review only | [AGENTS.md](../AGENTS.md) and this guide | Naming, file placement, comments, accessibility, copy, security boundaries, test quality. No tool checks these. A green lint run is not a review.                                                                                                                                             |

Prettier also formats Markdown, CSS, JSON and HTML in the repository (it ignores generated state, lockfiles and `src/i18n/manifest.json`). Documentation files in `docs/` are Prettier-formatted: run `npx prettier --write` on a doc you create, and `--check` on one you edit.

Existing violations are a known backlog (see [Linting and formatting](CODE_QUALITY.md)). Do not reformat a file you are only touching in a few places, and do not "fix" lint in unrelated code.

## Formatting by language

| Language                         | Indent   | Rules actually used                                                                                                                                                                                                                                                                                         |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JavaScript, JSX, JSON, CSS, HTML | 2 spaces | Semicolons, single quotes (JSX attributes use double quotes), trailing commas in multiline literals and argument lists, braces on every `if`/`for`, `const` unless reassigned, `===`. Target 100 columns; Prettier does not split long strings, so do not split a URL or message to satisfy a column count. |
| Python                           | 4 spaces | PEP 8 naming, double quotes, `snake_case`, context managers for owned resources, explicit exceptions. Imports that must follow a `sys.path` change carry `# noqa: E402` with a comment saying why (see `runtime/sam31_worker.py`).                                                                          |
| PowerShell                       | 4 spaces | Quote paths, `$ErrorActionPreference = 'Stop'`, check `$LASTEXITCODE` after external commands (`Invoke-Checked` in `install.ps1`), approved `Verb-Noun` function names.                                                                                                                                     |
| Markdown                         | n/a      | Prettier formatting. Tables are re-aligned by Prettier; do not hand-align them.                                                                                                                                                                                                                             |

Use UTF-8, a final newline and no trailing whitespace. Run `git diff --check` before you hand work off.

## Line endings: the repository is mixed

`core.autocrlf` is `true` on the reference machine and there is no `.gitattributes`. The index stores LF; a checkout can have either ending in the working tree. Roughly one file in five (for example `runtime/jobs.js`, `runtime/engines.js`, `src/main.jsx`, `README.md`, `docs/STUDIO_GUIDE.md`) is CRLF on disk and most of the rest is LF. Prettier's `endOfLine: auto` keeps whichever a file already has.

**Detect before you edit:**

```powershell
file runtime/jobs.js docs/MCP.md          # "with CRLF line terminators" or plain "ASCII text"
git ls-files --eol runtime/jobs.js        # i/lf = index, w/crlf = working tree
```

**Rules:**

- Preserve each file's style. A new file is LF (this is what the editing tools write).
- Never run a formatter, `unix2dos`, `dos2unix` or a "normalize endings" step over a CRLF file. One changed line must stay one changed line in `git diff --stat`. If a file you edited by hand shows hundreds of changed lines, you rewrote its line endings; undo that.
- The warning `LF will be replaced by CRLF the next time Git touches it` is normal for LF files on this machine. It is not an error and not a reason to convert anything.
- Make surgical edits: match a short, unique string and replace only it. The edit tool works for single-line anchors in either style. For a multi-line insertion into a CRLF file, the inserted text must also use `\r\n`, or the file ends up mixed. A small Node script does this safely (it refuses to run unless the anchor is unique):

  ```js
  const fs = require('node:fs');
  const file = 'README.md';
  const text = fs.readFileSync(file, 'utf8');
  const anchor = '- [Test guide](test/README.md)\r\n';
  if (text.split(anchor).length !== 2) {
    throw new Error('The anchor must occur exactly once.');
  }
  fs.writeFileSync(file, text.replace(anchor, `${anchor}- [New entry](docs/<new-guide>.md)\r\n`));
  ```

- Re-read the file just before editing it. Other people and agents edit the same shared files (`runtime/jobs.js`, `src/main.jsx`, the docs index) in parallel.

## Modules and naming

| Kind                                  | Convention                                                                      | Real examples                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| JavaScript helpers and services       | kebab-case with a `.js` extension, ES modules (`"type": "module"`)              | `runtime/queue-order.js`, `runtime/vegetation-service.js`, `src/generation-details.js`                       |
| React components                      | PascalCase with a `.jsx` extension, default export                              | `src/QueueReorderControls.jsx`, `src/FieldError.jsx`                                                         |
| Hooks                                 | exported as `useThing`; new files are named `use-<thing>.js`                    | `src/use-queue-reorder.js` (newer style), `src/useNav.js` (older style, do not rename)                       |
| CSS                                   | kebab-case with a `.css` extension, imported by the component or `src/main.jsx` | `src/queue-reorder.css`, `src/field-error.css`                                                               |
| CommonJS (only at a runtime boundary) | `.cjs`                                                                          | `runtime/h3_bootstrap.cjs`, `runtime/h3_args.cjs`                                                            |
| Python                                | snake_case with a `.py` extension, classes in PascalCase                        | `runtime/sam31_worker.py`, `runtime/host_memory.py`                                                          |
| Node tests                            | `<topic>.test.js` in `test/`                                                    | `test/queue-move.test.js`                                                                                    |
| Python tests                          | `test_<topic>.py` or `<topic>_test.py` in `test/`                               | `test/test_sam31_worker.py`, `test/world_lora_test.py`                                                       |
| Engine ids, job types                 | short kebab-case ids; these are persisted, never rename them                    | `segmentation`, `3d-hunyuan`, `motion-bricks`; job types `images`, `trellis`, `vegetation`                   |
| Engine identity string                | `forge-<name>-v<N>` returned in `/api/status` as `engine`                       | `forge-sam31-image-experimental-v1`                                                                          |
| Environment variables                 | `FORGE_<NAME>_*`                                                                | `FORGE_SAM31_URL`, `FORGE_AUTO_START_SAM31`, `FORGE_HOST_MEMORY_POLICY`                                      |
| HTTP write header                     | `X-Forge-Request: <service>`, one value per service                             | `vegetation`, `megascans`, `settings`, `errors`, `runtime`, `project`                                        |
| MCP tools                             | `forge_<verb>_<noun>`, snake_case                                               | `forge_queue_segmentation`, `forge_move_job`                                                                 |
| Settings keys                         | `<group>.<name>` camelCase after the dot                                        | `engines.autoStart.sam31`, `memory.hostPolicy`                                                               |
| i18n keys                             | `<namespace>.<component>.<name>`, string literals only                          | `models.forceStop.confirmTitle` (see [I18N](I18N.md))                                                        |
| Log events                            | constant `<area>.<noun>.<verb>`, 2 to 6 lowercase dotted segments               | `job.state.changed`, `engine.start.failed` (see the [logging conversion guide](LOGGING_CONVERSION_GUIDE.md)) |
| Machine-readable failure codes        | `snake_case` strings                                                            | `insufficient_gpu_memory`, `load_unknown`, `not_movable`, `stale`                                            |

Other naming rules:

- Names carry domain meaning and units: `freeMiB`, `requiredBytes`, `durationMs`. A name for an estimate must not read like a measurement (`SAM31_GPU_LOAD_MIB` is a budget, and its comment says so).
- Booleans read as questions (`isLoaded`, `hasOutput`, `canUnload`). Handlers are `handle...` inside a component and `on...` as props.
- Display labels are separate from persisted identifiers. Translate the label, never the value (see [I18N](I18N.md#what-is-never-translated)).
- Keep persisted names stable: queue job types, model ids, JSON, HTTP, MCP and filenames. If one must change, a migration is part of the change.

## File placement

| Directory                                                                                    | Holds                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/`                                                                                       | React views, hooks, browser-only helpers, CSS, `src/tooltips/`, `src/i18n/`. May import a **pure, browser-safe** module from `runtime/` (no Node built-ins) when the browser and the server must share one definition, for example `runtime/video-options.js`, `runtime/sam31-options.js`, `runtime/vegetation-request.js`, `runtime/queue-order.js` and `runtime/error-redaction.js`. |
| `runtime/`                                                                                   | Queue, model adapters and workers, process supervision, request validation at the runtime boundary, MCP tools, services mounted under `/api/...`, Python workers. Model-specific code stays in its own adapter or worker.                                                                                                                                                              |
| Repository root (`server.js`, `projects.js`, `chat-service.js`, ...)                         | Existing application host and early services. Extend the owning service; do not add unrelated root modules.                                                                                                                                                                                                                                                                            |
| `test/`                                                                                      | `*.test.js`, Python tests, and small deterministic fixtures in `test/fixtures/`.                                                                                                                                                                                                                                                                                                       |
| `tools/`                                                                                     | Developer scripts run by `npm run` (`tools/i18n-extract.mjs`, `tools/model-capacity.mjs`, `tools/log-coverage.mjs`). Not shipped to users.                                                                                                                                                                                                                                             |
| `docs/`                                                                                      | Durable installation, architecture, operations and recovery documentation. Indexed in [docs/README.md](README.md).                                                                                                                                                                                                                                                                     |
| `site/`                                                                                      | The public GitHub Pages project site (deployed by `.github/workflows/pages.yml`). Static HTML, CSS and JavaScript; no build step.                                                                                                                                                                                                                                                      |
| `public/`                                                                                    | Deliberately shipped static assets.                                                                                                                                                                                                                                                                                                                                                    |
| `desktop/`                                                                                   | The Electron shell (`desktop/main.js`).                                                                                                                                                                                                                                                                                                                                                |
| `models/`, `projects/`, `.forge-runtime/`, `engines/`, `external/`, `dist/`, `node_modules/` | Local or generated state. Never commit, reorganize or "clean" them.                                                                                                                                                                                                                                                                                                                    |

Where model-specific logic lives: the Python backend (`<name>_backend.py`) and worker (`<name>_worker.py`) own loading and inference; `runtime/<name>-preparation.js` owns start, admission and load; `runtime/<name>-job.js` owns the queue transfer; request validation and the engine table live in `runtime/jobs.js` and `runtime/engines.js`. The checklist is in [Adding a model](ADDING_A_MODEL.md).

## JavaScript patterns

- **Factories with injected dependencies.** Services and loaders are built by `createX({ ...dependencies })` or `xService({ ...options })` so tests can replace the network, the clock and memory readings. Example: `createSam31Loader({ hardware, services, baseUrl, freeMemory, fetcher })` in `runtime/sam31-preparation.js`.
- **Guard clauses and named helpers** instead of nested conditions. Do not write nested ternaries for new logic. (`runtime/jobs.js` contains long ternary chains from earlier work; do not copy them, extend them with the smallest edit.)
- **Constants** that are true constants are `UPPER_SNAKE_CASE` and carry their unit and meaning in a comment (`SAM31_GPU_LOAD_MIB`, `HOST_MEMORY_FLOOR_BYTES`).
- **JSDoc** for functions consumed across files when parameters, return shape or failure modes are not obvious (`setHostMemoryPolicySource` in `runtime/model-load.js`). Do not annotate every function.
- **Validate at the boundary.** Every HTTP route, MCP tool, queue request and worker request is validated where it enters; the browser's checks are a convenience (`src/creation-validation.js` says so in its header). Reject unknown fields, clamp or refuse numbers, and cap sizes. Examples: the `segmentation` branch of `validateType` in `runtime/jobs.js`, `runtime/vegetation-request.js`, `WRITE_FIELDS` in `runtime/settings-service.js`.
- **Never trust a path from the client.** Resolve project ids to folders on the server, check containment and reparse points (`fs.realpath` comparisons as in `saveAsset` in `runtime/job-io.js`), and pass uploaded bytes rather than paths.

## React patterns

- Components are pure renders. Side effects live in `useEffect` with a cleanup. The `react-hooks/exhaustive-deps` rule is an error; a deliberate omission needs a narrow `eslint-disable-next-line` with the reason on the line above (`src/Vegetation.jsx` does this for the estimate key).
- **Stale responses.** An effect that fetches must not let an older answer overwrite a newer state. Use an `active` flag cleared in the cleanup, or an `AbortController` (`src/Vegetation.jsx` estimate effect, `src/ErrorsDialog.jsx`). Debounce typing-driven requests with a timer cleared in the cleanup.
- **State placement.** Navigable panels and shareable settings belong in the URL (`src/useNav.js` owns the panel list; dialogs use `?dialog=...`; Vegetation and Megascans keep their design or search in the query string). Ephemeral input stays in component state. `localStorage` is for per-browser conveniences (language, mini-player repeat mode, viewer display toggles) and every access is wrapped because it can throw or be empty.
- **Memoization.** `useMemo`, `useCallback` and `React.memo` only when correctness (a stable dependency) or a measured cost requires it. Do not add them by reflex.
- **Errors.** Wrap a page in `PageErrorBoundary` (`src/PageErrorBoundary.jsx`, used in `src/main.jsx`) so one failing page does not blank the studio. Show validation problems beside the field with `src/FieldError.jsx` (it is `role="alert"`), focus the field, and use the field table in `src/creation-validation.js`. Backend error text is shown as received (English).
- **Estimates and status.** Say what a number measures and handle unknown values (`formatDuration` in `runtime/queue-timing.js` returns `Unknown`). Do not show "done" before the runtime confirms it.
- **Copy.** Plain, accurate English with units. All user-visible text goes through the i18n layer (`t`, `tp`, `<T>` from `src/i18n/index.js`) with the English default in the code. Tooltips are English entries in `src/tooltips/pages/<section>.js`, keyed by the visible label.

## CSS, accessibility and layout

- Colors come from `src/theme.css` (`--forge-*`). Spacing, radius, type, touch targets and the focus ring come from `src/ux-tokens.css` (`--ux-space-*`, `--ux-radius-*`, `--ux-text-*`, `--ux-target-min`, `--ux-focus-ring`). Add a token there instead of repeating a value. Layout breakpoints are 600, 850, 1000 and 1600 px (media queries cannot use variables).
- Scope selectors to the component (`.vegetation-notice`, `.queue-reorder-...`). The repository still has some `!important` declarations from earlier work; do not add more.
- Every control has a visible label or an accessible name. Keyboard operation is required for anything clickable. Focus must be visible (the shared rule in `src/ux-tokens.css` covers `main` controls).
- Dialogs use `src/useDialogFocus.js` (focus trap, Escape, focus restoration) and `src/modal-layer.js` for stacking.
- Announce changes: `role="status"` / `aria-live="polite"` for progress and results, `role="alert"` for errors (`src/Megascans.jsx`, `src/Vegetation.jsx`, `src/ErrorsDialog.jsx`). Never rely on color alone for status.
- Respect `prefers-reduced-motion`: a stylesheet that animates carries a `@media (prefers-reduced-motion: reduce)` block. Animation must never block interaction.
- Use logical CSS properties (`margin-inline-start`, `padding-inline`, `text-align: start`) so right-to-left languages work ([I18N](I18N.md#architecture)).
- Check desktop and ultrawide widths, and phone width (`src/ux-mobile-*.css`, `src/responsive.css`). A successful `npm run build` is not a layout or accessibility review.

## Backend patterns

- **Service factory and routes.** A service is a factory that returns `{ name, configureServer, configurePreviewServer }` (see the end of `runtime/vegetation-service.js`). It mounts under `/api/<name>` with `server.middlewares.use(...)`. It is registered **twice**: in `vite.config.js` (the dev server and `vite preview`) and in `runtime/http-server.js` (the production host started by `server.js`). Forgetting one gives a feature that works in `npm run dev` and fails in production, or the reverse. See [Adding a feature](ADDING_A_FEATURE.md).
- **Security checks on every route.** Reject any `Host` that is not loopback (`/^(127\.0\.0\.1|localhost)(:\d+)?$/`). For writes also require `Origin === http://<host>` and the service's own `X-Forge-Request` value. Cap request bodies, reject unknown JSON fields, answer with `Cache-Control: no-store`, and return stable `{ error, code }` bodies. Never add a route that accepts a path, URL or command from the client.
- **Do not weaken the local-only boundary.** Engines bind `127.0.0.1`. `engineUrl` in `runtime/jobs.js` refuses any non-loopback origin.
- **SQLite.** Use `node:sqlite` (`DatabaseSync`). Open with explicit pragmas (`journal_mode=WAL` and `busy_timeout`; see `runtime/jobs.js`, `runtime/error-store.js`), add columns with a guarded `ALTER TABLE` migration (the way `queue_rank` was added), and keep one database per concern (`jobs.sqlite`, `errors.sqlite`, `megascans.sqlite`, `settings.sqlite`, `i18n.sqlite` under `.forge-runtime/`). Use `BEGIN IMMEDIATE` for compare-and-swap writes. Never read the prompt column from a diagnostic path.
- **Atomic output.** Write to a hidden staging name in the destination folder, check the result, then commit it without overwriting an existing file: `saveAsset` in `runtime/job-io.js` fsyncs the staging file and hard-links it into place; the vegetation runner renames. A failure or cancel removes the staging file. Small state files use the atomic helpers in `runtime/durable-file.js`.
- **Processes.** Pass arguments as an array, never a shell string (`spawn`/`fork` with `windowsHide`, `runtime/error-issues.js` runs `git` and `gh` with argument arrays). Give every outbound call a timeout (`AbortSignal.timeout(...)`) and `redirect: 'error'` for loopback engines. Cancel long work with an `AbortController`.
- **Errors without secrets.** Messages shown or logged must not contain keys, tokens, prompts or absolute local paths. Redaction helpers: `runtime/error-redaction.js`. Credentials are only read through the credential service (`runtime/credentials.js`) for one request, passed to helpers over stdin, and never returned, logged or placed in a URL or MCP argument.

## Python patterns

- Workers are FastAPI apps bound to `127.0.0.1` that answer `GET /api/status`, `POST /api/model/load`, `POST /api/generate`, `GET /api/jobs/{id}` and `POST /api/forge/{action}` (token-guarded stop and resume). Read `runtime/sam31_worker.py` as the reference.
- Import `engine_identity` early: it installs the identity endpoint and imports `runtime/hidden_console.py`, which gives a detached Windows engine one hidden console so child programs do not open windows.
- Check host memory with `host_bytes_needed` from `runtime/host_memory.py` (a soft check; see the lessons below) and GPU memory with `torch.cuda.mem_get_info()`. Never fall back to CPU inference: raise a clear error when CUDA is unavailable.
- Write results atomically (`.part` file, then `os.replace`) so `runtime/worker_outputs.py` can recover a completed output after a restart.
- Use context managers for owned resources and explicit exception types. `except Exception: pass` exists in older code for best-effort cleanup; in new code catch the narrowest type and say why ignoring it is safe.

## Comments

- Comment why, not what: an invariant, a unit, ownership, concurrency, a compatibility workaround or a source. `runtime/model-load.js` explains why host RAM is a soft requirement; `runtime/job-io.js` explains why the file is fsynced before it gets its final name.
- JavaScript uses `//`, Python and PowerShell use `#`, CSS uses `/* ... */`. Short sentences with normal punctuation.
- A compatibility patch records its upstream source and version, the reason and the removal condition ([Windows ARM64 notes](WINDOWS_ARM64.md), `runtime/trellis-patches/`).
- A `TODO` states the remaining work and its context. Do not leave a vague TODO instead of finishing the requested behavior.
- Never put secrets or private user data in comments, fixtures or examples.

## Error handling

- **No empty catches.** ESLint rejects an empty `catch` block. Handle the error, or rethrow, or write a comment that says why it is safe to ignore (see the `catch` in the log function of `server.js`). The repository still has best-effort cleanup written as `.catch(() => {})` (for example removing a staging file in `runtime/job-io.js`); it passes lint, but new code should log at `debug` or explain the choice.
- **Keep the cause.** When you throw a new error from a `catch`, pass `{ cause: error }`. ESLint's `preserve-caught-error` enforces it (see `runtime/job-io.js`).
- **Unknown is not success.** A lost response, a timeout or a missing remote id is an unknown outcome. Return `interrupted` or `unknown`, keep the evidence, and let a person resolve it (`runtime/sam31-job.js`).
- **Known engine failures** are marked (`engineFailure: true`, stored as the `engine_failed` outcome) so a manual Retry may submit a fresh attempt. Unknown outcomes are only ever re-checked, never re-submitted.
- Errors must be actionable and copyable, and must not leak credentials or private paths.

## Tests

- Framework: `node --test` with `node:assert/strict`. Full run: `npm test` (it runs `test/*.test.js`; the Python tests are run separately, see [the test guide](../test/README.md)).
- Mutable state lives in temporary directories created per test (`fs.mkdtemp`, then removed). Tests never write into real projects, `models/` or `.forge-runtime/`.
- No ordinary test starts a real engine or touches the GPU. Use a loopback fake (`createServer(...).listen(0, '127.0.0.1')`), a stub worker in `test/fixtures/` (`test/fixtures/mock-engine.js`, `test/fixtures/qwen-stub/`), injected `fetcher` and `freeMemory`, and the real `JobQueue` against a fake engine (`test/sam31-queue.test.js`).
- UI tests run React in jsdom. Either compile the component with `loadJsx('Name.jsx')` from `test/fixtures/load-jsx.js` (`test/megascans-ui.test.js`), or mount through Vite's SSR loader (`test/vegetation-ui.test.js`). A DOM must exist before React DOM is imported.
- MCP tests run the real stdio bridge `runtime/mcp.js` against a fake studio (`test/mcp-engine-control.test.js`).
- Python worker unit tests (`test/test_sam31_worker.py`, `test/test_sam31_backend.py`) use fake tensors and fake detectors and load no weights. The few tests that do load real checkpoints are listed under "Real model checks" in [the test guide](../test/README.md) and are never part of an ordinary run.
- Test failure and recovery paths for queue transitions, artifact deletion, process ownership and API contracts. Do not write tests that restate the implementation.
- Say what a test proves. A substitute-worker test proves protocol and recovery behavior, not generated quality or real GPU inference.

## Commit and handoff hygiene

- Inspect `git status` first and preserve changes that are not yours. Do not commit unless asked; when asked, one coherent change per commit with a message that says why.
- Never commit credentials, tokens, local databases, logs, generated assets, model weights, downloaded binaries or caches. `.gitignore` already covers most of them; check anyway.
- Run the checks that apply to the files you changed, then `git diff --check`, then read your own diff. Report exactly what ran, what failed (including failures that already existed) and what was not verified.

## Do and don't

| Do                                                                            | Don't                                                                         | Example                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| Check the engine's identity string in `/api/status` before trusting a port.   | Treat an open port as proof that the right engine is loaded.                  | `runtime/sam31-preparation.js`       |
| Return `interrupted` when a submission's outcome is unknown.                  | Retry a submission automatically after a timeout.                             | `runtime/sam31-job.js`               |
| Stage a file, fsync it, then commit it without overwriting.                   | Write straight to the final asset name.                                       | `runtime/job-io.js`                  |
| Register a new service in both `vite.config.js` and `runtime/http-server.js`. | Register it in only one host.                                                 | `runtime/vegetation-service.js`      |
| Validate a request again on the server, even if the page checked it.          | Trust browser filtering or a client-supplied path.                            | `runtime/vegetation-request.js`      |
| Pass `{ cause: error }` when rethrowing.                                      | Throw a new error that hides the original.                                    | `runtime/job-io.js`                  |
| Put help text in `src/tooltips/pages/<section>.js` and strings through `t()`. | Hard-code translated text, or translate ids and values.                       | `src/tooltips/pages/segmentation.js` |
| Read a setting through the registry with `getSetting(key)`.                   | Add a new `process.env` switch for behavior a person would reasonably change. | `runtime/core-settings.js`           |
| Use design tokens and logical CSS properties.                                 | Repeat hex colors, pixel gaps or `left`/`right` layout.                       | `src/ux-tokens.css`, `src/theme.css` |
| Use a fake engine and a temporary folder in tests.                            | Start a real model or write into `projects/` from an ordinary test.           | `test/sam31-queue.test.js`           |
| Make a small anchored edit in a CRLF file.                                    | Reformat or convert the whole file.                                           | see "Line endings" above             |
| Inspect live queue and service state before starting or stopping a model.     | Stop a process because it holds a port or a documented PID.                   | `runtime/README.md`                  |

## Things this repository learned the hard way

Each item is visible in the code or the docs named beside it.

- **Host RAM is a soft check; the GPU is the real admission limit.** Per-engine host budgets are uncalibrated estimates and weights are memory-mapped, so only a 2 GiB floor blocks by default. `memory.hostPolicy` or `FORGE_HOST_MEMORY_POLICY=strict` restores the full budget. GPU admission refuses an ambiguous multi-GPU reading and keeps a 2 GiB reserve. (`runtime/model-load.js`, `runtime/host_memory.py`)
- **Windows commit memory and GPU memory are separate.** A video engine crashed with `0xC0000409` when another process exhausted the commit limit while the GPU had room. Never treat free RAM, free VRAM or a present file as proof that a load will work. ([Windows ARM64 notes](WINDOWS_ARM64.md))
- **Hard links double-count storage.** Some checkpoints share bytes through NTFS hard links. The studio's storage scan adds every name; the capacity tool counts each file once; modifying a linked file in place changes every name. ([Model sources](MODEL_SOURCES.md), [Studio guide](STUDIO_GUIDE.md#refreshing-the-capacity-figures))
- **Never kill a process you did not start.** Ownership comes from a verified launcher identity (PID plus creation time plus executable), not from a port or a documented PID. Force stop is explicit and confirmed, and never takes a PID from the client. (`runtime/README.md`, `runtime/force-stop.js`)
- **Unknown remote outcomes are never auto-retried.** A lost response leaves the job `interrupted` and a person resolves it after checking the engine. Only an outcome the engine itself reported as failed may be re-submitted, and only by a manual Retry. ([MCP guide](MCP.md))
- **A timed-out model load does not prove the load stopped.** Do not clear a persisted model-load barrier until the service is verified no longer loading. (`runtime/worker.js`)
- **Credentials only through the credential service.** Keys are encrypted with Windows DPAPI, handed to helpers over stdin and never returned, logged, placed in URLs, process arguments, MCP arguments or fixtures. (`runtime/credentials.js`, [Error review](ERRORS.md))
- **English is the default in code.** The i18n layer falls back to the English literal, so a missing translation is harmless and tests need no provider. Keys are string literals so the extractor can find them. ([I18N](I18N.md))
- **Log fields are allow-listed.** A field is kept only when its name and value type match a rule in `runtime/log-fields.js`; prompts, paths, bodies and credentials are never logged. ([Logging conversion guide](LOGGING_CONVERSION_GUIDE.md))
- **Detached Windows engines need a hidden console.** Otherwise every child console program opens a window. A venv `python.exe` is only a redirector, so launches use the base interpreter. (`runtime/engine-launch.js`, `runtime/hidden_console.py`)
- **A power loss can leave a complete-looking empty file.** Write bytes, fsync, then rename or link, and verify a found output before accepting it. (`runtime/job-io.js`, `runtime/durable-file.js`)
- **Nothing downloads as a side effect.** Weights, the SeedThree checkout and Fab files each need an explicit person action. The Fab confirmation is a checkbox only a person can tick, and a signed download address is never stored. ([Vegetation](VEGETATION.md), [Megascans](MEGASCANS.md))
- **Respect upstream services.** The Fab client sends an honest `User-Agent`, one request at a time, and stops when blocked; it never imitates a browser. (`runtime/megascans-fab.js`)
- **The embedded Python does not add the script folder to `sys.path`.** Workers insert it themselves and mark the following imports `# noqa: E402`. (`runtime/sam31_worker.py`)
- **Queue order is one SQL expression.** Every read of the open queue uses `QUEUE_ORDER_SQL`, and a test guards that. (`runtime/queue-order.js`)
- **Building while the studio serves `dist/` can interrupt open pages.** Check the queue and use an isolated build or preserve assets. ([Installation](INSTALLATION.md))

## Shared systems and their documentation status

These systems are being landed by other work. Use what exists in the tree; do not describe unbuilt behavior as available.

- **Central logging.** The writers exist: `createLogger(component)` in `runtime/app-log.js`, `createLog(component)` in `src/app-log.js`, `get_logger` in `runtime/app_log.py`, with the field allow-list in `runtime/log-fields.js`. The design, storage, retention, routes and review UI are in [Studio log](LOGGING.md); how to instrument one file is in [the logging conversion guide](LOGGING_CONVERSION_GUIDE.md); check a file with `npm run log:check -- <file>`. Log levels, retention and size are registered settings (`logs.*`).
- **Settings registry.** `runtime/core-settings.js` holds the typed `SETTING_DEFINITIONS`; `runtime/settings-service.js` serves `/api/settings`; `src/StudioBehaviourSettings.jsx` is the dialog; `runtime/mcp-settings-tools.js` exposes it to MCP. Behavior a person may reasonably change gets a registry entry; credentials, consent gates, security checks, folders, executables and destructive actions never do. The full table of keys, how a value is chosen (environment variable, then a saved override, then the default), what is deliberately not a setting and how to add one are in [Studio behaviour settings](SETTINGS.md); `test/settings-docs.test.js` fails when a registered key is missing from that table.
- **Resilience.** Write new project artifacts and state files through the stage, flush and rename protocol in `runtime/durable-file.js`, open every database through `runtime/durable-db.js` (explicit pragmas, a startup integrity check, quarantine and restore from backup), and record crash-relevant decisions with `runtime/recovery-events.js`. [Resilience](RESILIENCE.md) has the durable-state matrix, the job state machine after a crash, the Recovery report, the backups, crash-loop protection and the manual drills; read it before changing queue transitions, writers or database opening.
