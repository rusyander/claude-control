import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { formatDuration } from '@shared/lib/format-duration';
import { formatCompact, formatMoney, formatNumber } from '@shared/lib/format-number';
import { sessionSpanMs } from './model/sessionFacts';
import type { SessionDetailsProps } from './SessionDetails.types';
import styles from './AnalyticsPage.module.scss';

/**
 * Раскрывающиеся подробности сессии: на что ушли токены (вход, выход, чтение и
 * запись кэша), сколько запросов и времени, чем пользовался агент. Всё берётся
 * из уже загруженной сводки — запроса при раскрытии нет.
 */
export function SessionDetails({ session, locale }: SessionDetailsProps) {
  const { t } = useTranslation();
  const { totals } = session;
  const span = sessionSpanMs(session);

  const rows: Array<[label: string, value: string]> = [
    [t('analytics.totalTokens'), formatNumber(totals.total, locale)],
    [t('analytics.requests'), formatNumber(totals.requests, locale)],
    [t('analytics.inputTokens'), formatNumber(totals.input, locale)],
    [t('analytics.outputTokens'), formatNumber(totals.output, locale)],
    [t('analytics.cacheRead'), formatNumber(totals.cacheRead, locale)],
    [t('analytics.cacheCreation'), formatNumber(totals.cacheCreation, locale)],
    [t('analytics.estimatedCost'), formatMoney(session.estimatedCost, locale)],
  ];
  if (span !== undefined) rows.push([t('analytics.sessionDuration'), formatDuration(span, t)]);
  rows.push([
    t('analytics.sessionFieldStarted'),
    new Date(session.startedAt).toLocaleString(locale),
  ]);
  if (session.toolCalls !== undefined)
    rows.push([t('analytics.sessionToolCalls'), formatNumber(session.toolCalls, locale)]);

  return (
    <details className={styles.sessionMore}>
      <summary>{t('analytics.sessionDetails')}</summary>

      <Stack gap="var(--spacing-sm)" className={styles.sessionMoreBody}>
        <dl className={styles.sessionStats}>
          {rows.map(([label, value]) => (
            <div key={label} className={styles.sessionField}>
              <Typography as="dt" variant="caption" color="subtle">
                {label}
              </Typography>
              <Typography as="dd" variant="body-sm" weight="medium">
                {value}
              </Typography>
            </div>
          ))}
        </dl>

        {session.topTools && session.topTools.length > 0 && (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="caption" color="subtle">
              {t('analytics.sessionTools')}
            </Typography>
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {session.topTools.map((tool) => (
                <Badge key={tool.name} tone="neutral">
                  {tool.name} · {formatCompact(tool.count, locale)}
                </Badge>
              ))}
            </Stack>
          </Stack>
        )}
      </Stack>
    </details>
  );
}
