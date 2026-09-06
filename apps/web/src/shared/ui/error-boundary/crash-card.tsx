import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../card';
import { Stack } from '../stack';
import { Typography } from '../typography';
import { Button } from '../button';
import type { CrashCardProps } from './error-boundary.types';
import styles from './crash-card.module.scss';

/** Короткая строка для экрана и полный текст со стеком для буфера обмена. */
function describe(error: unknown): { line: string; full: string } {
  if (error instanceof Error) {
    const line = error.message || error.name;
    return { line, full: `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim() };
  }
  const line = String(error);
  return { line, full: line };
}

/**
 * Что показать на месте упавшего компонента. Ошибка отрисовки — это ошибка в
 * коде панели, поэтому карточка говорит об этом прямо, даёт повторить без
 * перезагрузки и скопировать текст со стеком: это всё, что нужно для отчёта.
 */
export function CrashCard({ error, title, text, onRetry, compact }: CrashCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const { line, full } = describe(error);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(full)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  if (compact) {
    return (
      <div className={styles.compact} role="alert">
        <Typography variant="body-sm" color="subtle">
          {text ?? t('common.crashText')}
        </Typography>
        <code className={styles.line}>{line}</code>
        <div className={styles.actions}>
          {onRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {t('common.crashRetry')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? t('common.crashCopied') : t('common.crashCopy')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)" align="start">
        <div role="alert">
          <Typography variant="body" weight="medium">
            {title ?? t('common.crashTitle')}
          </Typography>
          <Typography variant="body-sm" color="subtle">
            {text ?? t('common.crashText')}
          </Typography>
        </div>
        <code className={styles.line}>{line}</code>
        <div className={styles.actions}>
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              {t('common.crashRetry')}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
            {t('common.crashReload')}
          </Button>
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? t('common.crashCopied') : t('common.crashCopy')}
          </Button>
        </div>
      </Stack>
    </Card>
  );
}
