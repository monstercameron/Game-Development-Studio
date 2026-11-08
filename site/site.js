// Progressive enhancements only: the page is fully usable without JavaScript.
(() => {
  // Shared, visually hidden status region for announcements.
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.body.append(status);
  const announce = (message) => {
    status.textContent = '';
    window.setTimeout(() => {
      status.textContent = message;
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
          ? `Showing all ${total} cards: 15 catalog models and one group of supporting checkpoints.`
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
})();
