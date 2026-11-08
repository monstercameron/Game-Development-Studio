# tools/ rules

Applies inside `tools/` in addition to the [root rules](../AGENTS.md). These are developer scripts, not part of the shipped studio.

## What lives here

- `i18n-extract.mjs`, `i18n-scan.mjs`, `i18n-ast.mjs`: the interface-translation tooling ([I18N](../docs/I18N.md)). `npm run i18n:extract`, `i18n:check`, `i18n:scan`.
- `log-coverage.mjs`: finds code that should log but does not ([logging conversion guide](../docs/LOGGING_CONVERSION_GUIDE.md)). `npm run log:coverage`, `log:check`.
- `model-capacity.mjs`: measures `models/` and rewrites the project site's capacity table. `npm run site:capacity`.
- `emit-test-error.mjs`: emits a test error for the Errors review pipeline ([Error review](../docs/ERRORS.md)).
- `enable-tailscale-ssh.ps1`: configures remote access ([Tailscale guide](../docs/TAILSCALE_REMOTE.md)).

## Invariants

- Read a script before running it. State what it reads, writes and contacts. Scripts here never start, stop or load a model, never read credentials and never send data off the machine. `model-capacity.mjs` makes only two read-only GET requests, to a loopback studio.
- `enable-tailscale-ssh.ps1` changes system settings (a service, firewall rules, SSH configuration). Do not run it. Use `-CheckOnly` only when the user asked, and report its output.
- Generated files are written atomically and only when the check passes: `i18n-extract.mjs` refuses to write when there are errors. Run `i18n:extract` once after a batch of conversions, never from several agents in parallel.
- A `--check` mode exits non-zero on a problem and writes nothing. Keep that contract in any new check.
- Exported functions are imported by tests (`test/i18n-tools.test.js`, `test/site-capacity.test.js`); keep their signatures stable, or update the test in the same change.
- Node ES modules (`.mjs`), two-space indentation, Node globals only (the ESLint config applies `globals.node` to `tools/`). Add no dependency without checking the lockfiles; `@babel/parser` is already imported by the i18n and log tools.
- `model-capacity.mjs` fails when a folder over 100 MiB under `models/` is not in `ROW_DEFINITIONS`. Add the new model there; never edit `site/model-capacity.json` by hand.
- Scripts must not print secrets, prompts or absolute user paths, and must pass arguments to child processes as arrays.
- New tools get a usage comment at the top (what it does, options, side effects), a `package.json` script if people will run it often, and a test.

## Commands

```powershell
node --test test/i18n-tools.test.js            # extractor and scanner on test/fixtures/i18n/
node --test test/site-capacity.test.js         # capacity tool and site table
node --test test/errors-e2e.test.js            # uses emit-test-error.mjs
npm run i18n:check                             # whole-repository i18n check
npm run log:check -- runtime/<file>.js
npx eslint tools/<file>.mjs
npx prettier --check tools/<file>.mjs
```

## Common mistakes

- Running `npm run site:capacity` without the weights or without the studio running, and committing the resulting numbers.
- Running `npm run i18n:extract` while another change is mid-conversion, then committing a half-regenerated catalog.
- Making a tool depend on `src/` or `runtime/` internals that are not exported.
- A script that works only because of the current working directory (resolve paths from `import.meta.url`).
