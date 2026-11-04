import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { CoreHopsNotice, coreRefusalOf, taskStateLabel, useCoreTask } from '@entities/CoreTask';
import { AskCard } from '@features/CoreAsk';
import { CoreFaultCard } from '@features/CoreFault';
import { ReportView } from '@features/CoreReport';
import { BudgetsPanel, CoreTimeline, SignalsPanel, useCoreTimeline } from '@features/CoreTimeline';
import { Badge } from '@shared/ui/badge';
import { EmptyState } from '@shared/ui/empty-state';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { openAsks, streamState, taskTitle } from '../model/taskPage';
import type { CoreTaskPageProps } from './CoreTaskPage.types';
import styles from './CoreTaskPage.module.scss';

const STREAM_COLOR = { live: 'muted', dropped: 'warning', refused: 'danger' } as const;

/**
 * Лента одной задачи ядра `/core?id=<taskId>` (07:18-22): вопросы, ждущие человека, — сверху,
 * лента по времени, справа расход с окнами и сигналы, внизу итоговый отчёт. Вид задачи (числа,
 * состояния) — от ядра, лента — из потока; отказ прокладки — карточкой по коду.
 */
export function CoreTaskPage({ taskId }: CoreTaskPageProps) {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useCoreTask(taskId);
  const view = data?.view;
  const { fold, dropped, refusal: streamRefusal } = useCoreTimeline(taskId);
  const refusal = coreRefusalOf(error);
  const asks = useMemo(() => openAsks(fold, view), [fold, view]);
  const title = taskTitle(fold) ?? t('coreTimeline.task.untitled');
  const notFound = (error as { response?: { status?: number } } | null)?.response?.status === 404;
  const stream = streamState(streamRefusal, dropped);

  return (
    <Stack gap="var(--spacing-lg)" data-core-task-page={taskId}>
      <Link to={CORE_TASKS_ROUTE} className={styles.back}>
        <Typography variant="body-sm" as="span" color="accent">
          {t('coreTimeline.page.back')}
        </Typography>
      </Link>
      <PageHeader title={title} subtitle={taskId} helpTopic="core" />
      <CoreHopsNotice />
      {refusal && <CoreFaultCard refusal={refusal} />}
      {notFound && (
        <EmptyState icon="warning" title={t('coreTimeline.page.noTask')} text={taskId} />
      )}
      {error && !refusal && !notFound && (
        <LoadErrorCard title={t('coreTimeline.page.loadError')} onRetry={() => void refetch()} />
      )}
      {isLoading && <SkeletonList rows={4} />}
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap data-core-stream>
        {view && (
          <Badge tone="neutral">
            {t('coreTimeline.page.state', { state: taskStateLabel(t, view.state) })}
          </Badge>
        )}
        {view?.ended && (
          <Badge tone={view.ended === 'done' ? 'success' : 'danger'} data-core-ended={view.ended}>
            {t(`coreTimeline.page.ended.${view.ended}`)}
          </Badge>
        )}
        <Typography
          variant="caption"
          color={STREAM_COLOR[stream]}
          as="span"
          data-stream-state={stream}
        >
          {t(`coreTimeline.page.stream.${stream}`, { status: streamRefusal })}
        </Typography>
      </Stack>
      {asks.length > 0 && (
        <Stack gap="var(--spacing-xs)" data-core-asks={asks.length}>
          <Typography variant="heading-sm" as="h2">
            {t('coreTimeline.ask.title')}
          </Typography>
          {asks.map(({ ask, state }) => (
            <AskCard key={ask.askId} taskId={taskId} ask={ask} state={state} />
          ))}
        </Stack>
      )}
      <div className={styles.columns}>
        <CoreTimeline taskId={taskId} fold={fold} view={view} />
        <Stack gap="var(--spacing-md)">
          {view && <BudgetsPanel view={view} />}
          <SignalsPanel fold={fold} />
        </Stack>
      </div>
      <ReportView taskId={taskId} reportRef={view?.report ?? null} />
    </Stack>
  );
}
