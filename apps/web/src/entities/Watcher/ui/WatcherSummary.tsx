import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { formatDuration } from '@shared/lib/format-duration';
import { watcherSpendText } from '../model/spend';
import type { WatcherSummaryProps } from './WatcherSummary.types';

/**
 * Сводка включённого наблюдателя: сколько работает, сколько потратил, что в
 * отчёте и почему он не может работать, если не может. Одна на индикатор и
 * карточку настроек — иначе две формулировки одного и того же разъехались бы.
 */
export function WatcherSummary({
  status,
  elapsed,
  costUnit,
  showReportPath = false,
}: WatcherSummaryProps) {
  const { t, i18n } = useTranslation();
  const spend = watcherSpendText(status.spend, costUnit);
  const problem = status.problem;
  const problemKey = problem ? `watcher.problem.${problem.problemCode}` : '';
  // Код, которого словарь ещё не знает (сервер новее страницы), — фраза сервера.
  let problemText: string | undefined;
  if (problem) problemText = i18n.exists(problemKey) ? t(problemKey) : problem.message;

  return (
    <Stack gap="var(--spacing-2xs)">
      {status.enabled && (
        <Typography variant="body-sm" as="span" data-watcher-elapsed>
          {t('watcher.running', { time: formatDuration(elapsed, t) })}
        </Typography>
      )}
      <Typography variant="body-sm" as="span" data-watcher-spend>
        {t('watcher.spend', { spend: spend.text })}
        {spend.estimate && ` (${t('watcher.spendEstimate')})`}
        {status.spend.runs > 0 && ` · ${t('watcher.runs', { count: status.spend.runs })}`}
      </Typography>
      <Typography variant="body-sm" color="muted" as="span" data-watcher-findings>
        {t('watcher.findings', { count: status.findings })}
        {(status.remarks ?? 0) > 0 && `, ${t('watcher.remarks', { count: status.remarks })}`}
        {status.analyzing && ` · ${t('watcher.analyzing')}`}
      </Typography>
      {status.pending > 0 && (
        <Typography variant="caption" color="subtle" as="span">
          {t('watcher.pending', { count: status.pending })}
        </Typography>
      )}
      {showReportPath && (
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {t('watcher.report')}
          </Typography>
          <Typography variant="body-sm" as="code" data-watcher-report-path>
            {status.reportPath}
          </Typography>
        </Stack>
      )}
      {problem && (
        <Stack gap="var(--spacing-3xs)" role="status" data-watcher-problem={problem.problemCode}>
          <Typography variant="body-sm" weight="medium" as="span">
            {t('watcher.problemTitle')}
          </Typography>
          <Typography variant="body-sm" as="span">
            {problemText}
          </Typography>
          {problem.detail && (
            <Typography variant="caption" color="subtle" as="span">
              {problem.detail}
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
}
