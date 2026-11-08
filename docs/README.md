# Forge documentation

- [Studio guide](../README.md): launch, status, queue, API, and user workflows.
- [Windows installation guide](INSTALLATION.md): installer options, every model's sources, and remaining engine setup.
- [Agent setup and handoff](AGENT_SETUP.md): safe first steps, local dependencies, verification, and troubleshooting.
- [Model sources and restoration](MODEL_SOURCES.md): repository identities, recorded revisions, representative hashes, download commands, and external application dependencies.
- [Windows ARM64 runtime and rebuild notes](WINDOWS_ARM64.md): source checkouts, local patches, toolchain, platform changes, and verification limits.
- [Runtime map](../runtime/README.md): service, worker, queue, and engine adapter responsibilities.
- [Test guide](../test/README.md): isolated tests and real GPU checks.
- [Error review](ERRORS.md): captured errors, redaction, optional GPT fix suggestions, GitHub issues for verified fixes, and the `/api/errors` routes.
- [Interface translation (i18n)](I18N.md): the `t`/`tp`/`<T>` API, key rules, catalogs and tools, the pseudo-locale, and optional per-page machine translation with OpenAI (`/api/i18n`).
- [i18n conversion guide](I18N_CONVERSION_GUIDE.md): step-by-step rules for converting one UI file to the i18n layer.
- [Roadmap and to-do list](ROADMAP.md): planned integrations that are not built yet, starting with OmniSVG.
- [Linting and formatting](CODE_QUALITY.md): developer tool installation, checks, and formatting commands.

The model and runtime state can change independently of the documentation. Check service status and Diagnostics before starting work or removing model files.
