import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import useDialogFocus from '../useDialogFocus';
import { createLog } from '../app-log.js';
import { errorLogFields, i18nRequest, streamTranslation } from './i18n-api.js';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, t } from './i18n-core.js';
import { useLocale, useT } from './i18n-react.js';
import { filterLanguages, languageOptions, parseLanguageCode } from './languages.js';
import './language-menu.css';

const log = createLog('i18n');

// Rejection reason codes from runtime/i18n-translate.js, shown in the UI language.
const REASON_LABELS = {
  get missing() {
    return t('i18n.reason.missing', 'missing from the response');
  },
  get type() {
    return t('i18n.reason.type', 'wrong value type');
  },
  get empty() {
    return t('i18n.reason.empty', 'empty translation');
  },
  get placeholder() {
    return t('i18n.reason.placeholder', 'placeholder mismatch');
  },
  get tags() {
    return t('i18n.reason.tags', 'rich-text tag mismatch');
  },
  get markup() {
    return t('i18n.reason.markup', 'unexpected markup or script');
  },
  get control() {
    return t('i18n.reason.control', 'unexpected control characters or line breaks');
  },
  get length() {
    return t('i18n.reason.length', 'length out of range');
  },
  get product() {
    return t('i18n.reason.product', 'product or model name changed');
  },
  get plural() {
    return t('i18n.reason.plural', 'plural forms do not match the language');
  },
};

function codeError(error, t) {
  if (error === 'invalid') {
    return t(
      'i18n.dialog.codeInvalid',
      'That is not a valid language code. Try fr, de-CH or zh-Hant.',
    );
  }
  if (error === 'english') {
    return t('i18n.dialog.codeEnglish', 'English is the source language and needs no translation.');
  }
  if (error === 'unknown') {
    return t('i18n.dialog.codeUnknown', 'Forge does not recognize this language code.');
  }
  return '';
}

const REVIEW_LIMIT = 150;

function TranslationReview({ lang, namespaces, fetchImpl, onChanged }) {
  const { t, tp, formatNumber } = useT();
  const [namespace, setNamespace] = useState(namespaces[0]);
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('');
  const [drafts, setDrafts] = useState({});
  const [savingKey, setSavingKey] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const fieldId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setError('');
    const query = new URLSearchParams({ lang, ns: namespace });
    i18nRequest(`/strings?${query}`, { signal: controller.signal, fetchImpl })
      .then((data) => setRows(data.strings))
      .catch((reason) => {
        if (reason.name !== 'AbortError') {
          log.warn('i18n.strings.failed', { locale: lang, ...errorLogFields(reason) });
          setRows([]);
          setError(reason.message);
        }
      });
    return () => controller.abort();
  }, [lang, namespace, fetchImpl]);

  async function save(row, value) {
    setSavingKey(row.key);
    setError('');
    setMessage('');
    try {
      await i18nRequest('/override', {
        method: 'POST',
        body: { lang, key: row.key, value },
        fetchImpl,
      });
      setRows((current) =>
        current.map((item) =>
          item.key === row.key
            ? { ...item, value: value ?? null, kind: value === null ? 'missing' : 'override' }
            : item,
        ),
      );
      setDrafts((current) => ({ ...current, [row.key]: undefined }));
      setMessage(
        value === null
          ? t('i18n.review.removed', 'Your edit was removed. Translate again to fill it in.')
          : t('i18n.review.saved', 'Saved. Your edit is kept when the page is translated again.'),
      );
      onChanged();
    } catch (reason) {
      log.warn('i18n.review.failed', { locale: lang, ...errorLogFields(reason) });
      setError(reason.message);
    } finally {
      setSavingKey('');
    }
  }

  const needle = filter.trim().toLowerCase();
  const visible = (rows || []).filter(
    (row) =>
      !needle ||
      JSON.stringify([row.english, row.value]).toLowerCase().includes(needle) ||
      row.key.toLowerCase().includes(needle),
  );
  return (
    <div className="translate-review">
      <div className="translate-review-filters">
        <label htmlFor={`${fieldId}-section`}>{t('i18n.review.section', 'Section')}</label>
        <select
          id={`${fieldId}-section`}
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
        >
          {namespaces.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <label htmlFor={`${fieldId}-filter`}>{t('i18n.review.filter', 'Find a string')}</label>
        <input
          id={`${fieldId}-filter`}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {rows === null && (
        <p className="language-menu-hint">{t('i18n.review.loading', 'Loading strings…')}</p>
      )}
      {rows && !rows.length && !error && (
        <p className="language-menu-hint">
          {t('i18n.review.empty', 'This section has no interface strings yet.')}
        </p>
      )}
      {visible.length > REVIEW_LIMIT && (
        <p className="language-menu-hint">
          {tp(
            'i18n.review.limited',
            visible.length,
            {
              one: 'Showing the first {limit} of {count} string. Use Find to narrow the list.',
              other: 'Showing the first {limit} of {count} strings. Use Find to narrow the list.',
            },
            { limit: formatNumber(REVIEW_LIMIT), count: formatNumber(visible.length) },
          )}
        </p>
      )}
      <ul className="translate-review-list">
        {visible.slice(0, REVIEW_LIMIT).map((row) => {
          const isPlural = typeof row.english !== 'string';
          const draft = drafts[row.key];
          const current = typeof row.value === 'string' ? row.value : '';
          return (
            <li key={row.key}>
              <span className="translate-english" lang="en">
                {isPlural ? Object.values(row.english).join(' / ') : row.english}
              </span>
              {isPlural ? (
                <span className="language-menu-hint">
                  {row.value ? Object.values(row.value).join(' / ') : ''}{' '}
                  {t('i18n.review.pluralReadOnly', 'Plural strings cannot be edited here yet.')}
                </span>
              ) : (
                <form
                  className="translate-review-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save(row, (draft ?? current).trim());
                  }}
                >
                  <input
                    lang={lang}
                    value={draft ?? current}
                    maxLength={2000}
                    aria-label={t('i18n.review.inputLabel', 'Translation of: {english}', {
                      english: row.english,
                    })}
                    onChange={(event) =>
                      setDrafts((all) => ({ ...all, [row.key]: event.target.value }))
                    }
                  />
                  <button
                    type="submit"
                    className="outline-button"
                    disabled={savingKey === row.key || !(draft ?? current).trim()}
                  >
                    {t('i18n.review.save', 'Save')}
                  </button>
                  {row.kind === 'override' && (
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={savingKey === row.key}
                      onClick={() => save(row, null)}
                    >
                      {t('i18n.review.remove', 'Remove my edit')}
                    </button>
                  )}
                  <small>
                    {row.kind === 'override'
                      ? t('i18n.review.kindOverride', 'Your edit')
                      : row.kind === 'machine'
                        ? t('i18n.review.kindMachine', 'Machine translated')
                        : row.kind === 'stale'
                          ? t('i18n.review.kindStale', 'English changed; shown in English')
                          : t('i18n.review.kindMissing', 'Not translated; shown in English')}
                  </small>
                </form>
              )}
            </li>
          );
        })}
      </ul>
      {message && (
        <p className="language-menu-hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="language-menu-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * "Translate this page…": choose a language, review exactly what will be sent, send or cancel,
 * follow progress, read the report, edit single strings, and reset or delete translations.
 */
export default function TranslatePageDialog({ namespaces, onClose, onOpenSettings }) {
  const { t, tp, formatNumber } = useT();
  const { locale, setLocale, reloadCatalogs, fetchImpl } = useLocale();
  const initial = locale !== DEFAULT_LOCALE && locale !== PSEUDO_LOCALE ? locale : '';
  const [query, setQuery] = useState('');
  const [typedCode, setTypedCode] = useState('');
  const [target, setTarget] = useState(initial ? parseLanguageCode(initial) : null);
  const [step, setStep] = useState('choose');
  const [preview, setPreview] = useState(null);
  const [progress, setProgress] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [confirming, setConfirming] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const runRef = useRef(null);
  const titleId = useId();
  const listId = useId();
  const options = useMemo(() => languageOptions(locale), [locale]);
  const filtered = filterLanguages(options, query);
  const typed = parseLanguageCode(typedCode);

  const handleClose = () => {
    // Closing while a translation runs cancels the remaining requests.
    log.debug('i18n.translate.closed', { phase: step, isRunning: Boolean(runRef.current) });
    runRef.current?.abort();
    onClose();
  };
  const dialog = useDialogFocus({ onClose: handleClose, initialFocus: '.translate-search' });

  useEffect(() => () => runRef.current?.abort(), []);

  const showError = (reason) => {
    setError(reason.message);
    setErrorCode(reason.code || '');
  };

  async function loadPreview(code = target?.code) {
    if (!code) {
      return;
    }
    setIsBusy(true);
    setError('');
    setErrorCode('');
    setStatusMessage('');
    try {
      const data = await i18nRequest('/preview', {
        method: 'POST',
        body: { lang: code, namespaces },
        fetchImpl,
      });
      setPreview(data);
      setStep('preview');
      log.debug('i18n.preview.completed', { locale: code, stringCount: data.strings });
    } catch (reason) {
      log.warn('i18n.preview.failed', { locale: code, ...errorLogFields(reason) });
      showError(reason);
    } finally {
      setIsBusy(false);
    }
  }

  async function send() {
    const controller = new AbortController();
    runRef.current = controller;
    setStep('running');
    setError('');
    setErrorCode('');
    setProgress({ done: 0, total: preview.strings });
    const startedAt = performance.now();
    const logFields = {
      locale: preview.lang,
      namespaceCount: namespaces.length,
      stringCount: preview.strings,
    };
    const elapsedMs = () => Math.round(performance.now() - startedAt);
    log.info('i18n.translation.started', logFields);
    try {
      const result = await streamTranslation({
        lang: preview.lang,
        namespaces,
        digest: preview.digest,
        signal: controller.signal,
        fetchImpl,
        onEvent: (event) => {
          if (event.type === 'progress') {
            setProgress({ done: event.done, total: event.total });
          }
        },
      });
      setReport(result);
      setStep('report');
      reloadCatalogs(preview.lang);
      log.info('i18n.translation.completed', {
        ...logFields,
        translatedCount: result.translated,
        keptEnglishCount: result.keptEnglish,
        notTranslatedCount: result.notTranslated,
        durationMs: elapsedMs(),
      });
    } catch (reason) {
      if (reason.name === 'AbortError') {
        log.info('i18n.translation.cancelled', { ...logFields, durationMs: elapsedMs() });
        setReport(null);
        setStep('preview');
        setStatusMessage(
          t(
            'i18n.dialog.cancelled',
            'Translation cancelled. Strings already translated are kept; the rest stay in English.',
          ),
        );
        reloadCatalogs(preview.lang);
      } else {
        log.warn('i18n.translation.failed', {
          ...logFields,
          durationMs: elapsedMs(),
          ...errorLogFields(reason),
        });
        showError(reason);
        setStep('preview');
      }
    } finally {
      runRef.current = null;
    }
  }

  async function applyLanguage(code) {
    try {
      await setLocale(code);
      onClose();
    } catch (reason) {
      log.warn('i18n.locale.failed', { locale: code, ...errorLogFields(reason) });
      showError(reason);
    }
  }

  async function removeTranslations(kind) {
    setIsBusy(true);
    setError('');
    try {
      const data = await i18nRequest('/cache', {
        method: 'DELETE',
        body: {
          lang: preview.lang,
          ...(kind === 'page' ? { namespaces } : {}),
          includeOverrides: kind === 'language',
          confirm: 'delete',
        },
        fetchImpl,
      });
      log.info('i18n.cache.removed', {
        locale: preview.lang,
        scope: kind,
        removedCount: data.removed,
      });
      setConfirming('');
      setStatusMessage(
        tp(
          'i18n.dialog.removed',
          data.removed,
          {
            one: '{count} saved translation removed.',
            other: '{count} saved translations removed.',
          },
          { count: formatNumber(data.removed) },
        ),
      );
      reloadCatalogs(preview.lang);
      if (kind === 'language' && locale === preview.lang) {
        await setLocale(DEFAULT_LOCALE);
      }
      await loadPreview(preview.lang);
    } catch (reason) {
      log.warn('i18n.cache.failed', {
        locale: preview.lang,
        scope: kind,
        ...errorLogFields(reason),
      });
      showError(reason);
    } finally {
      setIsBusy(false);
    }
  }

  const languageLabel = preview ? `${preview.nativeName} (${preview.languageName})` : '';
  const percent =
    progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="modal-backdrop translate-backdrop" onClick={handleClose}>
      <section
        ref={dialog}
        className="settings-modal translate-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-head">
          <div>
            <span className="translate-kicker">
              {t('i18n.dialog.kicker', 'Machine translation')}
            </span>
            <h2 id={titleId}>{t('i18n.dialog.title', 'Translate this page')}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('i18n.dialog.close', 'Close translation dialog')}
            onClick={handleClose}
          >
            <X size={20} />
          </button>
        </div>

        {step === 'choose' && (
          <form
            className="translate-choose"
            onSubmit={(event) => {
              event.preventDefault();
              const code = typed.code || target?.code;
              if (code) {
                loadPreview(code);
              }
            }}
          >
            <label htmlFor={`${listId}-search`}>
              {t('i18n.dialog.searchLabel', 'Search languages')}
            </label>
            <input
              id={`${listId}-search`}
              className="translate-search"
              type="search"
              value={query}
              autoComplete="off"
              aria-controls={listId}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div
              id={listId}
              className="translate-language-list"
              role="radiogroup"
              aria-label={t('i18n.dialog.listLabel', 'Languages')}
            >
              {filtered.map((option) => (
                <label key={option.code} className="translate-language-option">
                  <input
                    type="radio"
                    name={`${listId}-language`}
                    checked={target?.code === option.code && !typedCode}
                    onChange={() => {
                      setTypedCode('');
                      setTarget({ code: option.code, name: option.name });
                    }}
                  />
                  <span lang={option.code}>{option.nativeName}</span>
                  <small>
                    {option.name} · {option.code}
                  </small>
                </label>
              ))}
              {!filtered.length && (
                <p className="language-menu-hint">
                  {t('i18n.dialog.noMatch', 'No listed language matches. Enter a code below.')}
                </p>
              )}
            </div>
            <label htmlFor={`${listId}-code`}>
              {t('i18n.dialog.codeLabel', 'Or enter a language code (BCP 47)')}
            </label>
            <input
              id={`${listId}-code`}
              value={typedCode}
              maxLength={35}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(typedCode && typed.error)}
              aria-describedby={`${listId}-code-help`}
              onChange={(event) => setTypedCode(event.target.value)}
            />
            <p id={`${listId}-code-help`} className="language-menu-hint" aria-live="polite">
              {typedCode && typed.error
                ? codeError(typed.error, t)
                : typed.code
                  ? t('i18n.dialog.codeValid', '{code} is {name}.', typed)
                  : t('i18n.dialog.codeHelp', 'For example es-419, pt-BR or zh-Hant.')}
            </p>
            <div className="project-dialog-actions">
              <button type="button" className="ghost-button" onClick={handleClose}>
                {t('common.action.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={isBusy || !(typed.code || (!typedCode && target?.code))}
              >
                {isBusy && <LoaderCircle size={16} className="motion-spinner" />}
                {t('i18n.dialog.review', 'Review what will be sent')}
              </button>
            </div>
          </form>
        )}

        {(step === 'preview' || step === 'running' || step === 'report') && preview && (
          <div className="translate-preview">
            <h3>{t('i18n.dialog.sentHeading', 'What will be sent')}</h3>
            {preview.strings > 0 ? (
              <p>
                {t(
                  'i18n.dialog.sentSummary',
                  '{strings} interface strings ({characters} characters) in {requests} requests to OpenAI, model {model}, for {language}.',
                  {
                    strings: formatNumber(preview.strings),
                    characters: formatNumber(preview.characters),
                    requests: formatNumber(preview.requests),
                    model: preview.model,
                    language: languageLabel,
                  },
                )}
              </p>
            ) : (
              <p>
                {t(
                  'i18n.dialog.nothingToSend',
                  'Every string on this page is already translated into {language}. Nothing will be sent.',
                  { language: languageLabel },
                )}
              </p>
            )}
            <p className="translate-notice">
              {t(
                'i18n.dialog.privacy',
                'Only Forge’s own interface text from the shipped English catalog is sent. Projects, prompts, file names, assets and anything you typed are never sent.',
              )}
            </p>
            <table className="translate-table">
              <caption>{t('i18n.dialog.tableCaption', 'Strings per section')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('i18n.dialog.colSection', 'Section')}</th>
                  <th scope="col">{t('i18n.dialog.colTranslated', 'Translated')}</th>
                  <th scope="col">{t('i18n.dialog.colChanged', 'English changed')}</th>
                  <th scope="col">{t('i18n.dialog.colNew', 'Not translated')}</th>
                  <th scope="col">{t('i18n.dialog.colEdited', 'Your edits')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.namespaces.map((item) => (
                  <tr key={item.namespace}>
                    <th scope="row">{item.namespace}</th>
                    <td>{formatNumber(item.cached)}</td>
                    <td>{formatNumber(item.stale)}</td>
                    <td>{formatNumber(item.missing)}</td>
                    <td>{formatNumber(item.overrides)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!preview.hasKey && (
              <p className="language-menu-error" role="alert">
                {t('i18n.dialog.noKey', 'Add your OpenAI key in Settings before translating.')}{' '}
                <button type="button" className="link-button" onClick={onOpenSettings}>
                  {t('i18n.dialog.openSettings', 'Open Settings')}
                </button>
              </p>
            )}
            {preview.provider !== 'openai' && (
              <p className="language-menu-error" role="alert">
                {t(
                  'i18n.dialog.localUnsupported',
                  'Interface translation supports OpenAI only. Choose OpenAI for Interface translation in Settings, AI assist.',
                )}
              </p>
            )}
          </div>
        )}

        {step === 'running' && progress && (
          <div className="translate-progress">
            <label htmlFor={`${listId}-progress`}>
              {t('i18n.dialog.progressLabel', 'Translation progress')}
            </label>
            <progress id={`${listId}-progress`} max={progress.total || 1} value={progress.done}>
              {percent}%
            </progress>
            <p role="status" aria-live="polite">
              {t('i18n.dialog.progress', 'Translated {done} of {total} strings…', {
                done: formatNumber(progress.done),
                total: formatNumber(progress.total),
              })}
            </p>
          </div>
        )}

        {step === 'report' && report && (
          <div className="translate-report" role="status" aria-live="polite">
            <p>
              <strong>
                {tp(
                  'i18n.report.translated',
                  report.translated,
                  {
                    one: '{count} string translated',
                    other: '{count} strings translated',
                  },
                  { count: formatNumber(report.translated) },
                )}
              </strong>
              {report.keptEnglish > 0 && (
                <>
                  {', '}
                  {tp(
                    'i18n.report.kept',
                    report.keptEnglish,
                    {
                      one: '{count} kept in English: {reasons}',
                      other: '{count} kept in English: {reasons}',
                    },
                    {
                      count: formatNumber(report.keptEnglish),
                      reasons: Object.entries(report.reasons || {})
                        .map(([code, count]) => `${REASON_LABELS[code] || code} (${count})`)
                        .join(', '),
                    },
                  )}
                </>
              )}
              .
            </p>
            {report.notTranslated > 0 && (
              <p>
                {tp(
                  'i18n.report.notTranslated',
                  report.notTranslated,
                  {
                    one: '{count} string was not translated and stays in English.',
                    other: '{count} strings were not translated and stay in English.',
                  },
                  { count: formatNumber(report.notTranslated) },
                )}
              </p>
            )}
            {report.error && (
              <p className="language-menu-error" role="alert">
                {report.error.message}
              </p>
            )}
            <p className="language-menu-hint">
              {t(
                'i18n.report.review',
                'Machine translated by {model}. Review before relying on it.',
                { model: report.model },
              )}
            </p>
          </div>
        )}

        {step === 'review' && preview && (
          <TranslationReview
            lang={preview.lang}
            namespaces={preview.namespaces.map((item) => item.namespace)}
            fetchImpl={fetchImpl}
            onChanged={() => reloadCatalogs(preview.lang)}
          />
        )}

        {error && (
          <div className="language-menu-error" role="alert">
            <p>{error}</p>
            {errorCode === 'no_key' && (
              <button type="button" className="link-button" onClick={onOpenSettings}>
                {t('i18n.dialog.openSettings', 'Open Settings')}
              </button>
            )}
          </div>
        )}
        {statusMessage && (
          <p className="language-menu-hint" role="status">
            {statusMessage}
          </p>
        )}

        {confirming && preview && (
          <div className="translate-confirm" role="alert">
            <p>
              {confirming === 'language'
                ? t(
                    'i18n.dialog.confirmDeleteLanguage',
                    'Delete every saved {language} translation, including your edits? This cannot be undone; you can translate again later.',
                    { language: languageLabel },
                  )
                : t(
                    'i18n.dialog.confirmResetPage',
                    'Remove the machine translations of this page for {language}? Your edits are kept.',
                    { language: languageLabel },
                  )}
            </p>
            <div className="project-dialog-actions">
              <button type="button" className="ghost-button" onClick={() => setConfirming('')}>
                {t('common.action.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={isBusy}
                onClick={() => removeTranslations(confirming)}
              >
                {confirming === 'language'
                  ? t('i18n.dialog.deleteLanguage', 'Delete language')
                  : t('i18n.dialog.resetPage', 'Reset translation for this page')}
              </button>
            </div>
          </div>
        )}

        {step !== 'choose' && preview && (
          <div className="project-dialog-actions translate-actions">
            {step === 'running' ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => runRef.current?.abort()}
              >
                {t('i18n.dialog.cancelRun', 'Cancel translation')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    setStep('choose');
                    setPreview(null);
                    setReport(null);
                    setConfirming('');
                  }}
                >
                  {t('i18n.dialog.back', 'Choose another language')}
                </button>
                {step === 'review' ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => loadPreview(preview.lang)}
                  >
                    {t('i18n.dialog.backToSummary', 'Back to summary')}
                  </button>
                ) : (
                  <button type="button" className="ghost-button" onClick={() => setStep('review')}>
                    {t('i18n.dialog.reviewStrings', 'Review and edit strings')}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setConfirming('page')}
                >
                  {t('i18n.dialog.resetPage', 'Reset translation for this page')}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setConfirming('language')}
                >
                  {t('i18n.dialog.deleteLanguage', 'Delete language')}
                </button>
                {step === 'preview' && preview.strings > 0 && (
                  <button
                    type="button"
                    className="primary"
                    disabled={!preview.hasKey || preview.provider !== 'openai' || isBusy}
                    onClick={send}
                  >
                    {t('i18n.dialog.send', 'Send to OpenAI')}
                  </button>
                )}
                {(step === 'report' || preview.strings === 0) && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => applyLanguage(preview.lang)}
                  >
                    {t('i18n.dialog.use', 'Use {language}', { language: preview.nativeName })}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
