import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('project site filters models and preserves working section links', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../site/site.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });

  try {
    const { document } = dom.window;
    dom.window.eval(script);
    const buttons = [...document.querySelectorAll('[data-filter]')];
    const models = [...document.querySelectorAll('[data-category]')];
    assert.ok(models.length > 0);

    for (const button of buttons) {
      button.click();
      assert.equal(button.getAttribute('aria-pressed'), 'true');
      const selected = button.dataset.filter;
      const visible = models.filter((model) => !model.hidden);
      assert.ok(visible.length > 0, `${selected} should show at least one model`);
      assert.ok(
        visible.every((model) => selected === 'all' || model.dataset.category === selected),
      );
      assert.ok(
        buttons
          .filter((other) => other !== button)
          .every((other) => other.getAttribute('aria-pressed') === 'false'),
      );
    }

    for (const link of document.querySelectorAll('a[href^="#"]')) {
      assert.ok(document.getElementById(link.hash.slice(1)), `missing target ${link.hash}`);
    }
  } finally {
    dom.window.close();
  }
});
