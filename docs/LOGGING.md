# Studio log (structured application logging)

Forge keeps one structured, searchable log for every part of the studio: the studio host, the
render queue worker, forked job processes, the MCP bridge, Python engines and the browser. It is
stored in `.forge-runtime/logs.sqlite` and reviewed under **Diagnostics > Studio log**, through
`/api/logs` and through the `forge_logs_query` and `forge_logs_summary` MCP tools.

It is separate from the older per-process text logs (`engine-<id>.log`, `server-*.log`,
`runtime-worker.log`, `service-supervisor.log`), which still exist and are still shown under
Diagnostics > Studio logs and by the `forge_logs` MCP tool. Those capture raw console output and
may contain private text; the studio log is designed not to.

To add logging to a file, read [the conversion guide](LOGGING_CONVERSION_GUIDE.md). This page
describes the design.

## What a record is

```json
{
  "ts": 1794157178620,
  "level": "info",
  "component": "queue",
  "event": "job.state.changed",
  "message": "",
  "fields": { "from": "queued", "to": "running" },
  "process": "worker",
  "pid": 4808,
  "traceId": "9f2c4e1ab07d3c55",
  "jobId": "job-123",
  "durationMs": null,
  "seq": 17,
  "count": 1,
  "firstTs": null
}
```

- `event` is a constant id `<area>.<noun>.<verb>` (2 to 6 lowercase segments).
- `component` comes from a fixed registry (`LOG_COMPONENTS` in `runtime/log-fields.js`).
- `fields` holds only **allow-listed** names with typed values: ids, counts, bytes, durations,
  booleans, short enum words, route templates, and a described error (class, code, redacted
  message, top 5 frames). Unknown names and wrongly typed values are dropped; the record keeps
  `droppedFields` and `droppedFieldNames` so mistakes are visible.
- Every string is redacted with the shared rules in `runtime/error-redaction.js` plus one log rule:
  file and folder names under `<home>`, `<projects>`, `<path>` and `<user>` keep only their
  extension (`<projects>\<file>.png`).
- `count` > 1 and `firstTs` mark a collapsed burst of identical records.

Limits: event 96 characters, message 300, string field 160, error message 300, 32 fields, 20
array items, fields JSON 4096 characters. A record never exceeds about 6 KB.

## APIs

| Where                                          | Import                             | Create                              |
| ---------------------------------------------- | ---------------------------------- | ----------------------------------- |
| Node (runtime/, root services)                 | `runtime/app-log.js`               | `const log = createLogger('queue')` |
| Python (runtime/*.py)                          | `runtime/app_log.py` (stdlib only) | `log = get_logger("image")`         |
| Browser (src/)                                 | `src/app-log.js`                   | `const log = createLog('image')`    |
| runtime/ modules also bundled into the browser | `runtime/shared-log.js` (pure)     | `const log = createLogger('queue')` |

`runtime/shared-log.js` has the same API as `createLogger` and hands records to whichever real
logger the process loaded (Node or browser); records logged before that are kept (at most 200)
and replayed. `tools/log-coverage.mjs` flags a browser-bundled module that imports `app-log.js`.

Every logger has `trace`, `debug`, `info`, `warn`, `error(eventId, fields?, message?)`,
`isEnabled(level)`, `time(eventId, fields?) -> stop(extra?)` and `child(context)`. Node also has
`withLogging(asyncFn, 'image.render')`, which logs `.started` (debug), `.completed` (info, with
`durationMs`) and `.failed` (error) and rethrows unchanged. Python also has `warning` (alias),
`install_logging_handler(component)` (routes existing `logging.getLogger` output, keeping only the
message template when `%` arguments are used, never the argument values) and
`install_excepthook(component)` (uncaught exceptions on the main and other threads).

```js
import { createLogger, withLogging } from './app-log.js';

const log = createLogger('engine');
log.info('engine.start.requested', { engineId: 'images', port: 8189 });
const stop = log.time('model.load.completed', { modelId: 'Qwen/Qwen-Image' });
// ...
stop({ gpuUsedMiB: 18_400 });
const jobLog = log.child({ jobId });
jobLog.warn('queue.admission.waited', { reason: 'waiting_memory', requiredMiB, freeMiB });
```

Guarantees, in all three languages:

- A call never throws into the caller, including for invalid events, unknown components, hostile
  getters, BigInt or circular values.
- A call below the active level costs one comparison (measured about 0.1 microseconds in Node).
  An enabled call validates, redacts and buffers in memory (measured 10 to 40 microseconds); it
  never waits for disk.
- Nothing is written to the console.

### Levels

`trace` < `debug` < `info` < `warn` < `error`. The default is `info`. The level comes from, in
order: the `FORGE_LOG_LEVEL` environment variable (for example `info` or `warn,queue=debug`),
then the `logs.level` and `logs.componentLevels` settings (Settings > Studio app, or
`forge_settings_set`), then `info`. Node and Python read the two settings straight from
`.forge-runtime/settings.sqlite` and cache them for 5 seconds, so every process follows a change
without a restart and without importing the settings registry. The browser uses `info`, or
`localStorage['forge.logLevel']` for that tab.

### Trace ids

A trace id correlates one request or job across processes.

- The studio host gives every `/api` request a trace id (the browser's `x-forge-trace` header
  when valid, else a new one), returns it in the `x-forge-trace` response header, and attaches it
  to everything logged while the request is handled (Node `AsyncLocalStorage`).
- `runWithTrace(id, fn)`, `currentTraceId()`, `traceHeaders()` and `traceEnv()` propagate it.
  Pass `{ ...process.env, ...traceEnv() }` to a forked or spawned process (it reads
  `FORGE_TRACE_ID`), and `traceHeaders()` to an engine HTTP call.
- Python: `set_trace_id(id)` per thread; `FORGE_TRACE_ID` is read at start.
- Diagnostics > Studio log > a record > **Show everything for this trace** shows all records with
  that id, from every process, without the time-range limit.

## Storage and the multi-process decision

**Decision: every process appends to its own spool file; only the studio host writes SQLite.**

```text
 host ─┐                                   (owner)
 worker ┤  append JSONL every 250 ms   ┌──────────────────┐   BEGIN IMMEDIATE
 *-job  ┼──► .forge-runtime/log-spool/ ─►  log-ingest.js   ├──► logs.sqlite (WAL)
 python ┤    <proc>-<pid>-<thread>-     │  every 1 s, ≤4000│   rows + offset in one
 mcp   ─┘    <start>-<n>.jsonl          │  lines per pass  │   transaction
 browser ── POST /api/logs/ingest ──► host's own spool    └──────────────────┘
```

Why not direct batched SQLite writes from each process:

- `node:sqlite` and Python `sqlite3` are synchronous. With several writers, a lock wait blocks the
  caller's thread for up to `busy_timeout`: a render loop, an HTTP handler or a Python request
  thread would stall. A short timeout instead turns contention into lost records or `SQLITE_BUSY`
  errors, which are hard to make reliable on Windows (shared-memory WAL index, antivirus scans).
- Each process would hold a database connection, schema migration would race between versions,
  and an engine crash during a transaction would leave its batch unwritten anyway.

Why spool files:

- A writer touches only its own file, opened, appended and closed per flush, so there is no
  cross-process locking and no `EBUSY`; Windows' share modes never conflict because the ingester
  only reads files and deletes them once the writer has moved on or exited.
- Writers flush every 250 ms or at 50 records (Node: one asynchronous append in flight; Python: a
  daemon thread) and synchronously on exit, on an uncaught exception (Node
  `uncaughtExceptionMonitor`, Python `excepthook`/`atexit`). A hard kill loses at most the last
  250 ms.
- The host ingests with `BEGIN IMMEDIATE`, inserting rows and advancing the file's byte offset in
  the same transaction, so a second ingester (two hosts, or a restart mid-pass) can never
  duplicate or skip lines, and a partial last line waits for the next pass.
- A file is deleted only when fully ingested **and** it can no longer grow: the same writer has
  rolled to a newer file (files roll at 4 MiB) or the writer's process has exited.
- When the host is not running, spool files wait. Each process stops writing (and counts drops)
  when its own unconsumed spool exceeds 32 MiB.
- Ingest is bounded to 4000 lines per pass to keep the host responsive.

Evidence (`test/app-log.test.js`): 4 Node writer processes x 500 records plus a Python writer
x 500 run concurrently while the ingester runs every 20 ms: all 2500 rows arrive, no duplicates
(unique process, pid, seq), no rejected lines, no errors, and all spool files are removed. A
crash test logs three records and throws: all three plus `process.exception.uncaught` arrive.
Two ingesters on separate connections process the same file without duplicates.

Tests keep records out of the real `.forge-runtime`: under `node --test` (and in any process it
spawns that inherits `NODE_TEST_CONTEXT`, Node or Python) and under Python `unittest`/`pytest`,
without `FORGE_RUNTIME_DIR`, records go to an in-memory sink (`readMemoryLogRecords()`,
`read_memory_records()`). A script or worker started by hand, or by a test that strips its
environment, writes to the real spool; set `FORGE_LOG_SINK=off` or a temporary
`FORGE_RUNTIME_DIR` for those. `FORGE_LOG_SINK=off|memory|spool` overrides the choice;
`FORGE_LOG_DIR` moves the spool folder.

### Hot loops, rate limits and drops

- **Collapsing**: per process, identical records (same level, component, event, job id and
  message) pass 20 times per 10-second window; further repeats are counted and written as one
  summary record with `count`, `firstTs` and `fields.collapsed: true` when the window ends.
- **Rate limit**: a token bucket of 1000 records refilled at 200 per second per process.
- **Buffer cap**: 5000 pending records per process.
- Every drop is counted and reported by a `log.records.dropped` warning (`droppedCount`,
  `reason`: `rate`, `buffer`, `spool` or `write`). The browser reports its own drops with each
  batch; the host counts rejected browser records and unparsable spool lines. The Studio log view
  and `/api/logs/summary` show all of these.

### Schema (`logs.sqlite`, schema version 1)

```sql
logs(id INTEGER PRIMARY KEY, ts INTEGER /* ms since epoch */, level TEXT, component TEXT,
     event TEXT, message TEXT, fields TEXT /* JSON */, process TEXT, pid INTEGER,
     trace_id TEXT, job_id TEXT, duration_ms INTEGER, seq INTEGER,
     count INTEGER /* 1, or the size of a collapsed burst */, first_ts INTEGER)
indexes: logs(ts), logs(component, ts), logs(level, ts), logs(job_id), logs(trace_id)
logs_fts: FTS5 over event and message (external content, kept by triggers)
spool_offsets(file TEXT PRIMARY KEY, offset INTEGER, updated_at INTEGER)
counters(name TEXT PRIMARY KEY, value INTEGER)   -- e.g. browser_dropped_records
meta(key TEXT PRIMARY KEY, value TEXT)            -- schema_version, last_vacuum_ts
```

The database uses WAL, `synchronous=NORMAL`, `busy_timeout=2000` and `auto_vacuum=INCREMENTAL`.
A newer schema version than the running code understands is refused rather than modified.

### Retention

| Limit | Default      | Setting                         | Environment                |
| ----- | ------------ | ------------------------------- | -------------------------- |
| Age   | 14 days      | `logs.retentionDays` (1 to 365) | `FORGE_LOG_RETENTION_DAYS` |
| Size  | 256 MiB used | `logs.maxSizeMiB` (16 to 4096)  | `FORGE_LOG_MAX_MIB`        |

The host prunes 30 seconds after it starts and every 6 hours: rows older than the age limit,
then the oldest rows (5 % per batch) while the used size is over the limit. Deletes run in
batches of 5000 rows in short transactions; `PRAGMA incremental_vacuum` returns free pages, and a
full `VACUUM` runs at most once a week when more than half of the file is free. `DELETE
/api/logs` removes rows older than N days on request.

## HTTP routes (studio host, `runtime/logs-service.js`)

All routes need a loopback `Host` and, when an `Origin` is sent, the studio's own origin.

| Route                               | Header                     | Notes                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/logs/ingest`             | `X-Forge-Request: app-log` | Browser batches `{ records, droppedCount? }`: at most 100 records and 128 KiB, 60 batches per 10 s (429 after). Each record is rebuilt with the shared rules; unknown keys, events or components reject that record (counted).                      |
| `GET /api/logs`                     | `X-Forge-Request: logs`    | Newest first. `level` (minimum), `component` (comma list), `event` (prefix), `text` (FTS words, at most 200 characters), `since`/`until` (ms or ISO), `jobId`, `traceId`, `process`, `limit` (1 to 500, default 100), `cursor` (from `nextCursor`). |
| `GET /api/logs/summary`             | `logs`                     | Counts by level and component, top 20 events, drop and collapse counters, file and WAL size, retention limits, ingest backlog. Same filters.                                                                                                        |
| `GET /api/logs/tail`                | `logs`                     | Rows with id greater than `after`, oldest first, and the new `cursor`. Same filters.                                                                                                                                                                |
| `GET /api/logs/export?format=jsonl` | `logs`                     | Redacted JSON lines, oldest first, at most 50,000 rows. Same filters.                                                                                                                                                                               |
| `DELETE /api/logs`                  | `logs` + studio `Origin`   | `{ "olderThanDays": N, "confirm": true }`; `0` deletes everything.                                                                                                                                                                                  |

`GET /api/logs` **without** the header and `GET /api/logs/stream` are still the older file-log
snapshot routes from `diagnostics.js`; the logs service passes them through unchanged.

The logs service is registered first in `runtime/http-server.js` and `vite.config.js` so its
request middleware covers every later `/api` route: it logs `http.request.completed` (debug),
`http.request.rejected` (4xx except 404, info) and `http.request.failed` (5xx, warn) with method,
route template, status and duration. Route templates replace ids and every segment after
`projects`, `jobs`, `assets` and similar parents with `:param`; query strings are never kept.

## Browser capture (`src/app-log.js`)

`src/app-log-install.js` (imported once by `src/main.jsx`) turns on automatic capture:

- `ui.route.changed` with the first path segment as `page` (never project names or queries).
- `http.request.failed` / `http.request.aborted` for same-origin `/api` calls made with `fetch`:
  method, route template, status, duration. Successful calls are `debug`.
- `ui.action.clicked` with `actionId` for elements that have `data-log-action="..."` and for
  buttons with an `id`. Never text, values or input contents.

Batches of 20 records (or every 2 seconds) are posted with `fetch` (`keepalive` on page hide).
A failed send is dropped and counted; at most 200 records wait. `createLog(component, context,
{ sampleRate })` keeps only that fraction of trace/debug/info records for noisy events.
`localStorage['forge.logConsole'] = '1'` echoes records to the console in a development build.

## Review UI

Diagnostics > **Studio log** (`src/StudioLogView.jsx`) shows the database:

- filters for minimum level, component, time range, event prefix, search words and job id, kept in
  the URL (`logLevel`, `logComponent`, `logRange`, `logEvent`, `logText`, `logJob`, `logTrace`),
  so back/forward and links work;
- consecutive identical records grouped with a count; levels written out, not only coloured;
- a detail panel (fields, process, job, trace, duration) with **Show everything for this trace**,
  **Show everything for this job** and **Copy record**; Escape closes it and returns focus;
- **Live tail** (polls every 2 seconds), **Copy shown records**, **Export (JSON lines)**, **Load
  older records**;
- record count, database size, retention, dropped records, collapsed repeats and rejected fields;
- loading, empty and error states, keyboard operation, a narrow-screen layout and i18n strings
  under `diagnostics.studioLog.*`.

## MCP

- `forge_logs_query`: the same filters (`level`, `components`, `event`, `text`, `sinceMinutes`,
  `jobId`, `traceId`), `limit` 1 to 200, `cursor`; one compact line per record, output capped at
  60,000 characters.
- `forge_logs_summary`: the summary as JSON.

Both are read-only. `forge_logs` still reads the raw per-process files.

## Privacy

The studio log is built to be shareable after a review: field names are allow-listed, string
values must be identifiers or short words without spaces, every string is redacted, error
messages are capped at 300 characters, and the browser never sends typed values, bodies or query
strings. The remaining risk is a free-text **message** or an **error message** that embeds user
text (for example a library error that quotes an input). Messages must be constant sentences (see
the conversion guide); error messages are redacted and truncated but not removed. Review an export
before sharing it.

## Operations

- Volume: at `info`, expect a few records per render, engine action and page view. `debug` and
  `trace` can be much larger; the size limit protects the disk.
- Restart: the logs service starts with the studio host (both `npm run dev` and the service
  host). A host started before this change does not ingest; spool files wait and are ingested on
  the next start. Engines and job processes pick up the logger when they are next started.
- Removing the database: stop the studio, delete `.forge-runtime/logs.sqlite*`; it is recreated.
  `log-spool/` may be deleted while no Forge process runs.

## Finding where logging is missing

`node tools/log-coverage.mjs <file>` prints a TODO list for one file: empty or swallowed catch
blocks, catch blocks that only rethrow, network calls, child processes and threads, file writes,
SQLite writes, state transitions, process handlers, timers, route handlers and promises without a
handler, with line numbers, whether each is already logged and a hint. `--check <file>` exits 1
while a required signal (swallowed error, external call, state transition, process spawn) has no
logging nearby. `--repo [--json]` ranks every source file by gap score (3 per missing required
signal, 1 per missing recommended one). npm scripts: `npm run log:coverage`, `npm run log:check --
<file>`. A false positive is silenced with `// log-coverage: ignore -- <reason>` on the line or
the line above.
