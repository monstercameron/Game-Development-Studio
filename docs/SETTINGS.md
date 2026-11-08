# Studio behaviour settings

Forge has one typed registry of user-facing behaviour settings and toggles, in `runtime/core-settings.js`. The **Studio behaviour** section of the Settings dialog, the `/api/settings` routes and the `forge_settings_*` MCP tools all read and change that same list, so a person and an agent see the same values, the same limits and the same history.

This guide covers where settings live, how a value is chosen, every registered key, what is deliberately not a setting, and how to add one. For the log settings (`logs.*`) see also [Logging](LOGGING.md) if it is present in your checkout.

## How a value is chosen

For every key the registry returns one effective value, in this order:

1. **An explicit environment variable.** It still wins, so deployment configuration is never silently overridden. The setting is reported as _locked by environment_ with the variable's name, and any attempt to change or reset it is refused (`locked_by_environment`, HTTP 409). Change or remove the variable and restart the studio to unlock it.
2. **A saved override** in `.forge-runtime/settings.sqlite`, table `settings_overrides(key, value_json, updated_at, source)`.
3. **The default** in the table below.

Four settings already had a store of their own. The registry **adapts** those stores and keeps no second copy: the AI assist table `ai_assist`, `asr-latency.json`, the keep-awake service and the interface-language preference in `i18n.sqlite`. Their source is reported as `store`.

| Source        | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `default`     | Nothing saved; the default applies.                                             |
| `override`    | A value saved in `settings_overrides` (through Studio or MCP).                  |
| `environment` | An environment variable decides; the setting is locked.                         |
| `store`       | The value lives in one of the four existing stores above (never locked by env). |

### When a change applies

| Effect             | Meaning                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`             | Applies immediately.                                                                                                                                                                        |
| `next-job`         | Read each time the queue prepares a job (and by engines Forge starts afterwards), so it applies to the next render with no restart. Processes cache saved overrides for at most 1.5 s.      |
| `restart-required` | Read once at startup. The value is saved now and takes effect after the named process restarts. Settings never stop or start an engine or the studio, so a restart is always your decision. |

The queue worker, the studio host and the job processes each read through `getSetting(key)` in `runtime/core-settings.js`. It resolves the environment first, then the saved overrides (cached for 1.5 s and shared between processes through SQLite), then the default. A damaged or locked settings file never fails a render: the last good copy, or the defaults, are used and `readError()` records why.

### Audit

Every applied change adds a row to `settings_audit(id, key, action, old_json, new_json, source, changed_at)`: `action` is `set` or `reset`, `source` is `ui` or `mcp`. The table is append-only (SQLite triggers refuse updates and deletes). Values are never secrets: the registry holds none. The studio host also writes one structured console line per change (`{"source":"settings","event":"settings_changed",...}`), and the list returns the last 10 changes. A repeated identical value is not a change and is not audited.

## Registered settings

Defaults, effects and sources are checked against the registry by `test/core-settings.test.js`; `test/settings-docs.test.js` fails if a key is missing from this table. "MCP" says whether `forge_settings_set` can change it; it can unless the key is locked by an environment variable. No setting is read-only today, but the registry supports `mutable: false` for displayed-only values.

| Key                              | Group     | Allowed values                              | Default       | Applies                                | Source                     | Environment lock                                                    | MCP |
| -------------------------------- | --------- | ------------------------------------------- | ------------- | -------------------------------------- | -------------------------- | ------------------------------------------------------------------- | --- |
| `engines.autoStart.images`       | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_IMAGE`; `FORGE_IMAGE_URL` locks it off            | yes |
| `engines.autoStart.video`        | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_VIDEO`; `FORGE_VIDEO_URL` locks it off            | yes |
| `engines.autoStart.world`        | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_WORLD`; `FORGE_WORLD_URL` locks it off            | yes |
| `engines.autoStart.tts`          | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_TTS`; `FORGE_TTS_URL` locks it off                | yes |
| `engines.autoStart.hunyuan`      | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_HUNYUAN`; `FORGE_HUNYUAN_URL` locks it off        | yes |
| `engines.autoStart.trellis`      | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_TRELLIS`; `FORGE_TRELLIS_URL` locks it off        | yes |
| `engines.autoStart.sam31`        | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_SAM31`; `FORGE_SAM31_URL` locks it off            | yes |
| `engines.autoStart.hymotion`     | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_HYMOTION`; `FORGE_HYMOTION_URL` locks it off      | yes |
| `engines.autoStart.motionbricks` | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_MOTIONBRICKS`; `FORGE_MOTIONBRICKS_URL` locks off | yes |
| `engines.autoStart.music`        | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_MUSIC`; `FORGE_MUSIC_URL` locks it off            | yes |
| `engines.autoStart.sound`        | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_START_SOUND`; `FORGE_SFX_URL` locks it off              | yes |
| `engines.autoPrepare.music`      | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_PREPARE_MUSIC` (`0` or `1`)                             | yes |
| `engines.autoPrepare.sound`      | engines   | on or off                                   | on            | next job                               | override                   | `FORGE_AUTO_PREPARE_SOUND` (`0` or `1`)                             | yes |
| `memory.hostPolicy`              | memory    | `soft`, `strict`                            | `soft`        | next job (running engines: next start) | override                   | `FORGE_HOST_MEMORY_POLICY`                                          | yes |
| `world.fullPrecision`            | memory    | on or off                                   | off           | restart (World engine)                 | override                   | `FORGE_WORLDGEN_FULL_PRECISION`                                     | yes |
| `queue.chainUnload`              | queue     | on or off                                   | on            | next job                               | override                   | `FORGE_CHAIN_UNLOAD` (`0`, `false`, `off`, `no` turn it off)        | yes |
| `vegetation.timeoutMs`           | queue     | whole number, 10000 to 1800000 ms           | 120000        | next job                               | override                   | `FORGE_VEGETATION_TIMEOUT_MS`                                       | yes |
| `asr.latencyMs`                  | speech    | 80, 160, 560, 1120 ms                       | 160           | restart (speech engine)                | store (`asr-latency.json`) | none                                                                | yes |
| `ai.errorFix.provider`           | ai        | `openai`                                    | `openai`      | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ai.errorFix.model`              | ai        | model id, 1 to 80 of `A-Za-z0-9._:/-`       | `gpt-6.1-sol` | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ai.vegetationDescribe.provider` | ai        | `openai`, `local`                           | `openai`      | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ai.vegetationDescribe.model`    | ai        | model id                                    | `gpt-6-luna`  | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ai.uiTranslate.provider`        | ai        | `openai`                                    | `openai`      | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ai.uiTranslate.model`           | ai        | model id                                    | `gpt-6-luna`  | live                                   | store (`ai_assist`)        | none                                                                | yes |
| `ui.language`                    | interface | BCP 47 code (`fr`, `de-CH`), `en`, or empty | none          | live                                   | store (`i18n.sqlite`)      | none                                                                | yes |
| `tray.enabled`                   | app       | on or off                                   | on            | restart (studio service)               | override                   | `FORGE_DISABLE_TRAY=1` locks it off                                 | yes |
| `power.keepAwake`                | app       | on or off                                   | off           | live                                   | store (keep-awake service) | none                                                                | yes |
| `logs.level`                     | app       | `error`, `warn`, `info`, `debug`, `trace`   | `info`        | live (within about 5 s)                | override                   | `FORGE_LOG_LEVEL`                                                   | yes |
| `logs.componentLevels`           | app       | `area=level,...` or empty                   | none          | live (within about 5 s)                | override                   | `FORGE_LOG_LEVEL` when it contains `=`                              | yes |
| `logs.retentionDays`             | app       | whole number, 1 to 365 days                 | 14            | live                                   | override                   | `FORGE_LOG_RETENTION_DAYS`                                          | yes |
| `logs.maxSizeMiB`                | app       | whole number, 16 to 4096 MiB                | 256           | live                                   | override                   | `FORGE_LOG_MAX_MIB`                                                 | yes |

Notes on individual entries:

- **`engines.autoStart.<engine>`.** The queue starts a worker process itself when a queued render needs it. A custom service address (`FORGE_<ENGINE>_URL`) means the service comes from outside Forge, so the setting is locked **off** (the queue waits instead of starting a second copy) unless `FORGE_AUTO_START_<ENGINE>=1` opts back in. That is the rule the queue always used. It starts a process only; it never loads model weights and never downloads anything. Crash recovery that restarts a worker after a studio restart follows the same setting. `engines.autoStart.world` and `.sound` also apply the `FORGE_AUTO_START_WORLD` and `FORGE_AUTO_START_SOUND` opt-ins in the queue's generic path, which previously only crash recovery and the sound loader honoured.
- **`engines.autoPrepare.music` and `.sound`.** When on (the default) a waiting music or sound render asks the engine to load its model after Forge has compared free GPU memory with the model's budget. When off, the render waits for the engine like a worker with no loader, and you load the model on the Models page.
- **`memory.hostPolicy`.** `soft` blocks a render only when free system memory is under a 2 GiB floor; `strict` enforces each engine's full system-memory budget. GPU memory is always checked. The queue follows a change at once. Python engines read the value from their environment, so Forge passes a **saved** value to engines it starts (an engine already running keeps its value until it is started again; an engine you start by hand reads only its own environment). Neither value is proof of free memory.
- **`world.fullPrecision`.** Full precision needs substantially more GPU memory than the quantized FLUX file. It is passed to the World engine when Forge starts it.
- **`queue.chainUnload`.** In a chained render, unload the first model (Qwen Image or SAM 3.1) before the second one loads.
- **`vegetation.timeoutMs`.** The longest one plant may take. The watchdog deadline `FORGE_VEGETATION_DEADLINE_MS` is derived from this value by the runner and is not a setting.
- **`asr.latencyMs`.** Saving never stops or starts the speech engine. The Voices page and `forge_set_asr_latency` keep their behaviour of restarting an idle, Forge-owned engine when you ask; `forge_settings_set` only saves.
- **`ai.*`.** Provider and model ids only. API keys stay in the credential service. Choosing a model sends nothing: requests still start from an explicit button in Studio (Suggest a fix, Describe it, Translate this page) after a preview.
- **`power.keepAwake`.** Owned by the keep-awake service of the studio host; not saved across a studio restart; Windows only.
- **`ui.language`.** The studio-wide default for browsers that have not chosen a language. A browser's own choice (`forge-locale` in its local storage) wins. Choosing a language never translates anything.
- **`tray.enabled`.** Read once when the studio service starts.

## What is not a setting

These are never listed, readable or changeable through the registry, `/api/settings` or MCP, and there is no tool for them:

- API keys, tokens and any credential (the credential service owns them), the OpenAI and GitHub "send" actions.
- Consent and licence confirmations: the Megascans licence tick and the voice-clone consent are per-action attestations by a person.
- Security checks: loopback binding, the Origin and `X-Forge-Request` checks, process ownership and the engine control tokens.
- Network exposure: host and port binding, engine service URLs.
- File system roots and executables: `FORGE_RUNTIME_DIR`, `FORGE_PROJECTS_DIR`, model folders, Python paths, build tool paths.
- Destructive operations: model removal, trash clearing, force stop.
- Browser-local interface state (not stored by the studio, so out of scope for MCP): `forge-nav-compact`, `forge-nav-hidden`, `forge-queue`, `forge-drafts`, `forge-selected-project`, `forge-locale`, `forge-notification-settings`, `forge-chat-context-v1`, `forge-chat-max-output-v1`, `forge-preview-ratings`, `forge-hidden-queue-ids-v1`, `forge-vegetation-reuse`, `forge-world-reuse` and the viewer preferences. Each browser keeps its own.

Every `FORGE_*` variable the runtime reads was classified:

| Kind                                     | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Behaviour toggles (now registry keys)    | `FORGE_AUTO_START_*`, `FORGE_AUTO_PREPARE_MUSIC`, `FORGE_AUTO_PREPARE_SOUND`, `FORGE_HOST_MEMORY_POLICY`, `FORGE_CHAIN_UNLOAD`, `FORGE_DISABLE_TRAY`, `FORGE_VEGETATION_TIMEOUT_MS`, `FORGE_WORLDGEN_FULL_PRECISION`, `FORGE_LOG_*`                                                                                                                                                                                                                                                                                                        |
| Deployment plumbing (environment only)   | `FORGE_RUNTIME_DIR`, `FORGE_PROJECTS_DIR`, `FORGE_STUDIO_URL`, `FORGE_*_URL` (engine service addresses), `FORGE_*_MODEL`, `FORGE_*_SOURCE`, `FORGE_ASR_MODEL`, `FORGE_MODELS_ROOT`, `FORGE_H3_*`, `FORGE_HYWORLD_*`, `FORGE_MAMMOTH_MODELS`, `FORGE_STABLE_AUDIO_HUB`, `FORGE_QWEN_LORA_DIR`, `FORGE_QWEN_IMAGE_STUDIO_DIR`, `FORGE_ENGINE_CONFIG`, `FORGE_ENGINE_BROKER`, `FORGE_SERVICE_SUPERVISOR_PID`, `FORGE_DESKTOP_USER_DATA`, `FORGE_SEEDTHREE_PIN`, `FORGE_SEEDTHREE_DIR`, `FORGE_MODEL_CONVERT_PYTHON`, `FORGE_TRANSCODE_PYTHON` |
| Security tokens (never shown or changed) | `FORGE_ENGINE_CONTROL_TOKEN`, `FORGE_IMAGE_CONTROL_TOKEN`, `FORGE_ENGINE_INSTANCE_NONCE`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Derived, debug and test hooks            | `FORGE_VEGETATION_DEADLINE_MS` (derived from the time limit), `FORGE_ALLOW_CONSOLE_WINDOWS` (debug: show engine console windows), `FORGE_ERROR_TEST_PYTHON`, `FORGE_TRAY_TEST_NO_TOAST`, `FORGE_TEST_SAM`, `FORGE_MAMMOTH_SMOKE_*`, `FORGE_ROOT`/`FORGE_PYTHON`/`FORGE_CMAKE`… in build scripts                                                                                                                                                                                                                                            |

## HTTP routes

All are on the studio host and registered like `/api/errors` and `/api/ai-assist`.

| Route                            | Purpose                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/settings[?group=<id>]` | `{ groups, settings, recentChanges }`. Needs a loopback `Host`. Only the `group` parameter is accepted.                    |
| `POST` or `PATCH /api/settings`  | `{ changes: [{ key, value }] }` (1 to 20, applied all or nothing) or one `{ key, value }`; optional `via` (`ui` or `mcp`). |
| `POST /api/settings/reset`       | `{ key }` or `{ group }`; optional `via`. A group reset skips locked or unavailable keys and lists them in `skipped`.      |

Writes need a loopback `Host`, `Origin: http://<the same Host>` and `X-Forge-Request: settings`, a JSON body of at most 8 KiB with no unknown fields, and at most 30 writes a minute. Failures return `{ error, code, problems? }`: `400 invalid_request | unknown_field | invalid_value | unknown_key | unknown_group | invalid_changes`, `403` for a wrong origin, header or host (or `immutable`), `409 locked_by_environment`, `413 too_large`, `429` for the rate limit, `500` with a generic message (details stay in the console).

A successful write returns `results` (one per change: `key`, `action`, `changed`, `old`, `new`, `effect`, `restartRequired`, `note`) and the refreshed `settings`, `groups` and `recentChanges`. Each setting in the list has `key`, `label`, `group`, `type`, `values` or `min`/`max`/`pattern`, `unit`, `value`, `default`, `isDefault`, `source`, `locked`, `lockedBy`, `mutable`, `available`, `effect`, `note`, `description`, `updatedAt` and `lastChange`.

## MCP tools

- `forge_settings_list` (read-only, optional `group`): the list above, as JSON.
- `forge_settings_set`: `key` and `value`, or `changes` (up to 20, all or nothing). Unknown, read-only, locked or invalid items refuse the whole call and nothing changes.
- `forge_settings_reset`: `key` or `group`.

`forge_set_keep_awake`, `forge_power_status`, `forge_asr_latency` and `forge_set_asr_latency` keep working. Keep awake goes through the same owner as `power.keepAwake`; `forge_set_asr_latency` additionally restarts an idle Forge-owned speech engine, which `forge_settings_set` never does. See [MCP](MCP.md).

## Studio

The Studio settings dialog has a **Studio behaviour** section after AI assist. Each group is a native disclosure; each row has a labelled switch, select or number or text field with inline errors, a badge (_Applies now_, _Next render_ or _Restart needed_), the source and default, and **Reset to default** behind a confirmation (Escape cancels and returns focus). A setting locked by the environment is disabled and shows the variable's name. Labels and descriptions come from the registry in English; the controls and messages go through the interface-language layer (`settings.studioBehaviour.*`).

## Adding a setting

1. Add the entry to `SETTING_DEFINITIONS` (stable dotted key, type, default, plain description with units, group, effect). Describe any resource use or outbound traffic in the description.
2. If an environment variable already controls it, give it an `environment.read(env)` that reproduces the old rule exactly. Never read the variable elsewhere.
3. Switch every consumer to `getSetting(key)` (or an injected accessor) and keep a pure fallback for tests.
4. Add it to this table, then a test in `test/core-settings.test.js` and one for the consumer.
5. Do not add credentials, consent, security, network, path or destructive controls.

## Verification status

Automated: `test/core-settings.test.js`, `test/settings-service.test.js`, `test/settings-consumers.test.js`, `test/mcp-settings.test.js`, `test/studio-behaviour-ui.test.js`, `test/settings-docs.test.js` and a queue test in `test/chain-unload.test.js` (see the [test guide](../test/README.md)). They use temporary runtime folders, fake engines and a loopback studio. Not verified: the section in a real browser at 375 px or with a screen reader, a Python engine actually reading a saved `memory.hostPolicy` after a start by Forge, tray behaviour after a restart, and keep awake on a real Windows power plan. No real GPU inference or model load is involved.
