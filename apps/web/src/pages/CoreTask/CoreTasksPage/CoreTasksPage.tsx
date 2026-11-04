import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CoreHopsNotice, coreRefusalOf, taskStateLabel, useCoreTasks } from '@entities/CoreTask';
import { CoreAutostartToggle, CoreFaultCard } from '@features/CoreFault';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { PageHeader } from '@shared/ui/page-header';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { CoreTaskPage } from '../CoreTaskPage/CoreTaskPage';
import { isRunning } from '../model/taskPage';

/**
 * Раздел «Задачи ядра» `/core` (этап 9): список задач ядра через прокладку `/api/core/*`, карточка
 * отказа прокладки по коду. `?id=<taskId>` — общий адрес открытого элемента панели — открывает
 * ленту задачи; `key` по задаче, чтобы свёртка прежней задачи не смешалась с новой.
 */
export function CoreTasksPage() {
  const { id } = useSearch({ strict: false }) as { id?: string };
  if (id) return <CoreTaskPage key={id} taskId={id} />;
  return <CoreTaskList />;
}

function CoreTaskList() {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useCoreTasks();
  const navigate = useNavigate();
  const refusal = coreRefusalOf(error);

  // Запуск и сценарии не стоят в боковом меню — вход в них отсюда, из шапки раздела.
  return (
    <Stack gap="var(--spacing-lg)" data-core-tasks-page>
      <PageHeader
        title={t('coreTimeline.title')}
        subtitle={t('coreTimeline.subtitle')}
        helpTopic="core"
        actions={
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            <Button
              variant="secondary"
              leftIcon={<Icon name="branch" size={24} />}
              onClick={() => void navigate({ to: '/core/scenarios' } as never)}
              data-core-open="scenarios"
            >
              {t('nav.coreScenarios')}
            </Button>
            <Button
              leftIcon={<Icon name="play" size={24} />}
              onClick={() => void navigate({ to: '/core/launch' } as never)}
              data-core-open="launch"
            >
              {t('nav.coreLaunch')}
            </Button>
          </Stack>
        }
      />
      <CoreHopsNotice />
      {data && <CoreAutostartToggle />}
      {isLoading && <SkeletonList rows={3} />}
      {refusal && <CoreFaultCard refusal={refusal} />}
      {error && !refusal && (
        <LoadErrorCard title={t('coreTimeline.loadError')} onRetry={() => void refetch()} />
      )}
      {data && data.tasks.length === 0 && (
        <EmptyState
          icon="layers"
          title={t('coreTimeline.empty.title')}
          text={t('coreTimeline.empty.text')}
        />
      )}
      {data && data.tasks.length > 0 && (
        <Stack gap="var(--spacing-xs)" data-core-task-list>
          {data.tasks.map((task) => (
            <Card padding="md" key={task.taskId} data-core-task={task.taskId}>
              <Stack gap="var(--spacing-3xs)">
                <Typography variant="body-sm" weight="medium" as="span">
                  {task.title ?? t('coreTimeline.task.untitled')}
                </Typography>
                <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
                  {/* `live` у ядра — журнал задачи открыт в этом процессе, и закончившаяся задача
                      остаётся открытой: «Идёт» рядом с `cancelled` читалось бы как ложь. */}
                  <Badge tone={isRunning(task) ? 'accent' : 'neutral'}>
                    {isRunning(task) ? t('coreTimeline.task.live') : t('coreTimeline.task.stored')}
                  </Badge>
                  <Badge tone="neutral">{taskStateLabel(t, task.state)}</Badge>
                  <Link
                    to={CORE_TASKS_ROUTE}
                    search={{ id: task.taskId } as never}
                    data-core-task-open={task.taskId}
                  >
                    <Typography variant="body-sm" as="span" color="accent">
                      {t('coreTimeline.task.open')}
                    </Typography>
                  </Link>
                </Stack>
                {task.attention && (
                  <Typography variant="caption" color="subtle" as="span">
                    {t('coreTimeline.task.attention', { reason: task.attention })}
                  </Typography>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
