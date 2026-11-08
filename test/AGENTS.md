# test/ rules

Applies inside `test/` in addition to the [root rules](../AGENTS.md). What each group of tests covers: [test/README.md](README.md). Style: [code style guide](../docs/CODE_STYLE.md#tests).

## What lives here

`*.test.js` (Node `node --test`), Python tests (`test_*.py` and `*_test.py`), and small deterministic fixtures in `test/fixtures/`. `npm test` runs `test/*.test.js` only; Python tests are run separately.

## Invariants

- Read a test before running it. Know what it starts. Ordinary tests never start a real engine, load weights, use the GPU or reach the network.
- Mutable state goes in a temporary directory created per test (`fs.mkdtemp`) and removed afterwards. Never write into `projects/`, `models/` or `.forge-runtime/`. (`fixtures/load-jsx.js` compiles components into `test/.jsx-*`, which is git-ignored; that is the one in-tree exception.)
- Use fakes: a loopback server on port 0 (`listen(0, '127.0.0.1')`), `fixtures/mock-engine.js`, `fixtures/fake-fab.js`, `fixtures/fake-seedthree/`, injected `fetcher`, `freeMemory` and `hardware`, and the real `JobQueue` on a temporary database.
- UI tests run in jsdom. Create the DOM before importing React DOM. Compile components with `loadJsx('Name.jsx')` (`fixtures/load-jsx.js`) or Vite's SSR loader (`vegetation-ui.test.js`).
- MCP tests drive the real stdio bridge `runtime/mcp.js` against a fake studio (`mcp-engine-control.test.js`).
- Test failure and recovery paths for queue transitions, artifact deletion, process ownership and API contracts, not only success.
- Never put a real key, token, private prompt or local path in a test or fixture.
- Say in `test/README.md` what a new test proves and what it does not. A substitute-worker test proves protocol and recovery behavior, not real inference or output quality.
- Real-model checks (`trellis_dinov3_cuda_test.py`, `trellis_pipeline_load_test.py`) can consume gigabytes. Inspect live queue, services and both memory budgets first; never stop unrelated work to make one pass.
- About forty test files are CRLF (for example `test/model-catalog.test.js`, `test/worker-recovery.test.js`). Check with `file` and keep each file's line endings.

## Commands

```powershell
node --test test/<name>.test.js                 # one file
npm test                                         # full JavaScript suite
npx eslint test/<name>.test.js
npx prettier --check test/<name>.test.js
.\.venv-dev\Scripts\python.exe -m ruff check test/<name>_test.py
```

Python worker tests run with the environment named in `test/README.md` (for example `.forge-runtime\sam3-python-embed\python.exe -I test\test_sam31_backend.py`). Ruff covers `runtime` and `test`.

## Common mistakes

- A test that passes because a fake always succeeds; add the failing case.
- Leaving a server, timer or child process running (use `t.after(...)` to close it).
- Timing sleeps instead of waiting for a condition with a deadline (`waitFor` in `sam31-queue.test.js`).
- Tests that depend on the real `models/`, the user's projects or a running studio.
- Sharing state between tests through module-level variables or a fixed port.
- Adding a test file but not listing it in `test/README.md` with its limits.
