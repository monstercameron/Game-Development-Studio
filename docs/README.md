# Forge documentation

- [Studio guide](../README.md): launch, status, queue, API, and user workflows.
- [Windows installation guide](INSTALLATION.md): installer options, every model's sources, and remaining engine setup.
- [Agent setup and handoff](AGENT_SETUP.md): safe first steps, local dependencies, verification, and troubleshooting.
- [Model sources and restoration](MODEL_SOURCES.md): repository identities, recorded revisions, representative hashes, download commands, and external application dependencies.
- [Windows ARM64 runtime and rebuild notes](WINDOWS_ARM64.md): source checkouts, local patches, toolchain, platform changes, and verification limits.
- [Runtime map](../runtime/README.md): service, worker, queue, and engine adapter responsibilities.
- [Test guide](../test/README.md): isolated tests and real GPU checks.
- [Studio behaviour settings](SETTINGS.md): the typed settings registry shared by the Settings dialog, `/api/settings` and the `forge_settings_*` MCP tools, every key with its default, when it applies and what is deliberately not a setting.
- [Resilience](RESILIENCE.md): what each piece of durable state does after a crash, power loss, reboot, sleep or forced shutdown, the Recovery report and panel, database backups and restore, and the manual crash drills.
- [Studio log](LOGGING.md): the structured application log in `.forge-runtime/logs.sqlite` (Node, Python and browser loggers, spool ingest, retention, `/api/logs`, Diagnostics > Studio log, `forge_logs_query`), and the [logging conversion guide](LOGGING_CONVERSION_GUIDE.md) with `tools/log-coverage.mjs` for instrumenting one file at a time.
- [Error review](ERRORS.md): captured errors, redaction, optional GPT fix suggestions, GitHub issues for verified fixes, and the `/api/errors` routes.
- [Interface translation (i18n)](I18N.md): the `t`/`tp`/`<T>` API, key rules, catalogs and tools, the pseudo-locale, and optional per-page machine translation with OpenAI (`/api/i18n`).
- [i18n conversion guide](I18N_CONVERSION_GUIDE.md): step-by-step rules for converting one UI file to the i18n layer.
- [Roadmap and to-do list](ROADMAP.md): planned integrations that are not built yet, starting with OmniSVG.
- [Refreshing the capacity figures](STUDIO_GUIDE.md#refreshing-the-capacity-figures): how the project site's model count and total weight size are measured and regenerated (`npm run site:capacity`).
- [Linting and formatting](CODE_QUALITY.md): developer tool installation, checks, and formatting commands.
- [Code style guide](CODE_STYLE.md): formatting, line endings, naming, file placement, React and backend patterns, tests, and the lessons this repository learned the hard way.
- [Adding a model or engine](ADDING_A_MODEL.md): the ordered checklist, the files to touch and why, the verification protocol, and the definition of done.
- [Adding a feature or page](ADDING_A_FEATURE.md): choosing a service, job type or page, registering routes in both hosts, MCP exposure rules, settings, tests, and traced examples.

The model and runtime state can change independently of the documentation. Check service status and Diagnostics before starting work or removing model files.
