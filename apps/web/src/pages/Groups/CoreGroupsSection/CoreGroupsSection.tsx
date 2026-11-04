import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { coreRefusalOf, taskStateLabel, useCoreTasks } from '@entities/CoreTask';
import { CoreLaunchScreen, type LaunchDraft } from '@features/CoreLaunch';
import { CORE_TASKS_ROUTE } from '@shared/config/routes';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { LegacyRuns } from '../LegacyRuns/LegacyRuns';

/** Запуск, открытый переводом группы: ключ пересоздаёт форму под новый сценарий. */
export interface CoreLaunchRequest {
  key: string;
  initial: Partial<LaunchDraft>;
}

interface CoreGroupsSectionProps {
  launch: CoreLaunchRequest | undefined;
  onLaunch: (request: CoreLaunchRequest | undefined) => void;
}

/**
 * Верх страницы групп над ядром (этап 10, F1): задачи ядра списком со ссылкой на ленту, вход в
 * запуск с оценкой (тот же экран этапа 9) и прежние запуски только для чтения. Запуск открывается
 * здесь же — со сценарием из «Пути» группы, если его открыл перевод «В ядро».
 */
export function CoreGroupsSection({ launch, onLaunch }: CoreGroupsSectionProps) {
  const { t } = useTranslation();
  const P = 'groupsPage.core';
  const { data, isLoading, error, refetch } = useCoreTasks();
  const refusal = coreRefusalOf(error);
  const [seq, setSeq] = useState(0);

  const toggleLaunch = () => {
    if (launch) return onLaunch(undefined);
    setSeq((n) => n + 1);
    onLaunch({ key: `blank-${seq}`, initial: {} });
  };

  return (
    <Stack gap="var(--spacing-sm)" data-groups-core>
      <Stack direction="row" gap="var(--spacing-xs)" align="center" justify="between" wrap>
        <Typography variant="heading-sm" as="h2">
          {t(`${P}.heading`)}
        </Typography>
        <Button
          variant={launch ? 'secondary' : 'primary'}
          leftIcon={<Icon name={launch ? 'close' : 'play'} size={20} />}
          onClick={toggleLaunch}
          data-groups-core-launch-toggle
        >
          {launch ? t(`${P}.hideLaunch`) : t(`${P}.launch`)}
        </Button>
      </Stack>
      <Typography variant="body-sm" color="subtle">
        {t(`${P}.hint`)}
      </Typography>
      {isLoading && <SkeletonList rows={2} />}
      {refusal && (
        <Typography variant="body-sm" color="warning" data-groups-core-refusal={refusal}>
          {t(`${P}.refusal.${refusal}`)}
        </Typography>
      )}
      {error && !refusal && (
        <LoadErrorCard title={t(`${P}.loadError`)} onRetry={() => void refetch()} />
      )}
      {data && data.tasks.length === 0 && (
        <Typography variant="body-sm" color="subtle" data-groups-core-empty>
          {t(`${P}.empty`)}
        </Typography>
      )}
      {data && data.tasks.length > 0 && (
        <Stack gap="var(--spacing-xs)" data-core-task-list>
          {data.tasks.map((task) => (
            <Card padding="sm" key={task.taskId} data-core-task={task.taskId}>
              {/* Заголовок занимает остаток строки и режется многоточием: длинное имя задачи (путь)
                  не переносит статус и «Открыть» — они стоят на одном месте в каждой строке. */}
              <Stack direction="row" gap="var(--spacing-xs)" align="center">
                <Stack flex={1} minWidth={0}>
                  <Typography
                    variant="body-sm"
                    weight="medium"
                    as="span"
                    truncate
                    title={task.title ?? undefined}
                  >
                    {task.title ?? t('coreTimeline.task.untitled')}
                  </Typography>
                </Stack>
                <Badge tone={task.live && task.ended === null ? 'accent' : 'neutral'}>
                  {taskStateLabel(t, task.state)}
                </Badge>
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
            </Card>
          ))}
        </Stack>
      )}
      {launch && !refusal && <CoreLaunchScreen key={launch.key} initial={launch.initial} />}
      <LegacyRuns />
    </Stack>
  );
}
