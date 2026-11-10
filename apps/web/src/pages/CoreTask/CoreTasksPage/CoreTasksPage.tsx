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
import { CoreBoard } from '../CoreBoard/CoreBoard';
import { BoardImport } from '../CoreBoard/BoardImport';
import { CoreTaskPage } from '../CoreTaskPage/CoreTaskPage';
import { CORE_VIEWS, coreViewOf, type CoreBoardSearch, type CoreView } from '../model/boardSearch';
import { isRunning } from '../model/taskPage';

/**
 * Раздел «Задачи ядра» `/core` (этап 9; этап 12 — доска по умолчанию, D13): `?view=board|list`
 * переключает доску и список, `?lane=group` / `?group=` — полосы групп доски. `?id=<taskId>` —
 * общий адрес открытого элемента панели — открывает ленту задачи; `key` по задаче, чтобы свёртка
 * прежней задачи не смешалась с новой.
 */
export function CoreTasksPage() {
  const search = useSearch({ strict: false }) as CoreBoardSearch & { id?: string };
  if (search.id) return <CoreTaskPage key={search.id} taskId={search.id} />;
  return <CoreTasksSection search={search} />;
}

function CoreTasksSection({ search }: { search: CoreBoardSearch }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const view = coreViewOf(search);
  const setView = (next: CoreView) =>
    void navigate({ to: '/core', search: { view: next }, replace: true } as never);

  // Запуск и сценарии не стоят в боковом меню — вход в них отсюда, из шапки раздела.
  return (
    <Stack gap="var(--spacing-lg)" data-core-tasks-page data-core-view={view}>
      <PageHeader
        title={t('coreTimeline.title')}
        subtitle={t('coreTimeline.subtitle')}
        helpTopic="core"
        actions={
          <Stack direction="row" gap="var(--spacing-xs)" wrap>
            {view === 'board' && <BoardImport />}
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
      <Stack
        direction="row"
        gap="var(--spacing-3xs)"
        role="group"
        aria-label={t('coreBoard.view.label')}
        data-core-view-toggle
      >
        {CORE_VIEWS.map((next) => (
          <Button
            key={next}
            size="sm"
            variant={view === next ? 'primary' : 'ghost'}
            aria-pressed={view === next}
            onClick={() => setView(next)}
            data-core-view-option={next}
          >
            {t(`coreBoard.view.${next}`)}
          </Button>
        ))}
      </Stack>
      <CoreHopsNotice />
      {view === 'board' ? <CoreBoard search={search} /> : <CoreTaskList />}
    </Stack>
  );
}

/** Вид «Список» — прежний список задач ядра (этап 9), переключатель рядом с доской. */
function CoreTaskList() {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useCoreTasks();
  const refusal = coreRefusalOf(error);

  return (
    <Stack gap="var(--spacing-lg)" data-core-task-list-view>
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
