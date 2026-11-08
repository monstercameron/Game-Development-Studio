# runtime/ rules

Applies inside `runtime/` in addition to the [root rules](../AGENTS.md). Map of the files: [runtime/README.md](README.md). Checklists: [Adding a model](../docs/ADDING_A_MODEL.md), [Adding a feature](../docs/ADDING_A_FEATURE.md).

## What lives here

The durable queue (`jobs.js`, `queue-order.js`), engine definitions and supervision (`engines.js`, `engine-*.js`), per-model adapters (`<name>-preparation.js`, `<name>-job.js`, `<name>_worker.py`, `<name>_backend.py`), HTTP services under `/api/...` (`*-service.js`), MCP tools (`mcp-*.js`), SQLite stores, and a few pure modules that `src/` also imports.

## Invariants

- Check the line ending before editing: `file runtime/jobs.js` or `git ls-files --eol runtime/jobs.js`. `jobs.js`, `engines.js`, `supervisor.js`, `model-load.js`, `service-preparation.js`, `auto-memory.js`, `recover-service.js`, `credentials.js` and several `*-preparation.js` files are CRLF. Use anchored single-line edits.
- Pure modules imported by `src/` (`video-options.js`, `sam31-options.js`, `vegetation-request.js`, `queue-order.js`, `queue-timing.js`, `error-redaction.js`, `error-format.js`, `model-catalog.js`, `log-fields.js`) must stay free of `node:` imports.
- A job type is not a registry entry: `jobs.js` has a branch at about fifteen sites. `grep -n "motion-bricks" runtime/jobs.js` finds them; add yours beside each.
- Engines are identified by the identity string in `/api/status`, never by an open port. Keep `catalog.js`, `jobs.js` and `worker.js` checks in step with the worker.
- Unknown remote outcomes become `interrupted` and are never resubmitted. Only an engine-reported failure (`engineFailure: true`) may be retried, by a person.
- Do not clear a model-load barrier, stop an engine or free memory without verifying live state first. Never stop a process Forge did not start.
- Validate at this boundary. Reject unknown fields, cap sizes, resolve project ids on the server, never accept a client path, URL or command.
- Services need loopback `Host`, studio `Origin` and a per-service `X-Forge-Request` on writes, and are registered in both `vite.config.js` and `runtime/http-server.js`.
- Write outputs through `job-io.js` (`saveAsset`) or `durable-file.js`: stage, fsync, commit without overwriting. Credentials only through `credentials.js`.
- Memory: the GPU budget is the admission limit; host RAM is a soft check (`model-load.js`, `host_memory.py`). Label budgets as estimates.

## Python workers (`*_worker.py`, `*_backend.py`)

- 4 spaces, Ruff (`ruff.toml`), double quotes. Bind `127.0.0.1`. Import `engine_identity` (it brings in `hidden_console`) and mark imports that follow `sys.path` edits `# noqa: E402`.
- Template: `sam31_worker.py` (status, load, generate, jobs, token-guarded stop/resume). Atomic output with `os.replace`, then `worker_outputs.py` can recover it.
- Require CUDA; raise a clear error instead of falling back to the CPU. Do not import a backend into the Node host.
- Tests use fake tensors and never load weights (`test/test_sam31_worker.py`).

## Commands

```powershell
node --test test/<related>.test.js              # then npm test for queue or engine changes
npx eslint runtime/<file>.js
npx prettier --check runtime/<file>.js
.\.venv-dev\Scripts\python.exe -m ruff check runtime/<file>.py
.\.venv-dev\Scripts\python.exe -m ruff format --check runtime/<file>.py
npm run log:check -- runtime/<file>.js             # when logging was added
```

Queue, ownership, artifact-deletion or API-contract changes need a focused failure and recovery test.

## Common mistakes

- Adding a job type in `jobs.js` but not in `job-recovery.js`, `queue-timing.js`, `asset-metadata.js` or `supervisor.js`.
- Registering a service in only one of the two hosts.
- Treating a timeout as "the job did not start".
- Logging a prompt, path or key, or putting a key in a URL, argument or error message.
- Reformatting a CRLF file, or a large unrelated cleanup in `jobs.js`.
