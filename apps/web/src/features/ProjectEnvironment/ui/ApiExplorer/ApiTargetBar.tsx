import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiSettings } from '@entities/ApiExplorer';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TextField } from '@shared/ui/text-field';
import { apiErrorText } from '../../lib/apiError';
import { isAbsoluteUrl } from '../../lib/apiRequest';
import type { ApiTargetBarProps } from './ApiExplorer.types';
import styles from './ApiExplorer.module.scss';

/** Сколько подсказок видно сразу; остальные — по «Ещё N». */
const VISIBLE_SUGGESTIONS = 4;

/**
 * Куда и с чем уходят запросы: базовый адрес (сохраняется для проекта при уходе
 * из поля или выборе подсказки) и заголовок авторизации. Подсказки — кнопками
 * под полем, у каждой написано, откуда она: запущенный сервис, `.env` проекта
 * или `servers` контракта. Значение заголовка вводится один раз и обратно в
 * браузер не приходит — видна только маска.
 */
export function ApiTargetBar({
  projectPath,
  info,
  suggestions,
  baseUrl,
  onBaseUrlChange,
}: ApiTargetBarProps) {
  const { t } = useTranslation();
  const id = useId();
  const settings = useApiSettings(projectPath);
  const [authForm, setAuthForm] = useState(false);
  const [header, setHeader] = useState(info.auth?.header ?? 'Authorization');
  const [value, setValue] = useState('');
  const [failure, setFailure] = useState<string>();
  const [savedBase, setSavedBase] = useState(false);
  const [allSuggestions, setAllSuggestions] = useState(false);

  const saveBase = (raw: string = baseUrl): void => {
    const next = raw.trim().replace(/\/+$/, '');
    if (next === (info.baseUrl ?? '')) return;
    if (next && !isAbsoluteUrl(next)) return;
    setFailure(undefined);
    settings.mutate(
      { baseUrl: next || null },
      {
        onSuccess: () => setSavedBase(true),
        onError: (error) => setFailure(apiErrorText(error, t)),
      },
    );
  };

  const saveAuth = (auth: { header: string; value: string } | null): void => {
    setFailure(undefined);
    settings.mutate(
      { auth },
      {
        onSuccess: () => {
          setAuthForm(false);
          setValue('');
        },
        onError: (error) => setFailure(apiErrorText(error, t)),
      },
    );
  };

  const shown = allSuggestions ? suggestions : suggestions.slice(0, VISIBLE_SUGGESTIONS);
  const hidden = suggestions.length - VISIBLE_SUGGESTIONS;
  const current = baseUrl.trim().replace(/\/+$/, '');

  return (
    <section className={styles.card} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className={styles.cardTitle}>
        {t('environment.api.target.connection')}
      </h3>
      <div className={styles.targetGrid}>
        <div className={styles.targetField}>
          <label htmlFor={`${id}-base`} className={styles.fieldLabel}>
            {t('environment.api.target.baseUrl')}
          </label>
          <input
            id={`${id}-base`}
            className={styles.input}
            value={baseUrl}
            placeholder="http://localhost:8080"
            spellCheck={false}
            aria-describedby={`${id}-hint`}
            onChange={(event) => {
              setSavedBase(false);
              onBaseUrlChange(event.target.value);
            }}
            onBlur={() => saveBase()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveBase();
            }}
          />
          <span id={`${id}-hint`} className={styles.sub}>
            {savedBase ? (
              <span className={styles.saved}>
                <Icon name="check" size={14} /> {t('environment.api.target.baseUrlSaved')}
              </span>
            ) : (
              t('environment.api.target.baseUrlHint')
            )}
          </span>
          {suggestions.length > 0 && (
            <div
              className={styles.suggestions}
              role="group"
              aria-label={t('environment.api.target.suggestions')}
            >
              {shown.map((item) => (
                <button
                  key={item.url}
                  type="button"
                  className={styles.suggestion}
                  aria-pressed={item.url === current}
                  aria-label={t('environment.api.target.useSuggestion', { url: item.url })}
                  title={
                    item.main
                      ? `${t('environment.api.target.fromMain')}: ${item.note ?? ''}`
                      : item.note
                  }
                  onClick={() => {
                    setSavedBase(false);
                    onBaseUrlChange(item.url);
                    saveBase(item.url);
                  }}
                >
                  <span className={styles.suggestionOrigin} data-origin={item.origin}>
                    {t(`environment.api.target.origin.${item.origin}`)}
                  </span>
                  <span className={styles.suggestionUrl}>{item.url}</span>
                  {item.note && (
                    <span className={styles.suggestionNote}>
                      {item.main && `${t('environment.api.target.fromMain')}: `}
                      {item.note}
                    </span>
                  )}
                </button>
              ))}
              {hidden > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={allSuggestions}
                  onClick={() => setAllSuggestions((open) => !open)}
                >
                  {allSuggestions
                    ? t('environment.api.target.suggestionsLess')
                    : t('environment.api.target.suggestionsMore', { count: hidden })}
                </Button>
              )}
            </div>
          )}
        </div>

        <div className={styles.auth}>
          <span className={styles.fieldLabel}>{t('environment.api.target.auth')}</span>
          <div className={styles.authStatus} data-set={Boolean(info.auth)}>
            <Icon name="lock" size={14} />
            {info.auth ? (
              <code className={styles.mono}>
                {info.auth.header}: {info.auth.masked}
              </code>
            ) : (
              <span>{t('environment.api.target.authNone')}</span>
            )}
          </div>
          <div className={styles.authActions}>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name={info.auth ? 'edit' : 'plus'} size={16} />}
              onClick={() => setAuthForm((open) => !open)}
              aria-expanded={authForm}
              aria-controls={`${id}-auth`}
            >
              {info.auth
                ? t('environment.api.target.authEdit')
                : t('environment.api.target.authAdd')}
            </Button>
            {info.auth && (
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Icon name="trash" size={16} />}
                onClick={() => saveAuth(null)}
              >
                {t('environment.api.target.authRemove')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {authForm && (
        <form
          id={`${id}-auth`}
          className={styles.authForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (header.trim() && value.trim()) saveAuth({ header: header.trim(), value });
          }}
        >
          <div className={styles.authHeaderField}>
            <TextField
              label={t('environment.api.target.authHeader')}
              value={header}
              onChange={setHeader}
              isMono
            />
          </div>
          <div className={styles.authValueField}>
            <TextField
              label={t('environment.api.target.authValue')}
              value={value}
              onChange={setValue}
              type="password"
              placeholder="Bearer eyJ…"
              autoFocus
            />
          </div>
          <div className={styles.authFormActions}>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={settings.isPending}
              disabled={!header.trim() || !value.trim()}
            >
              {t('environment.api.target.authSave')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAuthForm(false)}>
              {t('environment.api.target.authCancel')}
            </Button>
          </div>
          <p className={`${styles.sub} ${styles.authFormHint}`}>
            {t('environment.api.target.authValueHint')}
          </p>
        </form>
      )}
      {failure && (
        <p className={styles.error} role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
