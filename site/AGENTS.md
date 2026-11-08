# site/ rules

Applies inside `site/` in addition to the [root rules](../AGENTS.md). The site is public.

## What lives here

The static GitHub Pages project site: `index.html`, `site.js` (model filter, screenshot viewer), `styles.css`, `capacity.js` (model weight capacity tiles and table) and `model-capacity.json` (measured data). `.github/workflows/pages.yml` copies `site/` and a few images from `docs/images/` and `public/favicon.svg` into the published artifact when `site/**` changes on `main`. There is no build step and no bundler.

## Invariants

- Everything here is published to the internet when it reaches `main`. Do not push or deploy yourself. Put no private path, user name, machine name, address, prompt or credential in a page, a script or the JSON (`test/site-capacity.test.js` checks the JSON for these).
- The page uses no other hosts: no CDN scripts, fonts or analytics, and no network request except its own files (`test/site-lightbox.test.js` checks this).
- Core content works without JavaScript. The capacity table in `index.html` between the `capacity:static:start` and `capacity:static:end` markers is generated from `model-capacity.json`; never edit it or the JSON by hand. Run `npm run site:capacity` on the reference machine (see [Refreshing the capacity figures](../docs/STUDIO_GUIDE.md#refreshing-the-capacity-figures)), or `node tools/model-capacity.mjs --render-only` to rebuild only the table.
- Claims must match the docs. State unverified behavior and limits as the guides do. Do not advertise a model, capability or number that [Model sources](../docs/MODEL_SOURCES.md) and the [Studio guide](../docs/STUDIO_GUIDE.md) do not support.
- Every model has a card with a stable `id` (`model-...`). `ROW_DEFINITIONS` in `tools/model-capacity.mjs` links each capacity row to one card, and the card heading must equal the row name.
- Keep ids unique and every `#fragment` resolving. Each screenshot has one enlarge link with an accessible name.
- Accessibility: semantic headings and landmarks, visible focus, keyboard-operable controls, `alt` text, a screenshot viewer that returns focus to its opener, and `prefers-reduced-motion`. Keep it usable at phone width.
- Plain JavaScript, two-space indentation, no framework. ESLint runs here with browser globals.
- Add a screenshot only when it is a real capture of the current studio.

## Commands

```powershell
node --test test/site.test.js test/site-lightbox.test.js test/site-capacity.test.js
npx eslint site/site.js site/capacity.js
npx prettier --check site/index.html site/styles.css site/site.js site/capacity.js
```

These tests use jsdom and no network. They do not check layout, focus trapping in a real browser or visual quality; open the page in a browser at desktop and phone widths before handing off.

## Common mistakes

- Hand-editing the generated capacity table or `model-capacity.json`.
- Adding a model card but no `ROW_DEFINITIONS` row (the tool refuses large unmapped folders), or renaming a card without updating the row.
- Linking to an external stylesheet, script or font.
- Describing a model as working because its files are installed.
- Editing `site/` and `docs/images/` for an unrelated change; any change under `site/**` triggers a deployment on `main`.
