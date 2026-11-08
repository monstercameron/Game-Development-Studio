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
    const radios = [...document.querySelectorAll('.model-browser input[name="ws"]')];
    const cards = [...document.querySelectorAll('.model-browser .model')];
    assert.ok(cards.length > 0, 'the site lists model cards');
    assert.ok(radios.length > 1, 'the site offers workspace filters');

    for (const radio of radios) {
      radio.checked = true;
      radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      const visible = cards.filter((card) => !card.hidden);
      assert.ok(visible.length > 0, `${radio.value} should show at least one model`);
      assert.ok(
        visible.every(
          (card) => radio.value === 'all' || card.dataset.ws.split(' ').includes(radio.value),
        ),
        `${radio.value} shows only matching cards`,
      );
      if (radio.value === 'all') {
        assert.equal(visible.length, cards.length);
      }
    }

    for (const link of document.querySelectorAll('a[href^="#"]')) {
      if (link.hash.length > 1) {
        assert.ok(document.getElementById(link.hash.slice(1)), `missing target ${link.hash}`);
      }
    }
    for (const img of document.querySelectorAll('img')) {
      assert.ok(img.getAttribute('alt') !== null, 'images declare alt text');
    }
  } finally {
    dom.window.close();
  }
});
