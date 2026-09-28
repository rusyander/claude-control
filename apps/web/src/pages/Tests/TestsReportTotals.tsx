import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { shownCost } from './model/reportMetrics';
import type { TestsReportTotalsProps } from './TestsReportTotals.types';

/** Карточка «Итого» отчёта: прогоны, токены, стоимость, время, карантин, последний прогон. */
export function TestsReportTotals({ totals }: TestsReportTotalsProps) {
  // Дата — языком интерфейса, а не браузера: английская панель иначе
  // показывала русские даты (F-323).
  const { t, i18n } = useTranslation();
  const cost = shownCost(totals.costUsd);

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('tests.report.totals')}
        </Typography>
        <Typography variant="body-sm">
          {t('tests.report.runsCount', { count: totals.runs })}
        </Typography>
        <Typography variant="body-sm">
          {t('tests.report.tokens', { count: totals.tokens })}
        </Typography>
        {cost && (
          <Typography variant="body-sm">{t('tests.report.cost', { value: cost })}</Typography>
        )}
        <Typography variant="body-sm">
          {t('tests.report.duration', { minutes: Math.round(totals.durationMs / 60000) })}
        </Typography>
        {/* Карантин показывается ТОЛЬКО когда он есть: строка «в карантине
            0» приучает не читать это место, а именно из него сборка узнаёт,
            почему она зелёная при красном кейсе. */}
        {totals.muted > 0 && (
          <Typography variant="body-sm">
            {t('tests.report.muted', { count: totals.muted })}
          </Typography>
        )}
        {totals.lastRunAt && (
          <Typography variant="caption" color="subtle">
            {t('tests.report.lastRun', {
              time: new Date(totals.lastRunAt).toLocaleString(i18n.language),
            })}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}
