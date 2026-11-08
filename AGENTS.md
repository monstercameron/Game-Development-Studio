# Forge engineering rules

These rules apply to the whole repository. Explicit user and higher-priority instructions take precedence; a more specific `AGENTS.md` applies within its directory. Read the relevant code and documentation before changing a subsystem. If a rule conflicts with a required change, explain the tradeoff in the handoff instead of silently hiding it.

Forge is a local React asset studio with a durable render queue and separately supervised model processes. Start with [agent setup](docs/AGENT_SETUP.md), the [runtime map](runtime/README.md), and the [test guide](test/README.md). Model origins, downloads, and platform patches are in [model sources](docs/MODEL_SOURCES.md), [installation](docs/INSTALLATION.md), and [Windows ARM64 notes](docs/WINDOWS_ARM64.md).

## Where to find things

- Writing code: the [code style guide](docs/CODE_STYLE.md) (formatting, line endings, naming, patterns, lessons learned) and [linting and formatting](docs/CODE_QUALITY.md) for the commands.
- Adding a model or engine: [Adding a model](docs/ADDING_A_MODEL.md). Adding a page, service or queue behavior: [Adding a feature](docs/ADDING_A_FEATURE.md).
- Planned integrations: the [roadmap](docs/ROADMAP.md). Pinned model sources: [model sources](docs/MODEL_SOURCES.md). Everything else: the [documentation index](docs/README.md).
- Each of `runtime/`, `src/`, `test/`, `docs/`, `tools/` and `site/` has its own `AGENTS.md` with the invariants, commands and common mistakes for that directory. It applies inside that directory in addition to this file.

## Working behavior

- Inspect `git status` first. Preserve existing user changes, generated assets, model files, credentials, and unrelated running applications. Do not reset, clean, overwrite, or stop them as a convenience.
- Read the owning implementation and callers; follow the actual data flow through the affected layers. Search for existing helpers before adding abstractions or dependencies. Keep changes scoped and remove obsolete code introduced by the change.
- Deliver working behavior, not a mock, disabled button, fake metric, or success message standing in for unfinished work. Clearly identify unavailable capabilities and unverified behavior in the UI and handoff.
- Preserve durable queue semantics, project isolation, local-only service boundaries, and recoverable artifact deletion. Do not make a large download or unrelated network call an implicit side effect of a render.
- Before starting, stopping, or loading a model, inspect live queue and service state. Preserve active jobs and unrelated processes; a port or documented PID alone does not establish ownership. Do not automatically retry a submission whose remote outcome is unknown.
- Local inference targets native Windows ARM64 and NVIDIA CUDA. Do not introduce WSL or silently fall back to CPU inference. CPU preprocessing and file operations are separate from inference.
- A source checkout does not include model weights, compiled engines, external applications, Python environments, credentials, or runtime state. Do not present web-app installation as a complete one-command model installation.
- Treat Windows commit/system memory and GPU memory as distinct constraints. An estimate, a present file, or a reachable service is not proof of available memory, a loaded model, or successful inference.
- Do not read secrets into output or commit credentials, tokens, local databases, logs, generated assets, model weights, downloaded binaries, or caches. Review error messages and logs before sharing; avoid exposing private prompts and local paths unnecessarily.
- Report what changed, what was tested, and material limitations. Distinguish substitute-worker tests, real GPU inference, and visual/audio quality checks. Do not claim verification that did not happen.

## Ownership and file placement

- `src/`: React views, hooks, browser-only behavior, client-side presentation helpers, and styles. Place new components near the related existing feature; shared code must have real reuse or a clear boundary. Put parameter help in `src/tooltips/` where that system applies.
- `runtime/`: queue, model adapters, process supervision, validation at the runtime boundary, MCP, engine lifecycle, and Python workers. Keep model-specific behavior in its adapter/worker; keep generic orchestration independent of a particular view or model.
- Repository-root services and `server.js`: existing application host and service entry points. Extend the owning service; avoid adding unrelated root-level modules. `vite.config.js` is configuration, not a home for product logic.
- `test/`: automated tests and small deterministic fixtures in `test/fixtures/`. Follow the existing `*.test.js` and `*_test.py` patterns. Tests must use temporary directories for mutable state and must not write into real projects or models.
- `docs/`: durable installation, architecture, operations, and recovery documentation. Update `docs/MODEL_SOURCES.md` and platform notes when sources, revisions, checksums, download instructions, or compatibility patches change. Use `README.md` for entry points, not detailed implementation inventories.
- `public/`: deliberately shipped static assets. `models/`, `projects/`, `.forge-runtime/`, `dist/`, `node_modules/`, and external Desktop applications contain local or generated state; do not commit or reorganize them as source code.
- Do not move existing files solely to enforce this layout. When adding a feature, document any exceptional placement and preserve established interfaces.

## Formatting and linting

ESLint, Prettier, and Ruff are configured; see [the code quality guide](docs/CODE_QUALITY.md) for installation, commands, scope, and the existing backlog. Run the applicable checks on changed files, and report existing failures honestly. Never claim a whole-repository check passed if only a subset ran. Avoid repository-wide auto-fixes or reformatting in unrelated work.

- Use UTF-8 text, consistent line endings within a file, a final newline, and no trailing whitespace. Run `git diff --check` before handoff.
- Write readable, multiline code. Use two spaces for JavaScript, JSX, JSON, and CSS indentation; four spaces for Python; and four spaces for PowerShell. Do not use tabs for indentation. Preserve an established local format when making a small targeted edit rather than reformatting a whole file.
- Use semicolons in JavaScript, single quotes for ordinary JavaScript strings, double quotes for JSX attributes, and trailing commas in multiline literals and argument lists where supported. Use parentheses and braces to make control flow unambiguous; never rely on compressed one-line control flow for new logic.
- Keep lines reasonably short (target 100 characters; break longer lines when it improves readability). Do not split a URL, command, or string simply to meet a column count. Separate unrelated statements with blank lines; avoid excessive vertical space.
- Group imports at the top: built-ins, external packages, then local modules. Remove unused imports, parameters, variables, and dead branches. Use ES modules for JavaScript unless an existing runtime boundary specifically requires CommonJS.
- Prefer `const`; use `let` only when reassignment is needed and never use `var`. Use strict equality, explicit defaults, guard clauses, and descriptive named helpers for nontrivial conditions. Avoid deeply nested ternaries and broad implicit coercion.
- Do not silence lint, type, test, or security warnings to make a change pass. A necessary exception must be narrowly scoped, explain why, and have a concrete follow-up when appropriate. Never add empty catches or discard promises without deliberate error handling.
- Python follows PEP 8 naming, four-space indentation, context managers for owned resources, and explicit exceptions. PowerShell scripts must work with the project's documented Windows PowerShell environment, quote paths, check external-command exit codes, and avoid repurposing system environment variables.

## Naming and interfaces

- Choose names that describe domain meaning and units: `freeMemoryMiB`, `contextTokens`, `outputPath`, `isModelLoaded`. Avoid ambiguous abbreviations, generic names such as `data` or `temp` for long-lived values, and misleading names that imply an estimate is a measurement.
- JavaScript variables/functions use `camelCase`; React components and classes use `PascalCase`; hooks use `use` plus `PascalCase`; true immutable constants use `UPPER_SNAKE_CASE`. Boolean names should read as questions (`is`, `has`, `can`, `should`). Event handlers use `handle...` internally and `on...` for callback props.
- New React component files use `PascalCase.jsx`; new JavaScript helpers and CSS files use descriptive `kebab-case`; Python modules/functions/variables use `snake_case`, Python classes use `PascalCase`, and PowerShell functions use approved `Verb-Noun` names. Match an existing subsystem's established naming when extending it; do not rename public files casually.
- Keep public JSON, HTTP, MCP, queue, model IDs, filenames, and persisted field names stable unless migration is explicitly part of the change. Validate and normalize untrusted inputs at each process/API boundary. Document units, accepted values, defaults, and failure modes in the owning contract.
- Name asynchronous work and state precisely (`isLoading`, `queued`, `interrupted`, `unknown`). Keep display labels separate from persisted identifiers. Do not conflate an unknown state with success, idle, or an empty result.

## React, styling, and UX

- Use shared design tokens from the existing theme for color, typography, spacing, borders, radii, and motion. Add a reusable token when the design system lacks one; avoid hard-coded repeated values and per-page copies. Keep component styles scoped and avoid broad selectors or `!important` as a shortcut.
- Design for desktop and ultrawide layouts. Ensure readable contrast, predictable spacing, usable empty/loading/error states, and content that does not overflow. Respect `prefers-reduced-motion`; animation must not block interaction.
- Use semantic elements, visible labels, keyboard-operable controls, visible focus, and meaningful accessible names. Do not communicate status through color alone. Dialogs need accessible titles, focus management, escape/close behavior, and focus restoration where appropriate.
- Navigable panels and appropriate modal/configuration state belong in the existing router and URL so back/forward and direct links work. Preserve project context and validate route parameters. Keep ephemeral input state local unless sharing or persistence is required.
- Keep React rendering pure. Manage subscriptions, timers, streams, and requests with cleanup; prevent stale responses from overwriting newer state. Avoid mutating props/state and avoid derived state that can become inconsistent. Memoize only when correctness or measured performance warrants it.
- Use plain, accurate copy and units. Status, queue and time estimates must identify what they measure and handle unknown values. Errors should be actionable and copyable without leaking credentials. Do not make a UI claim of completion before the runtime confirms it.

## Reliability, security, and data

- Validate request schemas, file types, sizes, project IDs, and path containment on the server; never trust browser filtering or a client-supplied absolute path. Prevent traversal and handle Windows path and symlink/reparse-point behavior. Avoid shell string interpolation with untrusted input; pass arguments separately.
- Use timeouts and cancellation where appropriate, clean up resources, and make partial failures recoverable. Do not swallow errors; add useful context without leaking secrets. Isolate model/worker crashes from the host and preserve evidence for recovery.
- Preserve queue leases, persisted state, idempotency and model-load barriers. Do not infer that a timed-out remote job or process has stopped. Changes to queue transitions, artifact deletion, process ownership, or API contracts require focused regression tests for failure and recovery paths.
- Write generated outputs to the correct project, use atomic or staged writes where supported, and preserve recoverable trash behavior. Destructive model removal or permanent trash clearing must remain explicit and appropriately guarded.
- Store credentials only through the existing credential service; never put keys in source, URLs, logs, test fixtures, process arguments, or error messages. Keep loopback services local by default and do not weaken authentication or ownership checks.

## Comments and documentation

- Favor clear names and small functions. Comments explain **why**, invariants, non-obvious ownership, units, concurrency, compatibility workarounds, or a source; do not narrate obvious syntax or preserve stale explanations.
- Use `//` for JavaScript, `#` for Python/PowerShell, and `/* ... */` for CSS. Use short sentences with normal punctuation. Document externally consumed functions or contracts with JSDoc or Python docstrings when parameters, return values, or failure modes are not obvious.
- Record the upstream source and version, reason, and removal condition for native or model compatibility patches. A `TODO` must state the remaining work and its context; do not use vague TODOs as a substitute for completing the requested behavior. Never include secrets or private user data in comments or fixtures.
- Update the relevant README or `docs/` guide when installation steps, model sources, environment requirements, platform workarounds, endpoints, configuration, or verification status change. Keep examples executable and distinguish current behavior from planned behavior.

## Verification and completion

1. Select tests from [the test guide](test/README.md) based on the changed behavior. Add focused, meaningful regression tests for consequential logic and failure paths; avoid tests that merely repeat the implementation. Use isolated fixtures and fake services for ordinary protocol tests.
2. Run `node --test` with relevant test files, or `npm test` for the full JavaScript suite when the scope warrants it. Run the appropriate Python unit tests in the documented environment for Python changes. Inspect tests before running anything that may start services or load weights.
3. Run `npm run build` for React or frontend configuration changes. If a studio is serving the build, avoid disrupting active work: inspect queue state and use an isolated build or preserve existing assets. A successful build does not replace UI or accessibility verification.
4. For user-facing changes, check the affected flow and its error, empty, and keyboard states where practical. Real GPU tests can consume substantial memory; inspect live services and both memory budgets before running them. Never stop unrelated work to make a test pass.
5. Run `git diff --check`, inspect the final diff and repository status, and report checks run, failures, and untested limitations. Do not commit unless asked. A mock render, passing test, or present model file is not proof of real inference or output quality.
