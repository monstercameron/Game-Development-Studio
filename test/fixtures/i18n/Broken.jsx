// Fixture for test/i18n-tools.test.js: every call here is an extractor error. Not part of the app.
import { T, useT } from '../../../src/i18n/index.js';

export default function Broken({ id, label }) {
  const { t, tp } = useT();
  return (
    <div>
      {t(`images.dynamic.${id}`, 'Dynamic key')}
      {t('images.converted.title', 'A different default')}
      {t('nowhere.broken.name', 'Unknown namespace')}
      {t('images.notEnoughSegments', 'Too short')}
      {t('images.broken.label', label)}
      {tp('images.broken.plural', 2, { other: '{count} items' })}
      <T id="images.broken.rich" en="Unbalanced <b>tag" />
    </div>
  );
}
