# Error review

Forge collects the errors and stack traces it shows or writes, so you can review, copy and fix them in one place. Open it with the **Errors** button in the top bar (the badge counts errors that are new since you last opened it), with **Open error review** on the Diagnostics page, or with the link `/?dialog=errors` (add `&error=<id>` to open one error). Back and forward close and reopen the dialog.

## What is captured

| Source (stored id)       | What                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser (`browser`)      | Uncaught errors and unhandled promise rejections, render errors caught by an error boundary (with the component stack), studio API calls that return HTTP 500 or higher or fail to connect, and error toasts (messages that start with "Could not", "Cannot", "Failed" or "Unable to"). Validation hints and successes are not errors. |
| Render queue (`queue`)   | Failed, interrupted and needs-attention jobs that have an error message, read from `.forge-runtime/jobs.sqlite` (read-only). Only the job id, type, project id, status, stage and machine codes are kept. The request, which holds the prompt, is never read.                                                                          |
| Studio server (`server`) | Messages logged as errors by the studio host, and error-level lines and stack traces in `service-supervisor.log`, `runtime-worker.log` and the newest three `server-*-error.log` files.                                                                                                                                                |
| Engines (`engine:<id>`)  | Error-level lines (`ERROR`, `FATAL`, `CRITICAL`), Node stack traces and multi-line Python tracebacks (`Traceback (most recent call last):`, including chained exceptions) in `.forge-runtime/engine-<id>.log`.                                                                                                                         |

Logs are read every 20 seconds and when the dialog asks for a list, from a saved byte offset, so each line is read once. The first read of a log starts at its last 64 KB. A traceback that is still being written waits for its last line. Logs of external Desktop applications (YuE2, Stable Audio Lab, H3 Studio, Mammoth Studio) are shown on Diagnostics but are not ingested.

Repeats of the same failure are counted on one row. The fingerprint is a hash of the source, the message with ids, numbers and hashes removed, and the innermost five stack frames without line numbers. A resolved or verified error that happens again becomes **New** (a regression); an ignored error stays ignored.

## Storage, limits and retention

Errors are stored in `.forge-runtime/errors.sqlite` (app-level, not per project). Fields are capped: message 2,000 characters, stack 32,000 (head and tail are kept), context 4,000, note 4,000, AI suggestion 32,000. Browser reports are limited to 64 KB each and 60 per minute, and must match a fixed schema; unknown fields are rejected. At most 2,000 errors are kept, and errors not seen for 30 days are removed. **Clear resolved** deletes resolved errors after a second confirmation click; single errors can be deleted through the API with an explicit confirmation.

## Redaction

Redaction runs when an error is stored and again when it is displayed, copied, sent to OpenAI or posted to GitHub:

- Known folders become placeholders: `<repo>` (this checkout), `<projects>`, `<runtime>` (`.forge-runtime`) and `<home>`. File names and `file:line` stay.
- Other absolute paths keep only their last two parts (`<path>\folder\file.py`, `<site-packages>\torch\...`). Any `C:\Users\<name>`, `/home/<name>` and `/Users/<name>` becomes `<home>`, and your Windows user name becomes `<user>`. Loopback studio addresses become `<studio>`.
- API keys and tokens (`sk-...`, `hf_...`, GitHub, Slack, AWS, JWTs), `Bearer`/`Basic` credentials, `password=`-style values, secret query-string parameters and email addresses are replaced.

Copies use the redacted text. The **Include local paths** checkbox (off by default) shows and copies the real folders instead of the placeholders; secrets stay redacted. Redaction is pattern-based: an error message that quotes your own text (for example a file name or a phrase) can still contain it, so read the preview before sharing.

## Reviewing and fixing

Selecting an error marks it **Reviewed**. Each error shows its message, the stack with line numbers, the page, the render job (with a link to the render queue), the engine, the log file and the times. Buttons copy the error, a Markdown version for an issue or chat, the stack alone, or a ready-made prompt for another assistant. You can mark an error **Resolved**, **Ignored** or reopen it, and keep a note.

When a fix works, choose **Fix worked**, say who fixed it (you, the AI suggestion, or both) and optionally what fixed it. This sets the status **Fixed (verified)** and enables **Create GitHub issue**.

## Suggest a fix with GPT (optional)

**Suggest a fix with GPT** never runs automatically. It first shows **What will be sent**: the exact JSON request body (model, instructions and the input text with the redacted message, stack, a few facts such as the source and job type, the Forge version, and up to three excerpts of 13 lines of repository source around stack frames). Only **Send to OpenAI** sends it, and **Cancel request** stops a request in progress (OpenAI may still have received it).

- Source excerpts come only from source files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.py`, `.ps1`, `.css`) inside this checkout, resolved through real paths so links cannot leave it. Folders `models/`, `projects/`, `node_modules/`, `dist/`, `engines/`, `build/`, `coverage/`, any folder starting with a dot (including `.forge-runtime` and `.git`) and any path mentioning credentials, secrets, tokens or passwords are never read.
- The request goes from the studio server to `https://api.openai.com/v1/responses` (Responses API, `store: false`, at most 4,000 output tokens, 120 second timeout). The key is the OpenAI key saved under **Settings, API keys** (Windows-encrypted in `.forge-runtime/credentials/keys.sqlite`); it is read only for the request and never reaches the browser, a URL, logs, process arguments or `errors.sqlite`. The `OPENAI_API_KEY` environment variable is not used here.
- Without a saved key the panel shows **Add your OpenAI key in Settings**, which opens the Settings dialog.
- The model id is a setting (**Settings, AI assist**, or the Model field in the panel). The default `gpt-6.1-sol` is the name the user chose; Forge has not verified it exists. **Check model** asks OpenAI (`GET /v1/models/<id>`); if the id does not exist, Forge shows OpenAI's message and offers the ids your key can use.
- 401 (replace the key), 403 (no access to the model), 404 (choose another model), 429 (rate limit or quota) and 5xx (try later) are explained in the panel.
- The answer is shown as Markdown under **AI suggestion: review before using** and saved with the model and time on the error. Forge never applies a patch.

## GitHub issues for verified fixes

**Create GitHub issue** is available only for errors marked **Fixed (verified)**. It uses your own GitHub CLI login; Forge does not read or store GitHub tokens.

1. Forge reads the `origin` remote of this checkout (`git remote get-url origin`) and refuses anything that is not a `github.com` repository.
2. It checks `gh auth status`. If `gh` is missing or signed out, the preview says so (run `gh auth login` in a terminal) and still shows the text so you can copy it.
3. It searches existing issues for the fingerprint (`gh issue list --search "<fingerprint> in:body" --state all`). Matching issues are offered as **Comment on #N** instead of a duplicate.
4. The preview shows the exact title, labels and body and the line **This will be posted publicly on GitHub as owner/repo**. The label `bug` is added only if the repository has it.
5. **Create issue** runs `gh issue create --repo owner/repo --title ... --body-file <file>` (or `gh issue comment`). Every command is started with an argument list, never through a shell. The body file is written to a private temporary folder and deleted afterwards. The resulting link is saved on the error.

The issue body has the sections Summary, Environment (Forge version, OS, Node, source, engine id), Error (the redacted stack in a fenced block, capped at 12,000 characters), Root cause / fix that worked (your note, and the AI suggestion labelled as AI-generated unless you fixed it yourself), and Fingerprint (fingerprint, count, first and last seen). The body is capped at 60,000 characters.

## API

All routes are on the studio host, accept only loopback `Host` headers, and require `Origin` to be the studio and `X-Forge-Request: errors` for POST.

| Route                                                                       | Purpose                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/errors?status=&source=&q=&limit=`                                 | List, newest first. `source` is `browser`, `queue`, `server`, `engine` or `engine:<id>`.                                        |
| `GET /api/errors/<id>[?includePaths=1]`                                     | Detail.                                                                                                                         |
| `GET /api/errors/summary`                                                   | Unread count and totals by status.                                                                                              |
| `GET /api/errors/export?status=new`                                         | Up to 50 full errors, for **Copy all new**.                                                                                     |
| `POST /api/errors/report`                                                   | Browser report: `kind`, `message`, optional `stack`, `componentStack`, `page`, `context`.                                       |
| `POST /api/errors/opened`                                                   | Resets the unread count.                                                                                                        |
| `POST /api/errors/<id>/viewed`, `/status`, `/note`                          | Mark reviewed; set `status` (`new`, `reviewed`, `resolved`, `verified` with `fixSource` and `fixNote`, `ignored`); save a note. |
| `POST /api/errors/<id>/delete`                                              | Requires `{"confirm":"delete"}`.                                                                                                |
| `POST /api/errors/clear`                                                    | Requires `{"statuses":["resolved"],"confirm":"clear"}`; only resolved, verified or ignored.                                     |
| `GET`/`POST /api/errors/settings`, `POST /api/errors/settings/verify-model` | The fix model id; check it against OpenAI.                                                                                      |
| `POST /api/errors/<id>/fix-preview`, `/suggest-fix`                         | Preview, then send with the preview's `digest`. A changed preview returns 409.                                                  |
| `POST /api/errors/<id>/issue-preview`, `/issue`                             | Preview, then `{"mode":"create"}` or `{"mode":"comment","number":N}` with the `digest`.                                         |
| `POST /api/errors/test/server`, `/python`, `/api-failure`, `/delete`        | Test-error generator, see [Testing the error pipeline](#testing-the-error-pipeline).                                            |
| `GET`/`POST /api/ai-assist/settings`                                        | Shared provider and model per AI feature (`X-Forge-Request: ai-assist`).                                                        |

The MCP tools `forge_errors_list` and `forge_error_detail` read the same redacted data; see [MCP](MCP.md).

## AI assist settings

`runtime/ai-assist-settings.js` keeps one provider (`openai` or `local`) and model id per optional AI feature in `.forge-runtime/settings.sqlite`: `error-fix` (default OpenAI, `gpt-6.1-sol`), `vegetation-describe` (default OpenAI, `gpt-6-luna`) and `ui-translate` (default OpenAI, `gpt-6-luna`; used by [interface translation](I18N.md), OpenAI only). Model ids are 1 to 80 characters of letters, digits, `.`, `_`, `:`, `/` and `-`. The **AI assist** section of the Settings dialog edits all of them. Error messages in this review are English and are not translated by the interface language (see [I18N](I18N.md#what-is-never-translated)). Error fix suggestions support OpenAI only and refuse to send when the provider is set to local.

## Testing the error pipeline

Use this to check the whole pipeline with real errors, without waiting for a fault. Open **Diagnostics** and expand **Developer tools: Test the error pipeline** (collapsed by default). Each button creates one real error through the same path a real fault takes. Nothing here starts an engine, loads a model or uses the GPU, and nothing runs when the studio starts. The studio must have been restarted after this feature was added; an older studio answers 404 and the button says so.

Every generated error starts with `[Forge test error]` and embeds deliberately fake values (a folder under your home, an `sk-test-...` key, a `Bearer` token and an email address). Check that the rows show `<home>`, `[redacted-key]`, `Bearer [redacted]` and `<email>` instead.

| Button                               | What it does                                                                                                                                                                                                                                                                                                       | Expected row                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Browser: uncaught exception          | Throws inside a timer, so the window `error` event fires with a real stack.                                                                                                                                                                                                                                        | Browser, `Error: [Forge test error] Browser uncaught exception...`, stack with `throwTestException` and line numbers.           |
| Browser: unhandled promise rejection | Rejects a promise nobody handles, so `unhandledrejection` fires.                                                                                                                                                                                                                                                   | Browser, `Error: [Forge test error] Browser unhandled promise rejection...`.                                                    |
| Browser: React render error          | Renders a component that throws inside the **Render error sandbox** under the buttons. The real page error boundary shows its fallback there, the rest of the page keeps working, and **Reset sandbox** restores it.                                                                                               | Browser, `Error: [Forge test error] Browser React render error...`, with the component stack (`BrokenTestWidget`).              |
| Browser: failed API call             | Calls `POST /api/errors/test/api-failure`, which answers HTTP 500. The fetch wrapper reports it. This is the only `/api/errors` path the wrapper tracks.                                                                                                                                                           | Browser, `POST /api/errors/test/api-failure failed with HTTP 500: [Forge test error] Deliberate HTTP 500...`.                   |
| Server: thrown exception with stack  | The host throws through nested functions, catches the error and passes it to the host logger as `logger.error(message, { error })`, which is how the host reports unhandled errors. The capture stores the error's stack.                                                                                          | Studio server, `Unhandled error in POST /api/errors/test/server...`, stack frames in `runtime/errors-test-routes.js`.           |
| Engine-style Python traceback        | Starts `runtime/error_test_helper.py` (standard library only) with its stderr appended to `.forge-runtime/engine-test.log`, the way an engine log is written. It raises a `ValueError`, then a `TestConfigurationError ... from` it, then a `RuntimeError ... from` that. The scanner reads the chained traceback. | Engine test (`engine:test`), `RuntimeError: [Forge test error] Test worker failed to start...`, the full chained traceback.     |
| Engine-style uvicorn ASGI error      | The same helper, logging the way uvicorn does: `ERROR:    Exception in ASGI application` followed by the traceback.                                                                                                                                                                                                | `engine:test`; the log line is kept in the context as `logLine`. It can share a row with the traceback test (same fingerprint). |

Browser buttons show **Sent. The studio saved it** after the report arrived, or **Sent, but the studio has not confirmed saving it** if no confirmation came within four seconds (for example, an identical report within 30 seconds is dropped by the browser, or the studio is down). Each status is an `aria-live` region. Pressing a button again increases the count on the same row (the fingerprint ignores the run number).

The Python helper runs with the interpreter named by `FORGE_ERROR_TEST_PYTHON`, else `FORGE_TRANSCODE_PYTHON`, else the `Snapdargon-DJ\.runtime\python.exe` that `runtime/transcode.js` uses, else `python` on `PATH`. The log file is named `engine-test.log` (not `runtime-test.log`) because the scanner only reads `engine-<id>.log` files; the id `test` gives the source `engine:test`.

**Delete test errors** asks for a second click and then removes only rows whose message contains `[Forge test error]`. Real errors are kept. Statuses, notes, suggestions and issue links on test rows go with them.

To check the rest of the flow on a test row, open it in the error review and use **Copy error**, **Copy as markdown**, **Suggest a fix with GPT** (read **What will be sent**; no key is needed to see it) and **Fix worked** followed by **Create GitHub issue** (read the preview; do not post a test error publicly).

### Without the UI

```powershell
node tools/emit-test-error.mjs --port 5173 --kind server
node tools/emit-test-error.mjs --port 5173 --kind python --variant asgi
node tools/emit-test-error.mjs --port 5173 --kind browser-report
node tools/emit-test-error.mjs --port 5173 --kind delete
```

The script talks only to `127.0.0.1`, sends the studio `Origin` and `X-Forge-Request: errors` headers, prints the response, and exits 0 when the error was sent, 1 when the studio refused or could not be reached, and 2 for bad arguments. `browser-report` posts to the same ingest route the browser uses.

### Test routes

`POST /api/errors/test/server`, `/test/python` (`variant`: `traceback` or `asgi`), `/test/api-failure` and `/test/delete`. They require a loopback `Host`, a loopback peer address, `Origin` equal to the studio, `X-Forge-Request: errors` and a confirmation in the body (`{"confirm":"emit-test-error"}`, or `"delete-test-errors"` for delete). Creating errors is limited to 20 per minute (429 after that). `testRoutes: false` in `errorsService()` turns them off. `/test/api-failure` always answers 500 with `code: "test_api_failure"`.

### Automated end-to-end test

`node --test test/errors-e2e.test.js` starts the real studio host (a Vite server on a free loopback port with the real errors service and a temporary runtime folder) and runs every path above against it. It checks stored rows and sources, fingerprint counts, stack frames with line numbers, status changes and regressions, and **Delete test errors**. It also checks that the fake path, `sk-test-` key, `Bearer` token and email never appear in the list, detail, export, any copy format, the stored database bytes, the GPT preview, the request a fake OpenAI server received, the GitHub issue preview or the body given to a fake `gh`. It drives the real Diagnostics section in jsdom against that host and runs `tools/emit-test-error.mjs`. `test/error-pipeline-test-ui.test.js` covers the section in jsdom with a fake API. The Python tests need a Python interpreter (see above) and are skipped without one.

## Verification status

Automated tests cover capture, redaction, fingerprints, log and traceback parsing, retention, the HTTP routes, the fix flow against a fake OpenAI server on loopback, and the issue flow against a fake `gh` executable (see the [test guide](../test/README.md)). `test/errors-e2e.test.js` runs the pipeline against the real studio host with a real Python traceback (see [Testing the error pipeline](#testing-the-error-pipeline)). A live check in a restarted studio with a real browser is still a manual step. The real OpenAI call, the model id `gpt-6.1-sol`, and a real `gh issue create` against GitHub have not been exercised.
