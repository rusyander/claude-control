import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { API_METHODS, type ApiMethod } from '@entities/ApiExplorer';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SelectField } from '@shared/ui/select-field';
import {
  buildUrl,
  contentTypeOf,
  draftFromEndpoint,
  isAbsoluteUrl,
  jsonProblem,
  missingPathParams,
  prettyBody,
} from '../../lib/apiRequest';
import { fillWithSample } from '../../lib/apiSample';
import type { ApiRequestEditorProps } from './ApiExplorer.types';
import { KeyValueRows } from './KeyValueRows';
import { MethodBadge } from './MethodBadge';
import styles from './ApiExplorer.module.scss';

/**
 * Запрос: у эндпоинта контракта метод и путь заданы, видны поля параметров
 * пути и итоговый адрес; в свободном режиме — метод и адрес руками. Почему
 * кнопка «Отправить» недоступна, написано рядом с ней, а не угадывается.
 */
export function ApiRequestEditor({
  draft,
  onDraftChange,
  endpoint,
  baseUrl,
  authHeader,
  useAuth,
  onUseAuthChange,
  onSend,
  isSending,
}: ApiRequestEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const [filled, setFilled] = useState<number>();
  const missing = missingPathParams(draft);
  const url = buildUrl(baseUrl, draft);
  const noTarget = !isAbsoluteUrl(url);
  const hasBody = !['get', 'head'].includes(draft.method);
  const contentType = contentTypeOf(draft);
  const problem = hasBody ? jsonProblem(draft.body, contentType) : undefined;
  const blocked = missing.length > 0 || noTarget || (!endpoint && !draft.path.trim());
  let reason: string | undefined;
  if (missing.length > 0)
    reason = t('environment.api.request.missingParams', { list: missing.join(', ') });
  else if (noTarget) reason = t('environment.api.request.noBase');

  const pathParams = endpoint?.params.filter((param) => param.in === 'path') ?? [];
  const methodOptions = API_METHODS.map((method) => ({
    value: method,
    label: method.toUpperCase(),
  }));

  return (
    <section
      className={`${styles.card} ${styles.editor}`}
      aria-labelledby={`${id}-label`}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          if (!blocked && !isSending) onSend();
        }
      }}
    >
      <div className={styles.cardHead}>
        <h3 id={`${id}-label`} className={styles.cardTitle}>
          {t('environment.api.request.label')}
        </h3>
        {endpoint && (
          <div className={styles.cardHeadActions}>
            <span className={styles.sub} role="status">
              {filled !== undefined && t('environment.api.request.autofilled', { count: filled })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Icon name="edit" size={16} />}
              title={t('environment.api.request.autofillHint')}
              onClick={() => {
                const next = fillWithSample(draft, endpoint);
                setFilled(next.filled);
                onDraftChange(next.draft);
              }}
            >
              {t('environment.api.request.autofill')}
            </Button>
          </div>
        )}
      </div>

      {endpoint ? (
        <div className={styles.endpointHead}>
          <MethodBadge method={endpoint.method} />
          <span className={styles.endpointPath}>{endpoint.path}</span>
          {endpoint.summary && <span className={styles.sub}>{endpoint.summary}</span>}
        </div>
      ) : (
        <div className={styles.freeRow}>
          <div className={styles.methodPick}>
            <SelectField
              label={t('environment.api.request.method')}
              value={draft.method}
              onChange={(value) => onDraftChange({ ...draft, method: value as ApiMethod })}
              options={methodOptions}
            />
          </div>
          <div className={styles.grow}>
            <label htmlFor={`${id}-url`} className={styles.fieldLabel}>
              {t('environment.api.request.url')}
            </label>
            <input
              id={`${id}-url`}
              className={styles.input}
              value={draft.path}
              placeholder={t('environment.api.request.urlPlaceholder')}
              spellCheck={false}
              onChange={(event) => onDraftChange({ ...draft, path: event.target.value })}
            />
          </div>
        </div>
      )}
      {endpoint?.description && <p className={styles.sub}>{endpoint.description}</p>}

      {pathParams.length > 0 && (
        <fieldset className={styles.kv}>
          <legend className={styles.fieldLabel}>{t('environment.api.request.pathParams')}</legend>
          <div className={styles.paramGrid}>
            {pathParams.map((param) => (
              <label key={param.name} className={styles.param}>
                <span className={styles.paramName}>
                  {`{${param.name}}`}
                  <span className={styles.sub}> · {t('environment.api.request.required')}</span>
                </span>
                <input
                  className={styles.input}
                  value={draft.pathValues[param.name] ?? ''}
                  aria-invalid={missing.includes(param.name) || undefined}
                  spellCheck={false}
                  onChange={(event) =>
                    onDraftChange({
                      ...draft,
                      pathValues: { ...draft.pathValues, [param.name]: event.target.value },
                    })
                  }
                />
                {param.description && <span className={styles.sub}>{param.description}</span>}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <KeyValueRows
        label={t('environment.api.request.query')}
        rows={draft.query}
        onChange={(query) => onDraftChange({ ...draft, query })}
      />
      <KeyValueRows
        label={t('environment.api.request.headers')}
        rows={draft.headers}
        onChange={(headers) => onDraftChange({ ...draft, headers })}
      />
      {authHeader && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={useAuth}
            onChange={(event) => onUseAuthChange(event.target.checked)}
          />
          {t('environment.api.request.useAuth', { header: authHeader })}
        </label>
      )}

      {hasBody && (
        <div className={styles.bodyBlock}>
          <div className={styles.bodyHead}>
            <label htmlFor={`${id}-body`} className={styles.fieldLabel}>
              {t('environment.api.request.body')}
            </label>
            {contentType && (
              <span className={styles.sub}>
                {t('environment.api.request.bodyType', { type: contentType })}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!draft.body.trim() || Boolean(problem)}
              onClick={() => onDraftChange({ ...draft, body: prettyBody(draft.body) })}
            >
              {t('environment.api.request.formatJson')}
            </Button>
            {endpoint?.body?.example !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange({ ...draft, body: draftFromEndpoint(endpoint).body })}
              >
                {t('environment.api.request.resetBody')}
              </Button>
            )}
          </div>
          <textarea
            id={`${id}-body`}
            className={styles.code}
            value={draft.body}
            rows={8}
            spellCheck={false}
            aria-describedby={problem ? `${id}-problem` : undefined}
            onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
          />
          {problem && (
            <p id={`${id}-problem`} className={styles.notice} data-tone="warning">
              <Icon name="warning" size={16} />
              {t('environment.api.request.jsonProblem', { message: problem })}
            </p>
          )}
        </div>
      )}

      <div className={styles.finalUrl}>
        <span className={styles.fieldLabel}>{t('environment.api.request.finalUrl')}</span>
        <code className={styles.mono}>
          {draft.method.toUpperCase()} {url || '—'}
        </code>
      </div>
      <div className={styles.editorBar}>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="send" size={16} />}
          isLoading={isSending}
          disabled={blocked || isSending}
          onClick={onSend}
          title={t('environment.api.request.sendShortcut')}
        >
          {t('environment.api.request.send')}
        </Button>
        <span className={styles.sub}>
          {reason ?? (
            <>
              <kbd>{t('environment.api.request.sendShortcut')}</kbd> ·{' '}
              {t('environment.api.request.viaServer')}
            </>
          )}
        </span>
      </div>
    </section>
  );
}
