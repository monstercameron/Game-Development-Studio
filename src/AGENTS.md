# src/ rules

Applies inside `src/` in addition to the [root rules](../AGENTS.md). Style detail: [code style guide](../docs/CODE_STYLE.md#react-patterns). Checklists: [Adding a feature](../docs/ADDING_A_FEATURE.md), [Adding a model](../docs/ADDING_A_MODEL.md).

## What lives here

The React app: `src/main.jsx` (shell, navigation, creation panels), one component per feature, plain helper modules (`*-settings.js`, `*-api.js`), feature CSS, `src/tooltips/` (field help), `src/i18n/` (translation layer) and shared tokens (`theme.css`, `ux-tokens.css`).

## Invariants

- `src/main.jsx` and many components are CRLF. Run `file src/main.jsx` first and use anchored edits that keep each file's endings.
- Panels are route sections listed in `useNav.js` (`panels`). Keep navigable panels and dialogs in the URL (`?dialog=...`), validate route and query parameters, and keep ephemeral input in component state.
- Every effect that subscribes, polls or fetches has a cleanup, and a stale response must not overwrite newer state (an `active` flag or an `AbortController`).
- All user-visible text goes through `t()`, `tp()` or `<T>` from `./i18n/index.js` with a static English default. Never translate ids, enum values, routes or persisted values. Tooltip text lives in `src/tooltips/pages/<section>.js`, keyed by the English label.
- Use tokens: colors from `theme.css`, spacing, radius, type and focus from `ux-tokens.css`. Scope selectors to the component. No new `!important`.
- Accessibility is part of done: visible labels, keyboard operation, visible focus, `role="status"` or `aria-live` for progress, `role="alert"` for errors (`FieldError.jsx`), dialogs through `useDialogFocus.js`, no status by color alone, a `prefers-reduced-motion` block for animation, logical CSS properties.
- The browser validates for convenience only; the server validates again. Share limits through a pure module in `runtime/` instead of copying numbers.
- Do not claim completion before the runtime confirms it. Show estimates with what they measure, and unknown as unknown.
- Never store or display credentials. API keys go through the credential service only.
- Do not add `dangerouslySetInnerHTML`. Wrap `localStorage` access in `try`/`catch`.

## Commands

```powershell
node --test test/<related>.test.js        # UI tests run in jsdom
npm run build                             # required for React or frontend changes
npm run i18n:check                        # any string change; npm run i18n:extract once after a batch
npx eslint src/<file>.jsx
npx prettier --check src/<file>.jsx src/<file>.css
```

A passing build is not a layout or accessibility review. Check the affected flow, its error, empty and keyboard states, and a phone width (600 px) where practical. If the studio is serving `dist/`, check the queue first; an overwrite can interrupt open pages.

## Common mistakes

- Hard-coded English strings or template-literal i18n keys (the extractor needs literals).
- Concatenating a label with other text in one string, which breaks the tooltip lookup.
- A fetch effect with no cleanup, or a missing dependency hidden by a blanket `eslint-disable`.
- Adding a panel in `main.jsx` but not in `useNav.js`, `tooltips/index.js` or `i18n/namespaces.js`.
- Importing a `runtime/` module that uses `node:` built-ins.
- Adding a job type to one queue surface and not the others (`RuntimeQueue.jsx`, `queue-groups.js`, `nav-queue-status.js`, `useRuntimeNotifications.js`, `PreviewArea.jsx`).
