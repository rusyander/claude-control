import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Stack } from '@shared/ui/stack';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { STATUS_TONE } from '@entities/ProjectTest';
import styles from './TestsRecordedTab.module.scss';
import type { RecordedCaseRowProps } from './TestsRecordedTab.types';

/**
 * Строка записанного сценария: имя, статус, спек, сколько шагов легло «не проверено» и
 * полоска последних прогонов (новые слева). Полоска — ответ на «давно ли он зелёный», ради
 * которого человек и открывает вкладку: один красный среди двадцати зелёных — не то же, что
 * красный пятый раз подряд.
 */
export function RecordedCaseRow({ item }: RecordedCaseRowProps) {
  const { t, i18n } = useTranslation();
  const status = item.status ?? 'unknown';
  const date = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <li className={styles.row} data-testid="recorded-case">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="body" weight="medium">
            {item.title}
          </Typography>
          <Badge tone={STATUS_TONE[status]} withDot>
            {t(`testsRecorded.status.${status}`)}
          </Badge>
          {item.unchecked > 0 && (
            <Badge tone="warning">{t('testsRecorded.gaps', { count: item.unchecked })}</Badge>
          )}
        </Stack>
        <Typography variant="mono" color="muted" truncate title={item.testName}>
          {item.file}
        </Typography>
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          {item.history.length > 0 ? (
            <ol
              className={styles.strip}
              aria-label={t('testsRecorded.history', { count: item.history.length })}
            >
              {item.history.map((mark) => {
                const label = `${date.format(new Date(mark.startedAt))} — ${t(`testsRecorded.status.${mark.status}`)}`;
                return (
                  <li
                    key={mark.runId}
                    className={styles.mark}
                    data-tone={STATUS_TONE[mark.status]}
                    title={label}
                  >
                    {/* Цвет и `title` скринридер не читает: статус прогона — текстом для него. */}
                    <span className={styles.srOnly}>{label}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Typography variant="caption" color="subtle">
              {t('testsRecorded.noHistory')}
            </Typography>
          )}
          {item.history.length > 0 && (
            // Без наведения: сколько последних прогонов прошли — ответ полоски словами.
            <Typography variant="caption" color="subtle" data-recorded-history-summary>
              {t('testsRecorded.historySummary', {
                passed: item.history.filter((m) => m.status === 'passed').length,
                count: item.history.length,
              })}
            </Typography>
          )}
          {item.taskId && (
            <Link
              to={CORE_TASKS_ROUTE}
              search={{ id: item.taskId } as never}
              className={styles.taskLink}
            >
              {t('testsRecorded.task')}
            </Link>
          )}
        </Stack>
      </Stack>
    </li>
  );
}
