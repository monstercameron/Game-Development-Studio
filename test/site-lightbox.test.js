import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

// Checks the GitHub Pages screenshot viewer (site/index.html and site/site.js) in jsdom with no
// network. jsdom lacks HTMLDialogElement.showModal/close, so a minimal stand-in is installed;
// focus trapping, the top layer and the real Escape default action are not exercised here.
const siteFile = (name) => fileURLToPath(new URL(`../site/${name}`, import.meta.url));
const indexHtml = readFileSync(siteFile('index.html'), 'utf8');
const siteScript = readFileSync(siteFile('site.js'), 'utf8');

const installDialogStub = (window) => {
  const prototype = window.HTMLDialogElement.prototype;
  prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  prototype.close = function close() {
    if (this.hasAttribute('open')) {
      this.removeAttribute('open');
      this.dispatchEvent(new window.Event('close'));
    }
  };
};

const loadSite = ({ stubDialog = true, beforeScript } = {}) => {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(indexHtml.replace(/<script[^>]*site\.js[^>]*><\/script>/, ''), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/',
    virtualConsole,
    beforeParse(window) {
      window.addEventListener('error', (event) => errors.push(event.error || event.message));
      if (stubDialog) {
        installDialogStub(window);
      }
    },
  });
  if (beforeScript) {
    beforeScript(dom.window.document);
  }
  dom.window.eval(siteScript);
  const { document } = dom.window;
  const pick = (id) => document.getElementById(id);
  return {
    window: dom.window,
    document,
    errors,
    dialog: pick('lightbox'),
    links: [...document.querySelectorAll('a.zoom')],
    pick,
  };
};

const key = (window, target, name, init = {}) => {
  const event = new window.KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

const settleTimers = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

test('site markup: unique ids, resolving fragments, one named enlarge link per screenshot', () => {
  const { document, links, dialog } = loadSite();

  const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
  assert.deepEqual(
    ids.filter((id, position) => ids.indexOf(id) !== position),
    [],
    'duplicate ids',
  );

  const lightboxLinks = new Set(dialog.querySelectorAll('a'));
  for (const anchor of document.querySelectorAll('a[href^="#"]')) {
    const fragment = anchor.getAttribute('href').slice(1);
    if (lightboxLinks.has(anchor) || fragment === '') {
      continue;
    }
    assert.ok(document.getElementById(fragment), `fragment #${fragment} has no target`);
  }

  const screenshots = [...document.querySelectorAll('figure img')].filter((image) =>
    /^assets\/[\w-]+\.png$/.test(image.getAttribute('src')),
  );
  assert.equal(screenshots.length, 5);
  assert.equal(links.length, screenshots.length);
  for (const image of screenshots) {
    const wrappers = [];
    for (let node = image.parentElement; node; node = node.parentElement) {
      if (node.matches('a.zoom')) {
        wrappers.push(node);
      }
    }
    assert.equal(wrappers.length, 1, `${image.getAttribute('src')} needs exactly one link`);
    assert.equal(wrappers[0].getAttribute('href'), image.getAttribute('src'));
    assert.match(wrappers[0].getAttribute('aria-label'), /^View larger: \S/);
    const described = document.getElementById(wrappers[0].getAttribute('aria-describedby'));
    assert.equal(described, image, 'the link keeps the image alt text as its description');
    assert.ok(image.getAttribute('alt').length > 20, 'alt text is kept');
    assert.ok(image.getAttribute('width') === '1600' && image.getAttribute('height') === '1000');
  }
  const hero = document.querySelector('.hero-shot img');
  assert.equal(hero.getAttribute('fetchpriority'), 'high');
  assert.equal(hero.getAttribute('loading'), null);

  for (const anchor of document.querySelectorAll('a')) {
    const name =
      anchor.getAttribute('aria-label') ||
      anchor.textContent.trim() ||
      anchor.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt');
    assert.ok(name, `link ${anchor.outerHTML.slice(0, 80)} has no accessible name`);
  }

  assert.equal(dialog.tagName, 'DIALOG');
  assert.ok(document.getElementById(dialog.getAttribute('aria-labelledby')));
  assert.equal(dialog.hasAttribute('open'), false);
  for (const control of dialog.querySelectorAll('button')) {
    assert.ok(control.getAttribute('aria-label') || control.textContent.trim());
  }
  assert.equal(document.getElementById('lightbox-full').getAttribute('aria-pressed'), 'false');
  assert.equal(document.getElementById('lightbox-open').getAttribute('rel'), 'noopener');
});

test('site loads nothing from other hosts', () => {
  const { document } = loadSite();
  const external = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;
  for (const element of document.querySelectorAll(
    'script[src], img[src], iframe[src], source[src], link[rel~="stylesheet"], link[rel~="icon"]',
  )) {
    const url = element.getAttribute('src') || element.getAttribute('href');
    assert.doesNotMatch(url, external, `${element.tagName} loads ${url}`);
  }
  assert.doesNotMatch(siteScript, /https?:\/\//);
});

test('clicking a screenshot opens the viewer with its image, caption and counter', () => {
  const { window, dialog, links, pick, errors } = loadSite();
  const stage = pick('lightbox-stage');
  const third = links[2];

  assert.equal(
    third.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })),
    false,
  );

  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(pick('lightbox-img').getAttribute('src'), 'assets/asset-library.png');
  assert.equal(pick('lightbox-img').getAttribute('alt'), links[2].querySelector('img').alt);
  assert.equal(pick('lightbox-count').textContent, '3 of 5');
  assert.equal(
    pick('lightbox-title').textContent,
    'Search, filter and preview assets in the library; the screenshot shows the bundled sample collection.',
  );
  assert.equal(pick('lightbox-open').getAttribute('href'), 'assets/asset-library.png');
  assert.equal(window.document.activeElement, pick('lightbox-close'));
  assert.ok(window.document.body.classList.contains('lightbox-open'));
  assert.equal(third.getAttribute('aria-haspopup'), 'dialog');
  assert.ok(stage.classList.contains('is-loading'), 'loading state until the image arrives');
  assert.equal(pick('lightbox-loading').hidden, false);

  pick('lightbox-img').dispatchEvent(new window.Event('load'));
  assert.equal(stage.classList.contains('is-loading'), false);
  assert.equal(pick('lightbox-loading').hidden, true);
  assert.deepEqual(errors, []);
});

test('modified clicks keep the browser default so the image can open in a new tab', () => {
  const { window, dialog, links } = loadSite();
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  links[0].dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(dialog.hasAttribute('open'), false);
});

test('Escape closes the viewer, restores scrolling and returns focus to the trigger', () => {
  const { window, dialog, links, errors } = loadSite();
  links[1].focus();
  links[1].click();
  assert.equal(dialog.hasAttribute('open'), true);

  const event = key(window, window.document.getElementById('lightbox-close'), 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(window.document.activeElement, links[1]);
  assert.equal(window.document.body.classList.contains('lightbox-open'), false);
  assert.equal(window.document.body.style.getPropertyValue('--lightbox-scrollbar'), '');
  assert.deepEqual(errors, []);
});

test('Close button and backdrop clicks close; clicks inside the viewer do not', () => {
  const { window, dialog, links, pick } = loadSite();
  const click = (target) => target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  links[0].click();
  click(pick('lightbox-img'));
  click(pick('lightbox-title'));
  assert.equal(dialog.hasAttribute('open'), true);
  click(dialog);
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(window.document.activeElement, links[0]);

  links[0].click();
  pick('lightbox-close').click();
  assert.equal(dialog.hasAttribute('open'), false);

  // A press that starts inside the viewer and ends on the backdrop is a drag, not a close.
  links[0].click();
  pick('lightbox-title').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  click(dialog);
  assert.equal(dialog.hasAttribute('open'), true);
});

test('Previous, Next and the arrow keys cycle through all screenshots with wrap-around', async () => {
  const { window, dialog, links, pick, errors } = loadSite();
  const sources = links.map((link) => link.getAttribute('href'));
  const shown = () => pick('lightbox-img').getAttribute('src');

  links[0].click();
  pick('lightbox-prev').click();
  assert.equal(shown(), sources[4]);
  assert.equal(pick('lightbox-count').textContent, '5 of 5');

  pick('lightbox-next').click();
  assert.equal(shown(), sources[0]);
  assert.equal(pick('lightbox-count').textContent, '1 of 5');

  key(window, pick('lightbox-next'), 'ArrowRight');
  assert.equal(pick('lightbox-count').textContent, '2 of 5');
  key(window, pick('lightbox-next'), 'ArrowLeft');
  key(window, pick('lightbox-next'), 'ArrowLeft');
  assert.equal(pick('lightbox-count').textContent, '5 of 5');
  key(window, pick('lightbox-next'), 'Home');
  assert.equal(pick('lightbox-count').textContent, '1 of 5');
  key(window, pick('lightbox-next'), 'End');
  assert.equal(pick('lightbox-count').textContent, '5 of 5');

  const modified = key(window, pick('lightbox-next'), 'ArrowLeft', { altKey: true });
  assert.equal(modified.defaultPrevented, false);
  assert.equal(pick('lightbox-count').textContent, '5 of 5');

  await settleTimers();
  assert.match(pick('lightbox-live').textContent, /^Screenshot 5 of 5: /);
  assert.equal(pick('lightbox-live').getAttribute('aria-live'), 'polite');

  // Focus returns to the link of the screenshot last viewed.
  key(window, pick('lightbox-next'), 'Escape');
  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(window.document.activeElement, links[4]);
  assert.deepEqual(errors, []);
});

test('Full size toggles aria-pressed, a focusable scroll region and arrow-key scrolling', () => {
  const { window, links, pick, errors } = loadSite();
  const stage = pick('lightbox-stage');
  const fullButton = pick('lightbox-full');

  links[0].click();
  assert.equal(fullButton.getAttribute('aria-pressed'), 'false');
  assert.equal(stage.hasAttribute('tabindex'), false);

  fullButton.click();
  assert.equal(fullButton.getAttribute('aria-pressed'), 'true');
  assert.ok(stage.classList.contains('is-full'));
  assert.equal(stage.getAttribute('tabindex'), '0');
  assert.match(stage.getAttribute('aria-label'), /full size/i);

  // With the scroll region focused the arrow keys must scroll it, not change the image.
  const scrolled = key(window, stage, 'ArrowRight');
  assert.equal(scrolled.defaultPrevented, false);
  assert.equal(pick('lightbox-count').textContent, '1 of 5');
  key(window, fullButton, 'ArrowRight');
  assert.equal(pick('lightbox-count').textContent, '2 of 5');

  pick('lightbox-img').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(fullButton.getAttribute('aria-pressed'), 'false');
  assert.equal(stage.hasAttribute('tabindex'), false);
  assert.equal(stage.classList.contains('is-full'), false);
  assert.deepEqual(errors, []);
});

test('a failed image shows an error with a link to open the file directly', () => {
  const { window, links, pick } = loadSite();
  links[3].click();
  pick('lightbox-img').dispatchEvent(new window.Event('error'));

  assert.ok(pick('lightbox-stage').classList.contains('is-error'));
  assert.equal(pick('lightbox-error').hidden, false);
  assert.equal(pick('lightbox-loading').hidden, true);
  assert.equal(pick('lightbox-error-link').getAttribute('href'), 'assets/models.png');
  assert.equal(pick('lightbox-error-link').getAttribute('target'), '_blank');

  pick('lightbox-next').click();
  assert.equal(pick('lightbox-error').hidden, true);
  assert.equal(pick('lightbox-stage').classList.contains('is-error'), false);
});

test('neighbouring screenshots are preloaded only after the viewer opens', () => {
  const requested = [];
  const { window, links, pick } = loadSite();
  const NativeImage = window.Image;
  window.Image = function TrackedImage() {
    const image = new NativeImage();
    Object.defineProperty(image, 'src', {
      set(value) {
        requested.push(value);
      },
    });
    return image;
  };
  assert.deepEqual(requested, []);

  links[0].click();
  assert.deepEqual(requested, []);
  pick('lightbox-img').dispatchEvent(new window.Event('load'));
  assert.deepEqual(requested.sort(), ['assets/image-studio.png', 'assets/render-queue.png']);
});

test('without dialog support or without the viewer markup the links are left alone', () => {
  const unsupported = loadSite({ stubDialog: false });
  assert.deepEqual(unsupported.errors, []);
  assert.equal(unsupported.links[0].hasAttribute('aria-haspopup'), false);
  const event = new unsupported.window.MouseEvent('click', { bubbles: true, cancelable: true });
  unsupported.links[0].dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);

  const partial = loadSite({
    beforeScript: (document) => document.getElementById('lightbox-stage').remove(),
  });
  assert.deepEqual(partial.errors, []);
  assert.equal(partial.links[0].hasAttribute('aria-haspopup'), false);
});
