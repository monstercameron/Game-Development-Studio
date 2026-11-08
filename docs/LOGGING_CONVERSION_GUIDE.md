# Logging conversion guide (one file at a time)

This guide is for an agent that adds structured logging to **one source file**. Read it fully
before editing. The design and the storage are described in [LOGGING.md](LOGGING.md); you do not
need them to do this job.

## The job in seven steps

1. Run the coverage tool on your file and keep the TODO list it prints:

   ```powershell
   node tools/log-coverage.mjs runtime/your-file.js
   ```

2. Read the file and its callers enough to understand what each TODO line does.
3. Add **one import** and **one logger** at the top (section "Setup").
4. For each TODO, add the smallest log call that answers "what happened, to which id, how long,
   and why it failed" (sections "What to log" and "Examples"). Never log what is listed under
   "Never log".
5. Keep the diff minimal: unique small edits, no reformatting, no renamed variables, no moved
   code. If the file uses CRLF line endings (for example `runtime/jobs.js`, `src/main.jsx`),
   keep CRLF. Re-read the file before every edit; other agents may be editing nearby.
6. Check it:

   ```powershell
   node tools/log-coverage.mjs --check runtime/your-file.js   # must exit 0
   npx eslint runtime/your-file.js
   node --test test/<the tests that cover this file>.test.js
   ```

   For Python: `.\.venv-dev\Scripts\python.exe -m ruff check runtime/your_file.py` and the
   matching `test/*_test.py` or `test/test_*.py` with `python -m unittest`.

7. Report: number of log calls added, the `--check` result, the tests you ran, and any TODO you
   marked with an ignore comment (with its reason).

Do not change behaviour. A log call must never change a return value, a thrown error, timing
that matters, or control flow. Do not add `try`/`catch` only to log; log inside the existing
`catch` instead.

## Setup

### Node (runtime/, server.js)

```js
import { createLogger } from './app-log.js'; // from runtime/*.js
// import { createLogger } from './runtime/app-log.js'; // from server.js

const log = createLogger('queue');
```

Put the import with the other local imports and the `const log = ...` line after the imports. If
the file already has a variable called `log` or `logger`, name yours `appLog`.

### runtime/ modules that the browser also imports

Some `runtime/*.js` files are imported by `src/` too (today: `queue-order.js`, `queue-timing.js`,
`three-d-chain.js`, `chat-memory.js`, `chat-sampling.js`, `chat-image-limits.js`,
`sam31-options.js`, `video-options.js`, `vegetation-request.js`, `error-format.js`, and anything
they import). They are bundled into the web page, where `app-log.js` (which uses Node built-ins)
breaks the build. Use the browser-safe logger with the same API instead:

```js
import { createLogger } from './shared-log.js';

const log = createLogger('queue');
```

The coverage tool reports `browser-node-logger` (required) if such a file imports `app-log.js`.
When in doubt, run `npx vite build --outDir <a temporary folder>`.

### Browser (src/)

```js
import { createLog } from './app-log.js'; // from src/*.js(x)

const log = createLog('image'); // a registered component: 'image', not 'images'
```

Failed `/api` requests, route changes and clicks on buttons with an `id` or a `data-log-action`
attribute are captured automatically in the browser; do not log them again.

### Python (runtime/*.py)

```python
from app_log import get_logger, install_excepthook, install_logging_handler

log = get_logger("image")
```

Workers already import siblings such as `worker_outputs` the same way. In a worker's `main()` (or
`if __name__ == "__main__":`) add, once:

```python
install_excepthook("image")
install_logging_handler("image")  # only if the file already uses logging.getLogger
```

### Pick the component

Use the component that owns the file. The full list is `LOG_COMPONENTS` in
`runtime/log-fields.js`:

`assets asr catalog chat credentials desktop diagnostics engine errors game gpu http i18n image
install log mcp megascans memory metadata model motion music power projects queue references
runtime segmentation server settings sfx supervisor three-d thumbnails transcode trash tray ui
vegetation video voices world`

| File                                                                                 | Component                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------- |
| `runtime/jobs.js`, `queue-*.js`, `chain-unload.js`, `worker.js`                      | `queue`                                     |
| `runtime/engines.js`, `engine-*.js`, `force-stop.js`, `external-model-stop.js`       | `engine`                                    |
| `runtime/model-*.js`, `model_convert.py`                                             | `model`                                     |
| `runtime/image-*.js`, `qwen_worker.py`                                               | `image`                                     |
| `runtime/video-*.js`, `h3_*.py`                                                      | `video`                                     |
| `runtime/music-*.js`                                                                 | `music`                                     |
| `runtime/sfx-*.js`, `sound-*.js`                                                     | `sfx`                                       |
| `runtime/tts-*.js`, `tts_worker.py`, `voice-modes.js`                                | `voices`                                    |
| `runtime/asr-*.js`, `asr_guard.py`                                                   | `asr`                                       |
| `runtime/world*`, `world_*.py`                                                       | `world`                                     |
| `runtime/hunyuan*`, `trellis*`, `three-d-chain.js`, `glb-stats.js`                   | `three-d`                                   |
| `runtime/sam31*`                                                                     | `segmentation`                              |
| `runtime/hymotion*`, `motionbricks*`                                                 | `motion`                                    |
| `runtime/game*`                                                                      | `game`                                      |
| `runtime/chat-service.js`, `runtime/chat-*.js`, `mammoth_worker.py`, `src/Chat*.jsx` | `chat`                                      |
| `runtime/vegetation-*`                                                               | `vegetation`                                |
| `runtime/megascans-*`                                                                | `megascans`                                 |
| `runtime/error*`, `errors-*`                                                         | `errors`                                    |
| `runtime/i18n-*`, `src/i18n/*`                                                       | `i18n`                                      |
| `runtime/core-settings.js`, `ai-assist-settings.js`                                  | `settings`                                  |
| `runtime/projects.js`, `runtime/project-assets.js`                                   | `projects`                                  |
| `runtime/asset-*.js`, `clips.js`, `references.js`                                    | `assets`                                    |
| `runtime/credential-service.js`, `runtime/credentials.js`                            | `credentials`                               |
| `runtime/power.js`, `runtime/tray-*.js`                                              | `power` / `tray`                            |
| `runtime/host-supervisor.js`, `supervisor.js`                                        | `supervisor`                                |
| `runtime/http-server.js`, `server.js`                                                | `http` / `server`                           |
| `runtime/mcp*.js`                                                                    | `mcp`                                       |
| `runtime/thumbnails.js`, `transcode*`                                                | `thumbnails` / `transcode`                  |
| Other React views in `src/`                                                          | the feature (`image`, `video`, ...) or `ui` |

## The API (frozen)

```js
log.trace(eventId, fields?, message?)
log.debug(eventId, fields?, message?)
log.info(eventId, fields?, message?)
log.warn(eventId, fields?, message?)
log.error(eventId, fields?, message?)
log.isEnabled('debug')                 // true when that level would be written
const stop = log.time(eventId, fields) // later: stop(extraFields) -> durationMs
const jobLog = log.child({ jobId })    // same component, extra context on every record
withLogging(asyncFn, 'image.render')   // logs .started (debug), .completed, .failed; rethrows
```

Python has the same methods (`warning` is an alias of `warn`), and `log.child(jobId=job_id)`.

- `eventId` is a **constant** string `<area>.<noun>.<verb>`: lowercase, dot-separated, 2 to 6
  segments, for example `job.state.changed`, `engine.start.failed`, `model.load.completed`.
  Never build it from variables.
- `fields` is an object of **allowed field names** (below). Anything else is dropped and the
  record says which names were dropped (`droppedFieldNames`), so a mistake is visible, not fatal.
- `message` is optional, a short constant English sentence. Never interpolate values into it.
- Calls never throw and never wait for disk. Do not wrap them in `try`.

### Levels

| Level   | Use for                                                                                                                                                                    | Default |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `error` | An operation failed and the user or a job is affected (render failed, engine crashed, write failed).                                                                       | on      |
| `warn`  | Something went wrong but was handled (retry, fallback, refused input, expected failure that may need attention).                                                           | on      |
| `info`  | Lifecycle and state changes worth reading later (job queued/started/completed, engine started/stopped, model loaded, setting changed, migration ran). A few per operation. | on      |
| `debug` | Detail for diagnosing a problem (cache hits, chosen options, expected and harmless failures in a `catch`).                                                                 | off     |
| `trace` | Very chatty detail (each poll, each chunk). Rarely needed.                                                                                                                 | off     |

### Field names (allow-list)

A field is kept only if its **name** matches one of these rules **and** its value has the right
type. Names describe meaning and unit.

| Name rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Value                                                                          | Examples                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ends with `Ms`, `Sec`, `Seconds`, `Minutes`, `Hours`, `Days`, `Bytes`, `KiB`, `MiB`, `GiB`, `Count`, `Total`, `Index`, `Percent`, `Ratio`, `Tokens`, `Px`, `Width`, `Height`, `Fps`, `Frames`, `Steps`, `Seed`, `Size`, `Limit`, `Attempt(s)`, `Pid`, `Port`, `Status`, `Code`, `Version`, `Depth`, `Length`, `Max`, `Min`, `Rate`, `Score`, `Position`, `Priority`; or exactly `count`, `bytes`, `attempt`, `status`, `pid`, `port`, `exitCode`, `width`, `height`, `steps`, `seed`, `total`, `index`, `limit`, `position`, `priority`, `mib`                                                                                    | finite number                                                                  | `durationMs`, `freeMiB`, `requiredMiB`, `outputBytes`, `retryCount`, `queueLength`, `httpStatus`, `exitCode` |
| starts with `is`, `has`, `can`, `should`, `was`, `did`, `will`, `needs`, `uses` + capital; or exactly `ok`, `ready`, `cached`, `forced`, `dryRun`, `retry`, `enabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | boolean                                                                        | `isLoaded`, `hasOutput`, `wasCancelled`                                                                      |
| ends with `Id`, `Hash`, `Sha`, `Digest`, `Revision`; or exactly `id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | id string (letters, digits, `. _ : + / -`, no spaces, at most 128) or a number | `jobId`, `engineId`, `modelId`, `projectId`, `assetId`, `traceId`, `chainId`                                 |
| ends with `Ids`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | array of ids (first 20 kept)                                                   | `jobIds`                                                                                                     |
| exactly `from`, `to`, `state`, `previousState`, `nextState`, `status`, `reason`, `kind`, `type`, `mode`, `method`, `route`, `host`, `phase`, `stage`, `action`, `outcome`, `result`, `policy`, `backend`, `device`, `dtype`, `precision`, `format`, `extension`, `page`, `view`, `code`, `errorClass`, `errorCode`, `signal`, `source`, `target`, `provider`, `feature`, `settingKey`, `component`, `operation`, `direction`, `decision`, `trigger`, `transport`, `protocol`, `platform`, `arch`, `quality`, `resolution`, `aspect`, `voiceMode`, `language`, `locale`, `scope`, `category`, `engine`, `model`, `unit`, `version` | short word (letters, digits, `_ . : + / = -`, no spaces, at most 80)           | `{ from: 'queued', to: 'running' }`, `{ reason: 'waiting_memory' }`, `{ route: '/api/jobs/:id' }`            |
| exactly `error` or `err`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | an Error / exception                                                           | expands to `errorClass`, `errorCode`, a redacted `errorMessage` and the top 5 frames                         |

`jobId`, `traceId` and `durationMs` get their own database columns, so always use exactly those
names. Every kept string is redacted (paths become `<repo>`, `<home>`, `<path>\x\y`; keys,
tokens and emails are removed). If you need a field the rules reject, choose a name that matches
a rule (`outputBytes`, not `output`); do not add names to the allow-list from a per-file task.

## What to log

| Situation                                                  | Level                            | Event pattern                                                                | Fields                                                                                          |
| ---------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Process, service or worker start and stop                  | info                             | `<area>.process.started` / `.stopped`                                        | `pid`, `port`, `version`, `durationMs`                                                          |
| Job or queue state transition                              | info                             | `job.state.changed`                                                          | `jobId`, `from`, `to`, `reason`                                                                 |
| Engine start, stop, health, ownership decision             | info / warn                      | `engine.start.requested`, `engine.health.failed`, `engine.ownership.decided` | `engineId`, `pid`, `port`, `decision`, `reason`, `durationMs`                                   |
| Model load / offload                                       | info                             | `model.load.completed`, `model.unload.completed`                             | `modelId`, `engineId`, `durationMs`, `gpuUsedMiB`, `gpuFreeMiB`, `hostFreeMiB`                  |
| Admission decision                                         | info                             | `queue.admission.waited`                                                     | `jobId`, `reason: 'waiting_memory'`, `requiredMiB`, `freeMiB`                                   |
| HTTP request completion (server)                           | debug / warn                     | `http.request.completed`                                                     | `method`, `route` (template), `status`, `durationMs`                                            |
| External call (OpenAI, Fab/Epic CDN, GitHub, Hugging Face) | info / warn                      | `<area>.request.completed` / `.failed`                                       | `host`, `status`, `durationMs`, `attempt`                                                       |
| Validation failure                                         | warn                             | `<area>.request.rejected`                                                    | `reason` (the rule, e.g. `too_long`), `settingKey` or a field name as `target`; never the value |
| Retry, cancellation, recovery, restart                     | warn / info                      | `<area>.job.retried`, `job.cancel.requested`, `engine.recovery.completed`    | ids, `attempt`, `reason`                                                                        |
| Setting change                                             | info                             | `settings.value.changed`                                                     | `settingKey`, `source` (never the value if it could be personal)                                |
| Migration                                                  | info                             | `<area>.migration.completed`                                                 | `version`, `rowCount`, `durationMs`                                                             |
| File operation                                             | debug (success) / warn (failure) | `assets.file.written`, `assets.file.deleted`                                 | `kind` (`output`, `thumbnail`, ...), `bytes`, `extension`; never the path                       |
| Swallowed error in a `catch`                               | debug if expected, warn if not   | `<area>.<noun>.failed`                                                       | `{ error }`, plus ids                                                                           |
| Spawned process                                            | info                             | `<area>.process.spawned` / `.exited`                                         | `kind`, `pid`, `exitCode`, `signal`, `durationMs`                                               |
| UI navigation and actions (browser)                        | info                             | automatic; explicit `ui.<page>.<action>` only for important actions          | `actionId`, `page`                                                                              |

Every `catch` that does not rethrow must log at least at `debug` with `{ error }`. Use `warn`
when it is not expected in normal operation. A `catch` that only rethrows needs nothing.

## Never log

- Prompts, negative prompts, chat messages, transcripts, lyrics, descriptions, names or any text
  typed by a user.
- File contents, request or response bodies, query strings, image/audio/video data, base64.
- Credentials, API keys, tokens, cookies, `Authorization` headers.
- Absolute paths, file names chosen by users, user names, emails, machine names.
- Whole objects (`{ job }`, `{ options }`, `{ body }`): pick the few safe fields instead.

The allow-list blocks most of these automatically, but do not rely on it: never pass them.

## When not to log

- Pure functions (parsing, formatting, math) and small helpers with no side effects.
- Hot loops, per-frame rendering, per-token streaming, per-chunk audio, progress polling: log
  once before and after, or keep a counter and log the total. If a loop must log, use `trace`.
- React render bodies. Log in event handlers and effects, not while rendering.
- Code that already logs the same event one layer up or down.

A file with no signals in the coverage tool needs **no** logging; leave it unchanged.

## Opting out of a signal

If a TODO is a false positive (for example a `status` property on a plain data object that is
being built, not a state change), put this comment on the line before it:

```js
// log-coverage: ignore -- builds a response object, not a state change
```

```python
# log-coverage: ignore -- probe for an optional module; absence is normal
```

The reason after `--` is required. Use this sparingly; the coordinator reviews every ignore.

## Examples

### 1. Empty catch (Node)

```js
// before
try {
  fs.unlinkSync(tempFile);
} catch {}

// after
try {
  fs.unlinkSync(tempFile);
} catch (error) {
  log.debug('assets.temp.cleanup.failed', { error });
}
```

### 2. Fallback catch

```js
// before
} catch {
  return defaultOptions;
}

// after
} catch (error) {
  log.warn('image.options.read.failed', { error, reason: 'using_defaults' });
  return defaultOptions;
}
```

### 3. Job state transition

```js
// before
job.status = 'running';

// after
log.info('job.state.changed', { jobId: job.id, from: job.status, to: 'running' });
job.status = 'running';
```

### 4. Admission decision with memory numbers

```js
if (freeMiB < requiredMiB) {
  log.info('queue.admission.waited', {
    jobId: job.id,
    reason: 'waiting_memory',
    requiredMiB,
    freeMiB,
  });
  return 'waiting_memory';
}
```

### 5. External HTTP call

```js
// before
const response = await fetch(url, { method: 'POST', headers, body });

// after
const stop = log.time('errors.openai.request.completed', { host: 'api.openai.com' });
const response = await fetch(url, { method: 'POST', headers, body });
stop({ status: response.status });
```

On failure, the existing `catch` gets `log.warn('errors.openai.request.failed', { host:
'api.openai.com', error })`.

### 6. HTTP route handler (server side)

```js
if (!isValidProjectId(projectId)) {
  log.warn('projects.request.rejected', { route: '/api/projects/:id', reason: 'invalid_id' });
  return json(res, 400, { error: 'Invalid project.' });
}
```

### 7. Forked job process (runtime/*-job.js)

```js
import { createLogger } from './app-log.js';

const log = createLogger('image');

process.on('message', async (message) => {
  const jobLog = log.child({ jobId: message.jobId });
  const stop = jobLog.time('image.job.completed');
  try {
    await run(message);
    stop({ outcome: 'completed' });
  } catch (error) {
    stop({ outcome: 'failed', error });
    throw error;
  }
});
```

The trace id is inherited automatically from the `FORGE_TRACE_ID` environment variable.

### 8. Spawned process

```js
const child = spawn(executable, args, { windowsHide: true });
log.info('engine.process.spawned', { engineId, pid: child.pid });
child.on('exit', (exitCode, signal) => {
  log.info('engine.process.exited', { engineId, exitCode, signal });
});
```

### 9. Whole async function

```js
// before
export async function convertModel(options) { ... }

// after: wrap at the export, leaving the body untouched
async function convertModelUnlogged(options) { ... }
export const convertModel = withLogging(convertModelUnlogged, 'model.convert');
```

Only do this when the function is not already logged inside and its callers do not depend on
`convertModel.name` or `this`.

### 10. Python worker

```python
from app_log import get_logger, install_excepthook

log = get_logger("world")

def load_model(variant: str) -> None:
    stop = log.time("model.load.completed", {"modelId": variant})
    try:
        ...
    except torch.cuda.OutOfMemoryError as error:
        log.error("model.load.failed", {"modelId": variant, "error": error, "freeMiB": free_mib()})
        raise
    stop()

if __name__ == "__main__":
    install_excepthook("world")
    main()
```

### 11. Python swallowed exception

```python
# before
try:
    temp.unlink(missing_ok=True)
except OSError:
    pass

# after
try:
    temp.unlink(missing_ok=True)
except OSError as error:
    log.debug("voices.temp.cleanup.failed", {"error": error})
```

### 12. React effect with a request

```js
useEffect(() => {
  let isCurrent = true;
  loadModels()
    .then((models) => {
      if (isCurrent) {
        setModels(models);
      }
    })
    .catch((error) => {
      log.warn('model.list.load.failed', { error });
      if (isCurrent) {
        setError(error.message);
      }
    });
  return () => {
    isCurrent = false;
  };
}, []);
```

The fetch itself is already captured; log only what the view decides (here, that the list could
not be shown).

### 13. React action handler

```js
async function handleRemove() {
  log.info('model.remove.requested', { modelId });
  ...
}
```

Never log the text of an input. If you want a button click recorded, give the button a
`data-log-action="models.remove"` attribute instead of a log call.

### 14. Fire-and-forget promise

```js
// before
refreshThumbnails(projectId);

// after
refreshThumbnails(projectId).catch((error) => {
  log.warn('thumbnails.refresh.failed', { projectId, error });
});
```

Only add `.catch` where a rejection would otherwise be unhandled; keep behaviour unchanged.

### 15. Setting change

```js
log.info('settings.value.changed', { settingKey: key, source: via });
```

### 16. Retention or migration

```js
log.info('errors.retention.completed', { deletedCount: result.changes, durationMs });
```

## Testing what you added

- Under `node --test`, records go to memory instead of `.forge-runtime` (unless the test sets
  `FORGE_RUNTIME_DIR`). To assert on them:

  ```js
  import { clearMemoryLogRecords, readMemoryLogRecords } from '../runtime/app-log.js';

  clearMemoryLogRecords();
  await doTheThing();
  const events = readMemoryLogRecords().map((record) => record.event);
  assert.ok(events.includes('job.state.changed'));
  ```

- Python under `unittest` uses memory too: `app_log.read_memory_records()`.
- A test that spawns a worker process without `FORGE_RUNTIME_DIR` should pass
  `FORGE_LOG_SINK=off` (or a temporary `FORGE_RUNTIME_DIR`) in the child environment.
- Run the file's existing tests; logging must not change their results. Do not add tests for
  ordinary log lines; add one only for a log that carries important logic (for example an
  admission decision with memory numbers).

## Checklist before you finish

- [ ] Only registered component and constant event ids.
- [ ] No prompts, text, paths, bodies or secrets passed in fields or messages.
- [ ] `node tools/log-coverage.mjs --check <file>` exits 0.
- [ ] ESLint (or Ruff) passes for the file; `git diff --check` is clean.
- [ ] Line endings unchanged (CRLF files stay CRLF); no reformatting.
- [ ] The file's tests pass.
