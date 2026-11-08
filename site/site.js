// Progressive enhancements only: the page is fully usable without JavaScript.
(() => {
  // Shared, visually hidden live region for announcements. The text is cleared first and set
  // again after a short delay so that a repeated message is read out again.
  const announcementRegion = document.createElement('p');
  announcementRegion.className = 'sr-only';
  announcementRegion.setAttribute('role', 'status');
  announcementRegion.setAttribute('aria-live', 'polite');
  document.body.append(announcementRegion);
  const announce = (message) => {
    announcementRegion.textContent = '';
    window.setTimeout(() => {
      announcementRegion.textContent = message;
    }, 50);
  };

  // Copy buttons for code blocks.
  for (const block of document.querySelectorAll('.code')) {
    const pre = block.querySelector('pre');
    if (!pre) {
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = 'Copy';
    const label = block.querySelector('.code-head span')?.textContent.trim();
    button.setAttribute('aria-label', label ? `Copy code: ${label}` : 'Copy code');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent.replace(/\n$/, ''));
        button.textContent = 'Copied';
        announce('Copied to clipboard.');
      } catch {
        button.textContent = 'Select to copy';
        announce('Copy is unavailable here. Select the text to copy it.');
      }
      window.setTimeout(() => {
        button.textContent = 'Copy';
      }, 1800);
    });
    const head = block.querySelector('.code-head');
    (head || block).append(button);
  }

  // Model filter: CSS :has() already filters; this mirrors it with `hidden`
  // (for older browsers) and announces the result count.
  const browser = document.querySelector('.model-browser');
  if (browser) {
    const radios = browser.querySelectorAll('input[name="ws"]');
    const cards = browser.querySelectorAll('.model');
    const count = document.getElementById('model-count');
    const total = cards.length;
    const apply = (value, label) => {
      let shown = 0;
      for (const card of cards) {
        const match = value === 'all' || card.dataset.ws.split(' ').includes(value);
        card.hidden = !match;
        if (match) {
          shown += 1;
        }
      }
      count.textContent =
        value === 'all'
          ? `Showing all ${total} cards: 16 models and one group of supporting checkpoints.`
          : `Showing ${shown} of ${total} cards for ${label}.`;
    };
    for (const radio of radios) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          apply(radio.value, radio.labels[0].textContent);
        }
      });
    }
    // If a link targets a model hidden by the current filter, show everything.
    const reveal = () => {
      const target = location.hash && document.getElementById(location.hash.slice(1));
      if (target && target.classList.contains('model') && target.hidden) {
        const all = browser.querySelector('#f-all');
        all.checked = true;
        apply('all', 'All');
        target.scrollIntoView();
      }
    };
    window.addEventListener('hashchange', reveal);
  }

  // Highlight the nav link for the section in view.
  const links = new Map();
  for (const link of document.querySelectorAll('.site-nav a[href^="#"]')) {
    const section = document.getElementById(link.getAttribute('href').slice(1));
    if (section) {
      links.set(section, link);
    }
  }
  if ('IntersectionObserver' in window && links.size) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }
          for (const link of links.values()) {
            link.removeAttribute('aria-current');
          }
          links.get(entry.target).setAttribute('aria-current', 'true');
        }
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const section of links.keys()) {
      observer.observe(section);
    }
  }

  // Screenshot viewer. Every "zoom" link points at its image file, so without JavaScript (or
  // without <dialog> support) it simply opens the image. Here it opens a modal gallery instead.
  const setupLightbox = () => {
    const dialog = document.getElementById('lightbox');
    if (!dialog || typeof dialog.showModal !== 'function') {
      return;
    }
    const find = (name) => document.getElementById(`lightbox-${name}`);
    const title = find('title');
    const count = find('count');
    const closeButton = find('close');
    const stage = find('stage');
    const img = find('img');
    const loadingNote = find('loading');
    const errorNote = find('error');
    const errorLink = find('error-link');
    const prevButton = find('prev');
    const nextButton = find('next');
    const fullButton = find('full');
    const openLink = find('open');
    const live = find('live');
    const parts = [title, count, closeButton, stage, img, loadingNote, errorNote, errorLink];
    parts.push(prevButton, nextButton, fullButton, openLink, live);
    if (parts.some((part) => !part)) {
      return;
    }

    const items = [];
    for (const link of document.querySelectorAll('a.zoom[href]')) {
      const image = link.querySelector('img');
      if (!image) {
        continue;
      }
      const label = (link.getAttribute('aria-label') || '').replace(/^View larger:\s*/, '');
      const caption = link.closest('figure')?.querySelector('figcaption');
      items.push({
        link,
        src: link.getAttribute('href'),
        alt: image.getAttribute('alt') || '',
        label,
        caption: (caption ? caption.textContent : label).replace(/\s+/g, ' ').trim(),
      });
    }
    if (!items.length) {
      return;
    }
    const hasSeveral = items.length > 1;
    prevButton.hidden = !hasSeveral;
    nextButton.hidden = !hasSeveral;

    let index = 0;
    let isFull = false;
    let pressTarget = null;
    // Keep references so lazy neighbour requests are not cancelled by garbage collection.
    const preloaded = new Map();

    const say = (message) => {
      live.textContent = '';
      window.setTimeout(() => {
        live.textContent = message;
      }, 50);
    };

    const preload = (target) => {
      const item = items[(target + items.length) % items.length];
      if (!preloaded.has(item.src)) {
        const image = new Image();
        image.src = item.src;
        preloaded.set(item.src, image);
      }
    };

    const settle = (didLoad) => {
      stage.classList.remove('is-loading');
      stage.classList.toggle('is-error', !didLoad);
      loadingNote.hidden = true;
      errorNote.hidden = didLoad;
      if (hasSeveral) {
        preload(index + 1);
        preload(index - 1);
      }
    };
    img.addEventListener('load', () => settle(true));
    img.addEventListener('error', () => settle(false));

    const show = (target) => {
      index = (target + items.length) % items.length;
      const item = items[index];
      title.textContent = item.caption;
      count.textContent = `${index + 1} of ${items.length}`;
      openLink.href = item.src;
      errorLink.href = item.src;
      stage.classList.add('is-loading');
      stage.classList.remove('is-error');
      loadingNote.hidden = false;
      errorNote.hidden = true;
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
      img.alt = item.alt;
      const isSameSource = img.getAttribute('src') === item.src;
      if (!isSameSource) {
        img.setAttribute('src', item.src);
      }
      // A cached image may already be complete and then fires no new load event.
      if (img.complete && (isSameSource || img.naturalWidth > 0)) {
        settle(img.naturalWidth > 0);
      }
    };

    const go = (target) => {
      show(target);
      const item = items[index];
      say(`Screenshot ${index + 1} of ${items.length}: ${item.label}`);
    };

    const setFull = (on) => {
      isFull = on;
      stage.classList.toggle('is-full', on);
      fullButton.setAttribute('aria-pressed', String(on));
      if (on) {
        // Scrollable regions need to be keyboard focusable.
        stage.setAttribute('tabindex', '0');
        stage.setAttribute(
          'aria-label',
          'Enlarged screenshot at full size. Scroll with the arrow keys.',
        );
      } else {
        stage.removeAttribute('tabindex');
        stage.setAttribute('aria-label', 'Enlarged screenshot');
      }
      stage.scrollLeft = 0;
      stage.scrollTop = 0;
    };

    // Hide the page scrollbar without shifting the layout.
    const lockScroll = () => {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.setProperty('--lightbox-scrollbar', `${Math.max(scrollbarWidth, 0)}px`);
      document.body.classList.add('lightbox-open');
    };
    const unlockScroll = () => {
      document.body.classList.remove('lightbox-open');
      document.body.style.removeProperty('--lightbox-scrollbar');
    };

    const openAt = (target) => {
      if (dialog.open) {
        return;
      }
      lockScroll();
      show(target);
      dialog.showModal();
      closeButton.focus();
    };

    // Runs for every way of closing (button, Escape, backdrop). Focus goes back to the link
    // of the screenshot last viewed, which is the trigger unless the visitor navigated.
    dialog.addEventListener('close', () => {
      unlockScroll();
      items[index].link.focus();
    });
    closeButton.addEventListener('click', () => dialog.close());
    prevButton.addEventListener('click', () => go(index - 1));
    nextButton.addEventListener('click', () => go(index + 1));
    fullButton.addEventListener('click', () => setFull(!isFull));
    img.addEventListener('dblclick', () => setFull(!isFull));

    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dialog.close();
        return;
      }
      const hasModifierKey = event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
      if (hasModifierKey || !hasSeveral) {
        return;
      }
      // While the full-size region has focus, the arrow keys and Home/End scroll it.
      if (isFull && event.target === stage) {
        return;
      }
      const targets = {
        ArrowLeft: index - 1,
        ArrowRight: index + 1,
        Home: 0,
        End: items.length - 1,
      };
      if (Object.hasOwn(targets, event.key)) {
        event.preventDefault();
        go(targets[event.key]);
      }
    });

    // Close when the press and the click both land on the backdrop (not after a drag from
    // inside the viewer), or on empty stage space around a fitted image.
    dialog.addEventListener('pointerdown', (event) => {
      pressTarget = event.target;
    });
    dialog.addEventListener('click', (event) => {
      const pressed = pressTarget;
      pressTarget = null;
      if (pressed && pressed !== event.target) {
        return;
      }
      if (event.target === dialog || (event.target === stage && !isFull)) {
        dialog.close();
      }
    });

    items.forEach((item, position) => {
      item.link.setAttribute('aria-haspopup', 'dialog');
      item.link.addEventListener('click', (event) => {
        const isPlainClick =
          event.button === 0 && !(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey);
        if (event.defaultPrevented || !isPlainClick) {
          return;
        }
        event.preventDefault();
        openAt(position);
      });
    });
  };
  setupLightbox();
})();
