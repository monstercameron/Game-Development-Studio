import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Source-level checks for pages too large to mount in jsdom. Line endings are normalized
// because some source files are CRLF.
function readSource(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

test('asset, models and diagnostics nav buttons expose the current page', () => {
  const main = readSource('src/main.jsx');
  for (const section of ['assets', 'models', 'diagnostics']) {
    assert.match(
      main,
      new RegExp(`aria-current=\\{section === '${section}' \\? 'page' : undefined\\}`),
      `${section} nav button should set aria-current`,
    );
  }
});

test('asset rating restores focus to the star group after every save', () => {
  const gallery = readSource('src/Gallery.jsx');
  assert.match(gallery, /setRatingFocus\(\{ rating: extra\.rating \}\)/);
  assert.doesNotMatch(gallery, /focusAfterRatingClear/);
});

test('phone GPU memory values use a smaller size than the desktop value style', () => {
  const css = readSource('src/ux-page-models.css');
  assert.match(
    css,
    /@media \(max-width: 600px\) \{\s*\.catalog-memory-values strong \{\s*font-size: var\(--forge-font-size-17\);/,
  );
});

test('asset library shows a loading label, not "Project unavailable", while projects load', () => {
  const gallery = readSource('src/Gallery.jsx');
  assert.match(gallery, /loading \? 'Loading project…' : 'Project unavailable'/);
});
