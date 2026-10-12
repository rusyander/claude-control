import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { issueText } from '../../lib/apiIssue';
import { formatSize, prettyBody, statusTone } from '../../lib/apiRequest';
import type { ApiResponseViewProps } from './ApiExplorer.types';
import styles from './ApiExplorer.module.scss';

const VERDICT_TONE = {
  ok: 'success',
  mismatch: 'danger',
  'no-schema': 'neutral',
  'undocumented-status': 'warning',
  'not-json': 'warning',
} as const;

const VERDICT_ICON = {
  ok: 'check',
  mismatch: 'error',
  'no-schema': 'info',
  'undocumented-status': 'warning',
  'not-json': 'warning',
} as const;

/**
 * Ответ: код, время, размер, вердикт сверки со схемой и тело. Вердикт — над
 * телом: «совпало ли с контрактом» — главный вопрос, ради которого запрос
 * шлют отсюда, а не из curl.
 */
export function ApiResponseView({ result, onAskMismatch }: ApiResponseViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const check = result.check;
  const body = prettyBody(result.body);

  return (
    <section
      className={`${styles.card} ${styles.response}`}
      data-tone={statusTone(result.status)}
      aria-label={t('environment.api.response.label')}
    >
      <h3 className={styles.cardTitle}>{t('environment.api.response.label')}</h3>
      <div className={styles.facts}>
        <Badge tone={statusTone(result.status)}>
          {`${result.status} ${result.statusText}`.trim()}
        </Badge>
        <span className={styles.sub}>
          {t('environment.api.response.duration', { ms: result.durationMs })} ·{' '}
          {formatSize(result.sizeBytes)}
        </span>
        <code className={styles.urlLine}>{result.url}</code>
      </div>

      {check && (
        <div className={styles.verdict} data-tone={VERDICT_TONE[check.verdict]} role="status">
          <p className={styles.noticeTitle}>
            <Icon name={VERDICT_ICON[check.verdict]} size={16} />
            {t(`environment.api.response.verdict.${check.verdict}`, {
              against: check.against ?? '',
              status: result.status,
              count: check.issues.length,
            })}
          </p>
          {check.issues.length > 0 && (
            <ul className={styles.issues}>
              {check.issues.map((issue, index) => (
                <li key={`${issue.path}-${issue.kind}-${index}`}>{issueText(issue, t)}</li>
              ))}
            </ul>
          )}
          {check.truncated && (
            <p className={styles.sub}>{t('environment.api.response.truncatedIssues')}</p>
          )}
          {onAskMismatch && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Icon name="chat" size={16} />}
                onClick={onAskMismatch}
              >
                {t('environment.api.response.askMismatch')}
              </Button>
            </div>
          )}
        </div>
      )}

      {result.bodyTruncated && (
        <p className={styles.notice} data-tone="warning">
          <Icon name="warning" size={16} />
          {t('environment.api.response.truncated')}
        </p>
      )}
      {result.binary ? (
        <p className={styles.sub}>
          {t('environment.api.response.binary', { type: result.contentType ?? '?' })}
        </p>
      ) : (
        <>
          {result.body ? (
            <div className={styles.bodyBlock}>
              <div className={styles.bodyHead}>
                <span className={styles.fieldLabel}>{t('environment.api.request.body')}</span>
                {result.contentType && <span className={styles.sub}>{result.contentType}</span>}
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<Icon name={copied ? 'check' : 'copy'} size={16} />}
                  onClick={() =>
                    void navigator.clipboard.writeText(result.body).then(() => setCopied(true))
                  }
                >
                  {copied
                    ? t('environment.api.response.copied')
                    : t('environment.api.response.copy')}
                </Button>
              </div>
              {/* Прокручиваемая область — в обходе с клавиатуры, чтобы длинный ответ читался без мыши. */}
              <pre
                className={styles.responseBody}
                tabIndex={0}
                aria-label={t('environment.api.response.label')}
              >
                {body}
              </pre>
            </div>
          ) : (
            <p className={styles.sub}>{t('environment.api.response.empty')}</p>
          )}
        </>
      )}

      <details className={styles.headers}>
        <summary>{t('environment.api.response.headers', { count: result.headers.length })}</summary>
        <dl>
          {result.headers.map(([name, value]) => (
            <div key={name} className={styles.headerRow}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
