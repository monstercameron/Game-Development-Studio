# docs/ rules

Applies inside `docs/` in addition to the [root rules](../AGENTS.md). Writing and layout conventions follow the [code style guide](CODE_STYLE.md). The index of every guide is [docs/README.md](README.md).

## What lives here

Durable documentation: installation, model sources, platform notes, the studio guide, MCP, the error, i18n, vegetation and Megascans guides, the roadmap, and the contributor guides ([code style](CODE_STYLE.md), [Adding a model](ADDING_A_MODEL.md), [Adding a feature](ADDING_A_FEATURE.md)). `docs/images/` holds screenshots; some are copied to the project site by `.github/workflows/pages.yml`.

## Invariants

- Write what is true now. Separate current behavior from planned behavior; planned work belongs in [ROADMAP.md](ROADMAP.md). Say what was verified, how, and when. A present file, a reachable service or a passing substitute test is not proof of a working model; do not imply it.
- Date measurements and observations ("checked 2026-11-08") and say which machine they came from. Never present an estimate as a measurement.
- Every path, command, function name, endpoint, setting key and MCP tool you mention must exist. Run `node --test test/docs-contributor.test.js` after editing a contributor guide; it fails on a missing path or a broken local link.
- Keep every local link resolving. Prefer repository-relative paths and `Desktop/<App>` or `%USERPROFILE%` over a new absolute user path; do not add private prompts, user names or credentials. Existing machine-specific paths are historical.
- Update the guide whose truth you changed, in the same change: [MODEL_SOURCES.md](MODEL_SOURCES.md) for sources, revisions, checksums and restore commands; [WINDOWS_ARM64.md](WINDOWS_ARM64.md) for patches (upstream source and version, reason, removal condition); [INSTALLATION.md](INSTALLATION.md) for installer steps; [MCP.md](MCP.md) for tools; [STUDIO_GUIDE.md](STUDIO_GUIDE.md) for user-facing behavior; [runtime/README.md](../runtime/README.md) and [test/README.md](../test/README.md) for new files and tests.
- When a system is not built yet, write a short, clearly marked line such as "Pending: see docs/X.md when it lands". Never describe unbuilt behavior as existing, and list pending lines in your handoff so a refresh pass can find them.
- Add a new guide to [docs/README.md](README.md) and, if it is an entry point, to the documentation list in `README.md`.
- Line endings are mixed. `AGENT_SETUP.md`, `INSTALLATION.md`, `STUDIO_GUIDE.md` and the root `README.md` are CRLF; most other files are LF. Check with `file <path>`, keep each file's style, and make anchored edits. A new file is LF.
- Documents here are Prettier-formatted (`.prettierrc.json`).

## Commands

```powershell
npx prettier --check docs/<file>.md            # every doc you edit
npx prettier --write docs/<file>.md            # only on files you created
node --test test/docs-contributor.test.js      # contributor guides and AGENTS.md files
git diff --check
```

Do not run `npm run format` over the repository. It rewrites files that are not yours.

## Common mistakes

- Documenting intended behavior as if it shipped, or copying a status from a stale guide without re-checking the code.
- A new guide that is not in the index, or a renamed file that leaves broken links.
- Hand-aligning Markdown tables (Prettier re-aligns them) or reformatting a whole CRLF guide for one edit.
- Quoting a command that does not exist in `package.json`, `install.ps1` or the tool's own usage text.
- Putting a token, key, prompt or private path in an example.
