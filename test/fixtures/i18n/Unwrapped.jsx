// Fixture for test/i18n-tools.test.js: hard-coded English the scanner must find (lines matter).
import { useState } from 'react';

const OPTIONS = [{ value: 'draft', label: 'Draft quality' }];

export default function Unwrapped({ busy, setNotice }) {
  const [mode] = useState('grid-view');
  return (
    <div className="outline-button" data-mode={mode} id="unwrapped-root">
      <h2>Render settings</h2>
      <input placeholder="Describe the scene" aria-label="Scene description" type="text" />
      <img src="/forge.png" alt="Forge logo preview" />
      <button
        type="button"
        title={busy ? 'Saving…' : 'Save'}
        onClick={() => setNotice('Saved to the project.')}
      >
        {busy ? 'Working' : 'Start'}
      </button>
      <span>{OPTIONS[0].label}</span>
      <a href="https://example.com/docs">https://example.com/docs</a>
      <small>·</small>
      <code>image/png</code>
      {/* i18n-ignore: product name shown as a logo word */}
      <strong>Forge Studio Pro</strong>
    </div>
  );
}

export function helperMessage(count) {
  if (count > 1) {
    throw Error('Too many files were selected.');
  }
  console.log('Debug message that should be ignored.');
  return 'Choose one file before rendering.';
}
