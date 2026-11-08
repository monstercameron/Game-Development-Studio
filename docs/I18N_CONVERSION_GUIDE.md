# i18n conversion guide (one file at a time)

You convert **one assigned file** so its user-visible English goes through the i18n layer. The page must look and behave **exactly** as before in English. Background: [I18N.md](I18N.md). Finished examples: `src/ForceStopDialog.jsx`, `src/ErrorsButton.jsx`.

## Hard rules

1. Change only your assigned file, plus the minimum test-loader fix in its tests (section 6). Do not touch other source files, `src/i18n/`, catalogs or `src/main.jsx` unless it is your assignment.
2. Never change behaviour: same values, conditions, props, class names, element structure, whitespace in the rendered text, order of operations. Only replace English text with a call that returns the same English.
3. Never reformat the file. Do not run `prettier --write`, `eslint --fix` or any script that rewrites the whole file. Make small, exact edits with the Edit tool. Keep the file's line endings: if the file uses CRLF (Windows line endings), your edits must too; never convert a file between CRLF and LF.
4. Re-read the part of the file you are about to edit right before each edit; other agents may be working in the repository.
5. Keys are string literals. Never build a key with `${}`, `+` or a variable.
6. Never translate values that are stored, sent, compared or used as ids (see section 4).
7. Do not run `npm run i18n:extract` (it rewrites shared catalogs). Use `npm run i18n:check -- <your file>`.
8. When unsure whether something is visible text, leave it unchanged and list it in your report. Do not guess.

## 1. Import

Use the explicit file name; `src/` files use `./i18n/index.js`, files in a subfolder use `../i18n/index.js`.

```js
import { T, useT } from './i18n/index.js'; // components
import { t, tp } from './i18n/index.js'; // helper modules (.js) and module-scope getters
```

Put the import with the other local imports. In each component that shows text, add `const { t } = useT();` (or `{ t, tp }`) as the **first line of the component body**, before other hooks' results are used. Every component that renders translated text, including text from helper modules, must call `useT()` so it re-renders when the language changes. Do not call `useT()` inside conditions, loops or callbacks.

## 2. Keys

`<namespace>.<component>.<name>`: namespace from your assignment or the table in section 8; component = the component or area in camelCase (`forceStop`, `queueItem`); name = what the text is (`title`, `saveButton`, `emptyState`, `errorTooLarge`). Examples: `models.forceStop.confirmTitle`, `queue.item.retryButton`.

- Use `common.action.cancel`, `common.action.close`, `common.action.done`, `common.action.save`, `common.action.delete`, `common.action.retry`, `common.action.back` for those exact one-word buttons.
- The same key must always have the same English text. If two places say the same thing in the same component, reuse the key; otherwise make a new key.
- The English default is the exact text the user saw before: same punctuation, `…` vs `...`, curly quotes, capitalization. JSX text that spanned several lines becomes one line with single spaces.

## 3. Examples (before → after)

**1. JSX text**

```jsx
<h2>Service stopped</h2>
<h2>{t('models.forceStop.stoppedTitle', 'Service stopped')}</h2>
```

**2. Attributes** (`aria-label`, `title`, `placeholder`, `alt`, `label`)

```jsx
<button aria-label="Close force stop dialog" title="Close">
<button aria-label={t('models.forceStop.close', 'Close force stop dialog')} title={t('common.action.close', 'Close')}>
```

**3. Template literal with a variable** → placeholder

```jsx
<h2>{`Force stop ${name}?`}</h2>
<h2>{t('models.forceStop.confirmTitle', 'Force stop {name}?', { name })}</h2>
```

Placeholder names are identifiers (`{name}`, `{count}`, `{model}`); use member values like `{ model: job.model }`. Do not format numbers that the old code did not format.

**4. Conditional strings** → wrap each branch, keep the condition

```text
before: {busy ? 'Saving…' : 'Save'}
after:  {busy ? t('settings.power.saving', 'Saving…') : t('common.action.save', 'Save')}
```

**5. Plurals** → `tp`, only when the old code chose between singular and plural

```text
before: {count === 1 ? '1 file' : `${count} files`}
after:  {tp('assets.list.files', count, { one: '{count} file', other: '{count} files' })}
```

If the old code always printed `${count} files`, keep that exact text with `t('…', '{count} files', { count })`; do not "fix" grammar. For a special zero text keep the condition: `count === 0 ? t('…', 'No files') : tp(…)`.

**6. Sentences with bold or links** → `<T>`, never concatenated fragments

```jsx
<p>Try <strong>Stop service</strong> first. Use force stop only if needed.</p>
<p><T id="models.forceStop.summary" en="Try <b>Stop service</b> first. Use force stop only if needed." components={{ b: <strong /> }} /></p>
```

Tag names in `en` are your choice (`b`, `link`, `code`); each maps to an element in `components`. Props such as `href`, `className` and `onClick` stay on that element: `components={{ link: <a href={url} className="hero-link" /> }}`. Variables go in `params={{ name }}` and appear as `{name}` in `en`.

**7. setNotice / setError / messages built in handlers**

```jsx
setNotice('Saved to the project.');
setNotice(t('assets.save.done', 'Saved to the project.'));

setError(`Could not open ${file.name}.`);
setError(t('assets.open.failed', 'Could not open {fileName}.', { fileName: file.name }));
```

Calling `t` inside an event handler is fine. Do not translate text inside `useEffect`/`useMemo` and keep it in state if the effect would not rerun on a language change; prefer storing data (a code, a count) in state and translating at render time.

**8. Server or exception messages** → leave them unchanged

```jsx
setError(reason.message); // backend English, passes through unchanged
setError(reason.message || 'Could not reach the studio.'); // translate only the fallback:
setError(reason.message || t('common.request.unreachable', 'Could not reach the studio.'));
```

**9. Helper module (`.js`) messages** → call `t` inside the function

```js
// before
export function sizeError(size) {
  return size > LIMIT ? 'Use an image under 10 MiB.' : '';
}
// after
import { t } from './i18n/index.js';
export function sizeError(size) {
  return size > LIMIT ? t('images.validation.tooLarge', 'Use an image under 10 MiB.') : '';
}
```

**10. Module-scope constants, arrays and objects** → getters (lazy). Never call `t()` directly at module scope: it would run once, before the language is known.

```js
// before
const OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'high', label: 'High quality' },
];
const PROVIDER_LABELS = { openai: 'OpenAI (cloud)', local: 'Local (Qwen engine)' };
// after
const OPTIONS = [
  {
    value: 'draft',
    get label() {
      return t('images.quality.draft', 'Draft');
    },
  },
  {
    value: 'high',
    get label() {
      return t('images.quality.high', 'High quality');
    },
  },
];
const PROVIDER_LABELS = {
  get openai() {
    return t('settings.aiAssist.providerOpenai', 'OpenAI (cloud)');
  },
  get local() {
    return t('settings.aiAssist.providerLocal', 'Local (Qwen engine)');
  },
};
```

`t` here is the import from `./i18n/index.js`. Shapes stay the same, so `OPTIONS[0].label`, `Object.entries(...)`, spread and tests keep working. If a module-scope string constant is used as the default text, the extractor accepts a same-file `const NAME = 'text'` as the second argument: `t('errors.fix.notice', FIX_NOTICE)`. If an **exported** string constant is imported by other files or tests, leave it as is and translate where it is displayed with that pattern.

**11. A value that is also the label** → translate only the label

```text
before: {['Draft', 'Balanced'].map((quality) => <option key={quality} value={quality}>{quality}</option>)}
after:  {['Draft', 'Balanced'].map((quality) => <option key={quality} value={quality}>{QUALITY_LABELS[quality] ?? quality}</option>)}
```

The `value` stays English (it is sent or saved). Add a module-scope label map with getters:

```js
const QUALITY_LABELS = {
  get Draft() {
    return t('images.quality.draft', 'Draft');
  },
  get Balanced() {
    return t('images.quality.balanced', 'Balanced');
  },
};
```

**12. Labels that have field help** (a matching entry in `src/tooltips/pages/*.js`)

```jsx
<label>Seed <span className="tag">OPTIONAL</span><input /></label>
<label>{t('images.form.seed', 'Seed')} <span className="tag">{t('common.tag.optional', 'OPTIONAL')}</span><input /></label>
```

Keep the label text as its own `t()` call with the exact English used as the tooltip key, so help keeps working in every language. Do not edit `src/tooltips/pages/*.js`.

**13. Numbers, dates and durations** — only replace an existing `toLocaleString()`/`Intl` call, with the same options:

```text
{bytes.toLocaleString()}              →  {formatNumber(bytes)}      (const { formatNumber } = useT();)
{value.toLocaleString(undefined, o)}  →  {formatNumber(value, o)}   (same options object)
{new Date(at).toLocaleDateString()}   →  {formatDate(at, { year: 'numeric', month: 'numeric', day: 'numeric' })}
```

`formatDate(at)` without options is not the same as `toLocaleString()`; pass the options that reproduce the old output or leave the call alone.

If unsure whether the output is identical, leave the existing formatting alone.

## 4. Never translate

Class names, ids, `key`, `htmlFor`, `name`, `type`, `role`, `data-*`, CSS values, URLs and routes, query parameters, file names and extensions, MIME types, option `value`s, enum and status values (`'queued'`, `'failed'`), model ids, JSON/HTTP/MCP field names, localStorage keys and values, anything sent to the server or written to a file, `console.*` text, messages passed to `reportNoticeError`/error reporting, product and model names on their own (Forge, GPU, TRELLIS.2, Hunyuan3D, Megascans), unit symbols (`MiB`, `px`, `ms`), user content (prompts, project and asset names), and text returned by the server.

If text is compared somewhere (`if (status === 'Ready')`), it is a value: leave it and report it.

## 5. Check your file

```powershell
npm run i18n:scan -- src/YourFile.jsx     # lists remaining strings; exit code 1 means some remain
npm run i18n:check -- src/YourFile.jsx    # validates keys and defaults; prints every key found
npx eslint src/YourFile.jsx
git diff --check -- src/YourFile.jsx
```

The goal is 0 findings from the scanner. If a finding is not user-visible text (an id the scanner mistook for text), add a comment with `i18n-ignore` and the reason on the line above, for example `{/* i18n-ignore: model id */}` in JSX or `// i18n-ignore: log text` in JavaScript. Use it only for genuine non-UI strings.

Read `git diff -- src/YourFile.jsx`: every changed line must only wrap text; no other line may change. In LF files you may run `npx prettier --check src/YourFile.jsx`; if it reports your lines, fix only those lines by hand.

## 6. Tests

Find tests that use your file: search `test/` for the file name. Run them with `node --test test/<name>.test.js`. They must pass unchanged in most cases because English is the default. Fix the test only when its loader breaks on the new import:

- **Tests using `loadJsx(...)` or `vite.ssrLoadModule(...)`:** nothing to do.
- **Tests that remove all imports** (`source.replace(/^import .*;\r?\n/gm, '')`) and add a prelude: add one line to the prelude:
  ```js
  import { T, t, tp, useT } from '${pathToFileURL(path.join(repositoryRoot, 'src', 'i18n', 'index.js')).href}';
  ```
- **Tests that rewrite specific imports** (`.replace("from './useNav'", ...)`) and write the source to a temporary folder: add
  ```js
  .replace("from './i18n/index.js'", `from '${pathToFileURL(path.join(repositoryRoot, 'src', 'i18n', 'index.js')).href}'`)
  ```
- **Tests that read the source text with a regex** for English: the English is still in the file as the second argument; update the regex to match the new source line, keeping the same English.

Never delete or weaken an assertion. If a test fails for another reason, stop and report it.

## 7. When unsure

- Not sure a string is visible? Leave it, list it in your report with its line.
- Not sure the English output stays identical (spacing, punctuation, a number format)? Leave it and report it.
- The file needs a change outside the file to convert something (exported constant used elsewhere, a test that compares a translated value)? Leave it and report it.
- A string is built from fragments across components? Leave it and report it.

Your report: file, keys added (count), strings left on purpose with reasons, tests run with results, scanner and checker results.

## 8. File → namespace

| Files                                                                                                                                                                                                                                        | Namespace                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `main.jsx`: navigation, top bar, breadcrumbs, draft queue panel                                                                                                                                                                              | `shell`                                                                                            |
| `main.jsx`: overview page                                                                                                                                                                                                                    | `overview`                                                                                         |
| `main.jsx`: each creation form                                                                                                                                                                                                               | that page id (`images`, `video`, `music`, `sfx`, `voices`, `segmentation`, `3d`, `motion`, `game`) |
| `main.jsx`: `StudioSettings`; `CredentialSettings.jsx`, `AiAssistSettings.jsx`                                                                                                                                                               | `settings`                                                                                         |
| `ErrorsButton.jsx`, `ErrorsDialog.jsx`, `ErrorDetail.jsx`, `ErrorFixPanel.jsx`, `ErrorIssuePanel.jsx`, `ErrorPipelineTest.jsx`, `error-copy.js`                                                                                              | `errors`                                                                                           |
| `Diagnostics.jsx`, `diagnostics-filter.js`                                                                                                                                                                                                   | `diagnostics`                                                                                      |
| `Models.jsx`, `ModelPlaque.jsx`, `ModelRemovalDialog.jsx`, `ForceStopDialog.jsx`                                                                                                                                                             | `models`                                                                                           |
| `RuntimeQueue.jsx`, `QueueTiming.jsx`, `QueueReorderControls.jsx`, `queue-*.js`, `use-queue-reorder.js`, `nav-queue-status.js`, `job-hints.js`                                                                                               | `queue`                                                                                            |
| `Gallery.jsx`, `AssetThumbnail.jsx`, `AssetConverter.jsx`, `GenerationDetails.jsx`, `generation-details.js`, `asset-labels.js`                                                                                                               | `assets`                                                                                           |
| `Projects.jsx`, `ProjectTrash.jsx`                                                                                                                                                                                                           | `projects`                                                                                         |
| `ThreeViewer.jsx`, `ViewerShell.jsx`, `InteractiveAssetViewer.jsx`, `PreviewArea.jsx`, `ModelPreview.jsx`, `MotionPreview.jsx`, `GaussianPreview.jsx`, `PlyAssetPreview.jsx`, `TextAssetPreview.jsx`, `viewer-*.js`, `thumbnail-renderer.js` | `viewer`                                                                                           |
| `Chat.jsx`, `ChatMarkdown.jsx`, `chat-*.js`                                                                                                                                                                                                  | `chat`                                                                                             |
| `Megascans*.jsx`, `megascans-api.js`                                                                                                                                                                                                         | `megascans`                                                                                        |
| `Vegetation.jsx`, `vegetation-settings.js`                                                                                                                                                                                                   | `vegetation`                                                                                       |
| `WorldStudio.jsx`                                                                                                                                                                                                                            | `world`                                                                                            |
| `HunyuanControls.jsx`, `TrellisControls.jsx`, `ThreeDInputs.jsx`, `hunyuan-settings.js`, `trellis-settings.js`, `three-d-*.js`                                                                                                               | `3d`                                                                                               |
| `HyMotionControls.jsx`, `MotionBricksControls.jsx`, `hymotion-settings.js`, `motionbricks-settings.js`                                                                                                                                       | `motion`                                                                                           |
| `VideoSettings.jsx`, `VideoMediaInputs.jsx`, `ImageVideoSettings.jsx`, `imageVideoInputs.js`                                                                                                                                                 | `video`                                                                                            |
| `MusicDerive.jsx`, `music-derive.js`                                                                                                                                                                                                         | `music`                                                                                            |
| `SoundSource.jsx`, `sound-source.js`, `AudioSettings.jsx`                                                                                                                                                                                    | `sfx` unless your assignment says otherwise                                                        |
| `SpeechTranscriber.jsx`, `VoiceModeControls.jsx`, `AsrLatency.jsx`, `voice-modes.js`, `asr-*.js`                                                                                                                                             | `voices`                                                                                           |
| `SegmentationMatchControls.jsx`, `segmentation-settings.js`                                                                                                                                                                                  | `segmentation`                                                                                     |
| `GameDecision.jsx`, `game-decision-input.js`                                                                                                                                                                                                 | `game`                                                                                             |
| `creation-validation.js`                                                                                                                                                                                                                     | the page of each message (`images.validation.*`, `video.validation.*`, …)                          |
| `AssetPicker.jsx`, `asset-picker.js`, `FieldError.jsx`, `PageErrorBoundary.jsx`, `MiniPlayer.jsx`, `mini-player.js`, `MemoryAlerts.jsx`, `MemoryDialog.jsx`, `notifications.js`, `save-project-text.js`, other shared helpers                | `common`                                                                                           |

A file not listed: use the page whose route renders it, or `common` when several pages use it. Your assignment overrides this table.
