// Fixture for test/i18n-tools.test.js: a fully converted component. Not part of the app.
import { T, t as translate, useT } from '../../../src/i18n/index.js';

const SAVE_LABEL = 'Save changes';

const QUALITY_LABELS = {
  get draft() {
    return translate('images.quality.draft', 'Draft');
  },
};

export default function Converted({ count, name, busy }) {
  const { t, tp } = useT();
  return (
    <section aria-label={t('images.converted.region', 'Converted example')}>
      <h2>{t('images.converted.title', 'Hello {name}', { name })}</h2>
      <p>{tp('images.converted.files', count, { one: '{count} file', other: '{count} files' })}</p>
      <p>
        <T
          id="images.converted.help"
          en="Open <link>Settings</link> to add a key."
          components={{ link: <a href="?dialog=settings" /> }}
        />
      </p>
      <button type="button">
        {busy ? t('images.converted.saving', 'Saving…') : t('images.converted.save', SAVE_LABEL)}
      </button>
      <span className="status-pill">{QUALITY_LABELS.draft}</span>
      <small>·</small>
    </section>
  );
}
