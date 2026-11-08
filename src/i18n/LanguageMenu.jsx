import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Languages } from 'lucide-react';
import { updateSearch } from '../useNav';
import { i18nRequest } from './i18n-api.js';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, describeLocale, i18n } from './i18n-core.js';
import { useLocale, useT } from './i18n-react.js';
import { namespacesForSection } from './namespaces.js';
import TranslatePageDialog from './TranslatePageDialog';
import './language-menu.css';

function optionLabel(code, locale) {
  if (code === PSEUDO_LOCALE) {
    return describeLocale(code).name;
  }
  const { name, nativeName } = describeLocale(code);
  const shown = locale === DEFAULT_LOCALE ? name : describeLocale(code).nativeName;
  return shown === nativeName ? nativeName : `${nativeName} (${shown})`;
}

/**
 * Top-bar language control: choose English, a cached or shipped language, the en-XA
 * pseudo-locale (development and Diagnostics only) or open "Translate this page…".
 */
export default function LanguageMenu({ section, allowPseudo = false }) {
  const { t } = useT();
  const { locale, setLocale, showOriginal, setShowOriginal, fetchImpl } = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const [languages, setLanguages] = useState(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();
  const namespaces = namespacesForSection(section);
  const isDialogOpen = params.get('dialog') === 'translate';
  const canPseudo = allowPseudo || section === 'diagnostics' || locale === PSEUDO_LOCALE;
  const machine = locale === DEFAULT_LOCALE ? null : i18n.machineInfo(namespaces);

  useEffect(() => {
    if (!isOpen || !fetchImpl) {
      return undefined;
    }
    const controller = new AbortController();
    // A local read of cached languages; it never contacts a translation provider.
    i18nRequest('/languages', { signal: controller.signal, fetchImpl })
      .then((data) => setLanguages(data.languages || []))
      .catch((reason) => {
        if (reason.name !== 'AbortError') {
          setLanguages([]);
          setError(reason.message);
        }
      });
    return () => controller.abort();
  }, [isOpen, fetchImpl]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    panelRef.current?.querySelector('input:checked, input, button')?.focus();
    const handlePointerDown = (event) => {
      if (!panelRef.current?.contains(event.target) && !buttonRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isOpen]);

  const codes = [
    DEFAULT_LOCALE,
    ...(languages || []).map((item) => item.code),
    ...(canPseudo ? [PSEUDO_LOCALE] : []),
  ];
  if (!codes.includes(locale)) {
    codes.push(locale);
  }

  async function handleChoose(code) {
    setError('');
    try {
      await setLocale(code);
    } catch (reason) {
      setError(reason.message);
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setIsOpen(false);
      buttonRef.current?.focus();
    }
  }

  function openTranslateDialog() {
    setIsOpen(false);
    updateSearch(setParams, { dialog: 'translate' });
  }

  const shortCode = locale === PSEUDO_LOCALE ? 'XA' : locale.split('-')[0].toUpperCase();
  return (
    <div className="language-menu">
      {machine && (
        <span className="language-machine-flag">
          <span
            className="language-machine-label"
            title={t(
              'i18n.menu.machineNotice',
              'Machine translated by {model}. Review before relying on it.',
              { model: machine.model },
            )}
          >
            {t('i18n.menu.machineShort', 'Machine translated')}
          </span>
          <button
            type="button"
            className="language-original-toggle"
            aria-pressed={showOriginal}
            onClick={() => setShowOriginal(!showOriginal)}
          >
            {showOriginal
              ? t('i18n.menu.showTranslation', 'Show translation')
              : t('i18n.menu.showOriginal', 'Show original English')}
          </button>
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="language-menu-button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={t('i18n.menu.button', 'Language: {language}', {
          language: optionLabel(locale, DEFAULT_LOCALE),
        })}
        title={t('i18n.menu.buttonTitle', 'Language')}
        onClick={() => setIsOpen((value) => !value)}
      >
        <Languages size={16} aria-hidden="true" />
        <span className="language-menu-code">{shortCode}</span>
      </button>
      {isOpen && (
        <div
          ref={panelRef}
          id={panelId}
          className="language-menu-panel"
          role="group"
          aria-label={t('i18n.menu.title', 'Language')}
          onKeyDown={handleKeyDown}
        >
          <fieldset className="language-menu-options">
            <legend>{t('i18n.menu.title', 'Language')}</legend>
            {codes.map((code) => (
              <label key={code} className="language-menu-option" lang={code}>
                <input
                  type="radio"
                  name={`${panelId}-language`}
                  checked={code === locale}
                  onChange={() => handleChoose(code)}
                />
                <span>{optionLabel(code, locale)}</span>
              </label>
            ))}
            {languages === null && fetchImpl && (
              <p className="language-menu-hint">
                {t('i18n.menu.loading', 'Checking saved translations…')}
              </p>
            )}
          </fieldset>
          {machine && (
            <p className="language-menu-hint">
              {t(
                'i18n.menu.machineNotice',
                'Machine translated by {model}. Review before relying on it.',
                { model: machine.model },
              )}
            </p>
          )}
          {error && (
            <p className="language-menu-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="outline-button" onClick={openTranslateDialog}>
            {t('i18n.menu.translate', 'Translate this page with ChatGPT…')}
          </button>
          <p className="language-menu-hint">
            {t(
              'i18n.menu.translateHint',
              'You review what is sent before anything leaves this computer.',
            )}
          </p>
        </div>
      )}
      {isDialogOpen && (
        <TranslatePageDialog
          namespaces={namespaces}
          onClose={() => updateSearch(setParams, { dialog: null })}
          onOpenSettings={() => updateSearch(setParams, { dialog: 'settings' })}
        />
      )}
    </div>
  );
}
