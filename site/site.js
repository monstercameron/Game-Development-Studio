const filters = document.querySelectorAll('[data-filter]');
const models = document.querySelectorAll('[data-category]');

for (const button of filters) {
  button.addEventListener('click', () => {
    const selected = button.dataset.filter;
    for (const option of filters) {
      const active = option === button;
      option.classList.toggle('active', active);
      option.setAttribute('aria-pressed', String(active));
    }
    for (const model of models) {
      model.hidden = selected !== 'all' && model.dataset.category !== selected;
    }
  });
}

const copyButton = document.querySelector('[data-copy]');
const copyStatus = document.querySelector('.copy-status');
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(copyButton.dataset.copy);
    copyStatus.textContent = 'Command copied.';
  } catch {
    copyStatus.textContent = 'Copy unavailable. Select the command to copy it.';
  }
});
