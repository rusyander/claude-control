import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ReportReply } from '@agentdeck/contracts/core/panel-api';
import { coreGet, failureOf, failureReason } from '@entities/CoreTask';
import { queryKeys } from '@shared/api/query-keys';
import { Badge } from '@shared/ui/badge';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ReportBody } from '../ReportBody/ReportBody';
import type { ReportViewProps } from './ReportView.types';

const OUTCOME_TONE = {
  done: 'success',
  'ready-to-publish': 'success',
  cancelled: 'danger',
  failed: 'danger',
} as const satisfies Record<ReportReply['report']['outcome'], 'success' | 'danger'>;

/**
 * Итоговый отчёт задачи (07:22, P96). Тело читается, только когда вид задачи сослался на
 * `report.final`: до конца задачи отчёта нет, и запрос был бы заведомо пустым. 501 — ядро ещё
 * не отдаёт тело (чтение зоны ядра не подключено): карточка говорит это и показывает sha записи.
 */
export function ReportView({ taskId, reportRef }: ReportViewProps) {
  const { t } = useTranslation();
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.core.report(taskId),
    queryFn: () => coreGet<ReportReply>('/tasks/:id/report', { id: taskId }),
    enabled: reportRef !== null,
    retry: false,
  });
  const failure = error ? failureOf(error) : null;
  return (
    <Card padding="md" data-core-report={reportRef ? reportRef.sha256 : 'pending'}>
      <Stack gap="var(--spacing-xs)">
        <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
          <Typography variant="heading-sm" as="h2">
            {t('coreTimeline.report.title')}
          </Typography>
          {data && (
            // Тон — как у исхода в шапке ленты: отменённая задача не «успех», иначе на одной
            // странице шапка красная, а отчёт зелёный.
            <Badge tone={OUTCOME_TONE[data.report.outcome]}>
              {t(`coreTimeline.report.outcome.${data.report.outcome}`)}
            </Badge>
          )}
        </Stack>
        {reportRef === null && (
          <Typography variant="body-sm" color="muted">
            {t('coreTimeline.report.pending')}
          </Typography>
        )}
        {reportRef && isLoading && (
          <Typography variant="caption" color="muted">
            {t('coreTimeline.report.loading')}
          </Typography>
        )}
        {reportRef && failure && (
          <Typography variant="body-sm" color="warning" data-report-failure={failure.status ?? 0}>
            {failure.status === 501
              ? t('coreTimeline.report.missing', { sha: reportRef.sha256.slice(0, 12) })
              : t('coreTimeline.report.loadError', { reason: failureReason(failure) })}
          </Typography>
        )}
        {data && <ReportBody report={data.report} />}
      </Stack>
    </Card>
  );
}
