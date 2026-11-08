# Adding a feature or page

This is the checklist for a new page, service, setting or queue behavior that does **not** bring a new model. If your feature adds a model or engine, start with [Adding a model](ADDING_A_MODEL.md) and use this guide for the page and service parts. Style rules are in the [code style guide](CODE_STYLE.md); the hard rules are in [AGENTS.md](../AGENTS.md).

Four recent features are traced below. Their file lists come from the code.

| Feature              | What it is                                                                     | Shape                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Errors review**    | A dialog (`?dialog=errors`) with captured, redacted errors, optional GPT fixes | A service (`/api/errors`), its own SQLite database, read-only MCP tools, no job type                  |
| **Megascans portal** | A page that caches a public catalog and downloads files                        | A service (`/api/megascans`), its own database and import queue, consent-gated MCP tools              |
| **Queue reordering** | Move waiting renders in the queue                                              | An extension of the existing runtime queue (a new queue method, route and MCP tool) and queue-page UI |
| **Vegetation page**  | Procedural plants from a linked CPU library                                    | A page, a service (`/api/vegetation`), a new job type in the render queue                             |

## Step 1: choose the shape

Decide this first, because it decides where state lives and which tests you write.

| If the feature...                                                                                                | Use                                                                   | Example                               |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| Only presents or edits data that existing APIs already serve                                                     | A panel and components only (no new route)                            | Queue page controls                   |
| Needs server state, outbound calls or files that are not a render                                                | A **service**: a factory mounted under `/api/<name>`                  | Errors, Megascans                     |
| Produces a project asset, must be ordered with GPU work, and needs cancel, retry, estimates and restart recovery | A **job type** in the durable render queue (`runtime/jobs.js`)        | Vegetation                            |
| Has different concurrency or semantics from renders (no GPU, no model-load barrier, no lease)                    | Its **own queue and database**, not the render queue                  | Megascans imports (at most 2 at once) |
| Changes how the render queue behaves                                                                             | A new `JobQueue` method, a runtime operation, a route and an MCP tool | Queue reordering                      |

Rules that apply to every shape: loopback only, validate on the server, no download or network call as a side effect of a render or of opening a page, and no behavior that stops, kills or loads anything without checking live queue and service state first.

## Step 2: where state lives

| State                                                       | Home                                                                                                               | Notes                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Render jobs                                                 | `.forge-runtime/jobs.sqlite` (`runtime/jobs.js`)                                                                   | Add columns with a guarded `ALTER TABLE` (see `queue_rank`); old rows must keep working; test a database created before the column. |
| A feature's own records                                     | A database of its own in `.forge-runtime/` (`megascans.sqlite`, `errors.sqlite`, `i18n.sqlite`, `settings.sqlite`) | `node:sqlite` `DatabaseSync`, WAL, `busy_timeout`, `BEGIN IMMEDIATE` for check-and-set. One database per concern.                   |
| Per-project data (ratings, asset details)                   | The project folder and its metadata database (`runtime/asset-metadata.js`)                                         | Project isolation: resolve the project id on the server; never accept a path from the client.                                       |
| Behavior a person may change                                | The settings registry (`runtime/core-settings.js`), persisted in `.forge-runtime/settings.sqlite`                  | See Step 7.                                                                                                                         |
| Credentials                                                 | The credential service only (`runtime/credentials.js`)                                                             | Never a setting, a URL, a log line or an MCP argument.                                                                              |
| Shareable page state (search, selected design, open dialog) | The URL: path segment for the panel, query parameters for the rest                                                 | Validate route and query parameters; back and forward must work.                                                                    |
| Per-browser conveniences (language, mini-player mode)       | `localStorage`, always in `try`/`catch`                                                                            | The page must work without it.                                                                                                      |
| Ephemeral input                                             | Component state                                                                                                    | Do not lift it into global state without a reason.                                                                                  |

Never read the prompt column of the jobs table from a diagnostic or error path (the error scanner opens `jobs.sqlite` read-only and selects specific columns). Keep files you create out of the repository: logs, databases and caches are ignored by `.gitignore`.

## Step 3: the HTTP service (and why it is registered twice)

A service is a factory that returns a Vite-style plugin: `{ name, configureServer, configurePreviewServer }`. Read `runtime/vegetation-service.js` from top to bottom; it is the shortest complete example. The pattern:

1. Mount with `server.middlewares.use('/api/<name>', handler)`.
2. Reject any request whose `Host` is not loopback, with `403 { error: 'Local studio requests only.' }`.
3. Allow only the methods you implement (`405` otherwise).
4. For writes, require `Origin === http://<host>` **and** `X-Forge-Request: <name>` (one value per service). Browser code sends both; the MCP bridge sends them too.
5. Read the body with a size cap, parse JSON, require an object, and **reject unknown fields**.
6. Validate every field and every id; resolve project ids to folders on the server; never accept a path, URL or command.
7. Send JSON with `Cache-Control: no-store`; use stable `{ error, code }` bodies; map internal errors to a generic message and keep detail in the log.
8. Add rate limits where a client could loop (`runtime/settings-service.js`: 30 writes a minute).
9. Accept dependencies as options (credential store, `fetchImpl`, runtime folder) so tests can replace them.

**Register the service in both places:**

- `vite.config.js`: the `plugins` list. This serves `npm run dev` and `vite preview`.
- `runtime/http-server.js`: the `for (const service of [...])` list. This is the production host that `server.js` supervises, and it is what users run.

They are separate because the production host is a hand-built Express server around the built `dist/` folder; it does not load `vite.config.js`. A service present in only one of them works in one mode and returns `404 Not found` in the other. The two lists matched when this guide was written; keep them matching. Restart the studio host to load a new route; the dev server picks it up on restart.

Runtime operations that act on the queue (as opposed to a standalone service) go through `runtime/supervisor.js` instead: add the operation name to `ENGINE_OPERATIONS`, the route pattern, a handler in `runtime/worker.js` and the `JobQueue` method. Queue reordering did exactly that for `move` (`POST /api/runtime/jobs/<id>/move`).

## Step 4: the page and components

1. **Panel and route.** Add the id to `panels` in `src/useNav.js` and the navigation entry and page switch in `src/main.jsx`. Panels are route sections, so direct links and Back/Forward work. A modal or configuration state belongs in the query string (`?dialog=errors`). Wrap the page in `PageErrorBoundary`.
2. **Components** next to related ones (`src/Vegetation.jsx`, `src/Megascans.jsx` plus helpers `src/megascans-api.js`, `src/vegetation-settings.js`). Keep request-building and formatting in plain helper modules so they can be tested without a DOM. Share validation limits with the server through a pure module in `runtime/` when both need the same numbers (`src/vegetation-settings.js` imports `runtime/vegetation-request.js`).
3. **Effects and requests.** Clean up subscriptions and timers; guard against stale responses with an `active` flag or `AbortController`; debounce typing-driven calls ([code style](CODE_STYLE.md#react-patterns)).
4. **States.** Design empty, loading, error, blocked/unavailable and success states. Say what a number measures and handle unknown values. Do not show a completion message before the runtime confirms it.
5. **Inline errors and help.** Required-field messages go through `src/creation-validation.js` and `src/FieldError.jsx`; field help goes in `src/tooltips/pages/<section>.js` and is registered in `src/tooltips/index.js`.
6. **Reset to defaults** for any page with settings: disabled while the page matches its defaults, an inline confirmation before it clears.
7. **Styles.** A feature stylesheet imported by the component (`src/queue-reorder.css`), colors from `src/theme.css`, spacing and focus from `src/ux-tokens.css`, a `prefers-reduced-motion` block for any animation, logical properties for RTL.
8. **Accessibility.** Visible labels, keyboard operation (Queue reordering has keyboard pick-up, move, drop and cancel with live-region text), visible focus, `role="status"` / `aria-live` for progress and `role="alert"` for errors, dialogs with `src/useDialogFocus.js`, no status by color alone.
9. **Mobile.** Check phone width (600 px) and the nav drawer breakpoint (850 px); put phone-specific rules in the existing `src/ux-mobile-*.css` / `src/responsive.css` pattern. A build does not check layout; open the page at the narrow widths.
10. **Internationalization.** Wrap visible strings in `t()` / `tp()` / `<T>` with the English default in code, add the namespace to `src/i18n/namespaces.js` for a new page, and run `npm run i18n:extract` once and `npm run i18n:check` ([I18N](I18N.md), [conversion guide](I18N_CONVERSION_GUIDE.md)). Never translate ids, enum values, routes or persisted fields; backend error text stays English.

## Step 5: a job type (only when it is a render)

If the feature produces project assets in the render queue, follow steps 7 to 9 of [Adding a model](ADDING_A_MODEL.md) (the job module, `runtime/jobs.js` sites, metadata), leaving out engine, load-barrier and GPU admission when no model is involved. Vegetation is the template: `runtime/vegetation-job.js` forked per job, `runtime/vegetation-runner.js` and `runtime/vegetation-child.js` isolating the work with a timeout, a heap cap and a watchdog, and `startVegetation` in `runtime/jobs.js` skipping engine checks. Add the type to `profile()`, `work()` in `runtime/queue-timing.js`, the asset metadata maps, `OUTPUTS` in `runtime/job-recovery.js` and the UI job-type lists.

## Step 6: MCP exposure

MCP tools are thin wrappers over Forge's own loopback routes, registered in `runtime/mcp-server.js` or a `runtime/mcp-<area>-tools.js` module (`registerVegetationTools`, `registerMegascansTools`, `registerErrorsTools`, `registerSettingsTools`). Each tool has a Zod `inputSchema` that matches the server validation and an `annotations` object (`readOnlyHint`, `destructiveHint`, `openWorldHint`).

**Expose:** status and read tools; queue and change tools whose effect is bounded and reversible or confirmed (queue a render, move a job, change a registered setting); redacted views (`forge_errors_list` returns redacted text only).

**Never expose:**

- Credentials: no tool reads, writes or accepts an API key, and no tool takes a key as an argument ([MCP](MCP.md): "never put an API key in MCP arguments").
- **Consent gates.** Only a person ticks the Fab license checkbox; `forge_megascans_download` refuses with `needsConfirmation` until they did, and no tool can tick it.
- Anything that downloads weights or repositories as a side effect. There is deliberately no tool that fetches SeedThree.
- Destructive actions without a literal confirmation: force stop, permanent model removal, emptying project trash, clearing a load barrier (`confirmNotLoading: z.literal(true)`, `destructiveHint: true`).
- Paths, URLs or commands chosen by the caller. The Megascans API accepts uploaded bytes, never a client path.
- Security checks, folder and executable locations, network binding. The settings tools refuse these by design (`runtime/mcp-settings-tools.js`).
- Browser-only behavior (notifications, microphone capture).

Update [MCP](MCP.md) and test through the real stdio bridge (`test/megascans-mcp.test.js`, `test/vegetation-mcp.test.js`, `test/mcp-engine-control.test.js`).

## Step 7: settings, and staging a risky feature

The settings registry (`runtime/core-settings.js`) holds behavior a person may reasonably change. Read a value with `getSetting('group.name')`; resolution order is an environment variable, then a saved override, then the default. An entry needs: `key`, `label`, `group` (one of `SETTING_GROUPS`), `type` (for example `boolean`, `integer`, `enum` or `string`), `default`, `effect` (`live`, `next-job` or `restart-required`), a plain `description`, and, when a variable already exists, an `environment` rule so the registry reports the lock. The Settings dialog (`src/StudioBehaviourSettings.jsx`), `/api/settings` (`runtime/settings-service.js`) and the MCP tools pick it up from the registry. Never register credentials, consent, security checks, folders, executables or destructive actions. Add the key to the table in [Studio behaviour settings](SETTINGS.md), which also lists what is deliberately not a setting and how to add one (`test/settings-docs.test.js` fails when a registered key is missing there). Tests: `test/core-settings.test.js`, `test/settings-service.test.js`, `test/settings-consumers.test.js`.

To **stage a risky feature behind a setting**:

1. Add a boolean (or enum) entry with `default: false` (or the safe value), `effect` that matches how the feature loads, and a description that states the cost and risk in plain words (`world.fullPrecision` is the model: default off, `restart-required`, "needs substantially more GPU memory").
2. Gate the new behavior on `getSetting(...)` at the point of use, not at import time, so a change applies without a rebuild (the queue reads `engines.autoStart.<name>` per job).
3. When the setting is off, the UI says the capability is unavailable and how to enable it; it does not render a disabled mock.
4. Do not weaken a security check behind a setting, and do not make a setting the only thing preventing a download or a destructive action; use an explicit user action for those (Fetch SeedThree, the Fab checkbox).
5. Tests cover both values, and the docs say what changes.

## Step 8: logging, error capture and resilience

- **Logging.** Use the component that owns the file and allow-listed field names; never prompts, paths, bodies or credentials ([logging conversion guide](LOGGING_CONVERSION_GUIDE.md)). Megascans and the Fab client use `createLogger('megascans')`; queue moves log `queue_move` with ids and counts only. Check each file with `npm run log:check -- <file>`. Request logging for every `/api` route is automatic (the logs service records route templates, status and duration, never query strings); see [Studio log](LOGGING.md).
- **Error capture.** The Errors review ([Error review](ERRORS.md)) already collects browser errors (through `src/error-capture.js`), failed jobs, server and engine log errors. Throw real errors with useful messages, put the page inside `PageErrorBoundary`, and do not catch and hide failures. If you add a new log file that engines or services write, check whether the scanner should read it (`runtime/error-scanner.js`). Messages must be safe after redaction, but redaction is pattern-based: do not put user text in error messages.
- **Resilience.** For every state your feature can be in, decide what a crash leaves behind and what the next start does. Prefer: nothing is restarted automatically when progress is unknown (Megascans marks a running import `interrupted`), staged files are named so cleanup can find orphans, final outputs are committed atomically without overwriting, and a person decides about retry. Use the atomic helpers in `runtime/durable-file.js` and open databases through `runtime/durable-db.js`. [Resilience](RESILIENCE.md) lists the durable state of every subsystem, the post-crash job state machine and the drills; add your feature's state to its matrix.

## Step 9: tests

Write the tests that match the shape, with temporary directories and fakes:

- **Pure helpers and validation:** `node --test` unit tests (`test/vegetation-request.test.js`, `test/queue-move.test.js` for the planner and the database rules).
- **Service routes:** start the service with injected dependencies on an ephemeral loopback port and check the Origin, `X-Forge-Request` and Host checks, unknown fields, size limits, error bodies and that nothing happens at startup (`test/vegetation-service.test.js`, `test/megascans-service.test.js`, `test/queue-move-http.test.js`).
- **Queue behavior:** the real `JobQueue` on a temporary database with a fake engine; cover restart recovery, cancel and a lost race (`test/vegetation-queue.test.js`, `test/queue-move.test.js`).
- **Outbound clients:** a fake of the remote service on loopback (`test/fixtures/fake-fab.js`); test the failure modes (429, 5xx, challenge pages, redirects, short bodies), not just success.
- **UI:** jsdom with the component compiled through `test/fixtures/load-jsx.js` or Vite's SSR loader; cover labels, validation, error and empty states, keyboard use and the live regions (`test/megascans-ui.test.js`, `test/queue-move-ui.test.js`, `test/vegetation-ui.test.js`).
- **MCP:** the stdio bridge against a fake studio.
- **End to end:** only where it is cheap and isolated (`test/errors-e2e.test.js` runs the real Vite host with a temporary runtime folder).

State in `test/README.md` what the tests prove and what they do not (for example "no model, GPU or network is used").

## Step 10: documentation, site and README

- A guide for the feature in `docs/` (or a section of [Studio guide](STUDIO_GUIDE.md)) with what works, what does not, limits and verification status. Move any matching entry out of the [roadmap](ROADMAP.md).
- The page, its URL parameters and its routes in the right guide; [MCP](MCP.md) for new tools; the [runtime map](../runtime/README.md) for new backend files; the [test guide](../test/README.md) for new tests.
- [docs/README.md](README.md) (the index) and the documentation list in `README.md`. `README.md` is CRLF: use an anchored edit that keeps CRLF ([line endings](CODE_STYLE.md#line-endings-the-repository-is-mixed)).
- The project site (`site/index.html`) if the feature is user-visible and deserves a mention; the site deploys when `site/**` changes on `main`.
- Update the screenshots only when you can capture real ones.

## Traced examples

### Errors review

- **Backend:** `runtime/errors-service.js` (the `/api/errors` routes; writes need `X-Forge-Request: errors` or `ai-assist`), `runtime/error-scanner.js` and `runtime/error-log-parser.js` (read logs incrementally and failed jobs read-only), `runtime/error-store.js` (`.forge-runtime/errors.sqlite`, redacted, deduplicated by fingerprint, capped), `runtime/error-redaction.js` (shared with the browser), `runtime/error-format.js`, `runtime/error-fix.js` and `runtime/error-issues.js` (OpenAI request and `gh` with argument arrays, only after a preview and an explicit send), `runtime/ai-assist-settings.js`, `runtime/errors-test-routes.js`, `runtime/error_test_helper.py`.
- **Registered in:** `vite.config.js` and `runtime/http-server.js`.
- **UI:** `src/ErrorsButton.jsx`, `src/ErrorsDialog.jsx` (opened by `?dialog=errors`), `src/ErrorDetail.jsx`, `src/ErrorFixPanel.jsx`, `src/ErrorIssuePanel.jsx`, `src/ErrorPipelineTest.jsx`, `src/error-capture.js`, `src/errors-api.js`, `src/error-copy.js`, `src/errors-dialog.css`; the pipeline tool `tools/emit-test-error.mjs`.
- **MCP:** read-only `runtime/mcp-errors-tools.js` (`forge_errors_list`, `forge_error_detail`).
- **Tests:** `test/error-store.test.js`, `test/error-redaction.test.js`, `test/errors-service.test.js`, `test/error-issues.test.js`, `test/errors-dialog-ui.test.js`, `test/error-pipeline-test-ui.test.js`, `test/errors-e2e.test.js`. **Docs:** [Error review](ERRORS.md).

### Megascans portal

- **Backend:** `runtime/megascans-service.js` (routes, `X-Forge-Request: megascans`), `runtime/megascans-fab.js` (the polite client), `runtime/megascans-sync.js` and `runtime/megascans-thumbs.js` (cache and thumbnails), `runtime/megascans-db.js` (`.forge-runtime/megascans.sqlite`), `runtime/megascans-queue.js` and `runtime/megascans-runner.js` (the import queue, at most 2 at once), `runtime/megascans-download.js`, `runtime/megascans-import.js` with `runtime/zip-reader.js` (strict archive policy), `runtime/megascans-library.js`, `runtime/megascans-metadata.js` (provenance in the asset details), `runtime/megascans-files.js`.
- **UI:** `src/Megascans.jsx` with `src/MegascansList.jsx`, `src/MegascansDialogs.jsx`, `src/MegascansFab.jsx`, `src/MegascansImports.jsx`, `src/MegascansLegal.jsx`, `src/megascans-api.js`, `src/megascans.css`; route `megascans` in `src/useNav.js`; search state in the URL.
- **MCP:** `runtime/mcp-megascans-tools.js`; the download tool refuses until the person confirms the license in the page.
- **Tests:** `test/megascans-fab.test.js`, `test/megascans-cache.test.js`, `test/megascans-download.test.js`, `test/megascans-import.test.js`, `test/megascans-queue.test.js`, `test/megascans-service.test.js`, `test/megascans-mcp.test.js`, `test/megascans-ui.test.js`, with `test/fixtures/fake-fab.js` and `test/fixtures/zip-builder.js`. **Docs:** [Megascans](MEGASCANS.md).

### Queue reordering

- **Pure planner shared by server and browser:** `runtime/queue-order.js` (`QUEUE_ORDER_SQL`, `planMove`).
- **Queue:** `JobQueue.move` and the `queue_rank` column migration in `runtime/jobs.js`; the `move` operation in `runtime/supervisor.js` (`ENGINE_OPERATIONS` and the `/jobs/<id>/move` pattern) and `runtime/worker.js`.
- **MCP:** `forge_move_job` in `runtime/mcp-server.js`.
- **UI:** `src/queue-reorder.js`, `src/use-queue-reorder.js`, `src/QueueReorderControls.jsx`, `src/queue-reorder.css`, wired into `src/RuntimeQueue.jsx` (keyboard pick-up, move, drop and cancel; optimistic update with rollback).
- **Tests:** `test/queue-move.test.js`, `test/queue-move-http.test.js`, `test/queue-move-ui.test.js`. **Docs:** the "Queue order and reordering" paragraph of the [runtime map](../runtime/README.md) and [MCP](MCP.md).

### Vegetation page

- **Backend:** `runtime/vegetation-service.js` (`/api/vegetation`: status, schema, explicit Fetch, Describe it), `runtime/vegetation-checkout.js`, `runtime/vegetation-adapter.js`, `runtime/vegetation-runner.js`, `runtime/vegetation-child.js`, `runtime/vegetation-job.js`, `runtime/vegetation-request.js`, `runtime/vegetation-describe.js`, plus the `vegetation` sites in `runtime/jobs.js`; source pin in `install-models.json` and `.gitmodules`; `install.ps1 -Vegetation`.
- **UI:** `src/Vegetation.jsx`, `src/vegetation-settings.js`, `src/vegetation-studio.css`, `src/tooltips/pages/vegetation.js`, namespace `vegetation` in `src/i18n/namespaces.js`; design state in the URL; Reuse settings through `src/generation-details.js`.
- **Settings and MCP:** `vegetation.timeoutMs` and the `ai.vegetationDescribe.*` entries in `runtime/core-settings.js`; `runtime/mcp-vegetation-tools.js` (no tool fetches the repository).
- **Tests:** `test/vegetation-request.test.js`, `test/vegetation-checkout.test.js`, `test/vegetation-adapter.test.js`, `test/vegetation-queue.test.js`, `test/vegetation-service.test.js`, `test/vegetation-mcp.test.js`, `test/vegetation-ui.test.js`, with `test/fixtures/fake-seedthree/`. **Docs:** [Vegetation](VEGETATION.md).

## Definition of done

```powershell
node --test test/<your-tests>.test.js          # then: npm test
npm run build                                   # any React or frontend change
npm run i18n:check                              # any UI string
npm run log:check -- <changed files>            # when logging was added
npx eslint <changed js and jsx files>
npx prettier --check <changed files, including docs>
git diff --check
git status
```

- [ ] The shape is justified (page, service, job type or queue extension).
- [ ] Registered in **both** `vite.config.js` and `runtime/http-server.js` (services).
- [ ] Host, Origin and `X-Forge-Request` checks; validation on the server; unknown fields rejected; sizes capped.
- [ ] State is in the right place; migrations keep old data working.
- [ ] Empty, loading, error and unavailable states; labels, keyboard, live regions, reduced motion, phone width.
- [ ] Strings in the i18n layer with English defaults; ids and values untranslated.
- [ ] MCP tools bounded and annotated; no credentials, consent gates or unconfirmed destructive actions.
- [ ] Settings registered only for behavior a person may change; risky behavior staged behind a safe default.
- [ ] Crash and restart behavior decided and tested; nothing downloads or retries without a person.
- [ ] Docs, index, README list and tests updated; the handoff says what was and was not verified.
