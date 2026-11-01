import { useTranslation } from 'react-i18next';
import { useCoreTask, useCoreTasks } from '@entities/CoreTask';
import { TaskScenarioForm, taskScenarioOf } from '@features/ScenarioEditor';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SelectField } from '@shared/ui/select-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import type { TaskTabProps } from './TaskTab.types';
import styles from './TaskTab.module.scss';

/**
 * Правка сценария идущей задачи: выбор из живых задач ядра (законченной сценарий не правят —
 * ядро ответит `task-ended`), затем черновик от действующей версии задачи. Задача — в адресе
 * (`?tab=task&id=<taskId>`): лента задачи ведёт сюда ссылкой.
 */
export function TaskTab({ library, taskId, onPick }: TaskTabProps) {
  const { t } = useTranslation();
  const tasks = useCoreTasks();
  const task = useCoreTask(taskId);
  const live = (tasks.data?.tasks ?? []).filter((item) => item.live && item.ended === null);
  const scenario = taskScenarioOf(task.data?.view.scenario);

  if (tasks.isLoading) return <SkeletonList rows={3} />;
  if (tasks.isError) {
    return <LoadErrorCard onRetry={() => void tasks.refetch()} />;
  }
  if (live.length === 0 && !taskId) {
    return (
      <Typography variant="body-sm" color="subtle" as="p">
        {t('coreScenario.task.none')}
      </Typography>
    );
  }

  return (
    <Stack gap="var(--spacing-md)" data-task-tab>
      <div className={styles.pick}>
        <SelectField
          label={t('coreScenario.task.pick')}
          hint={t('coreScenario.task.pickHint')}
          value={taskId ?? ''}
          options={[
            { value: '', label: t('coreScenario.task.choose'), disabled: true },
            ...live.map((item) => ({
              value: item.taskId,
              label: `${item.title ?? item.taskId} · ${item.state}`,
            })),
          ]}
          onChange={onPick}
        />
      </div>
      {taskId && task.isLoading && <SkeletonList rows={4} />}
      {taskId && task.isError && <LoadErrorCard onRetry={() => void task.refetch()} />}
      {taskId && task.data && !scenario && (
        <Typography variant="body-sm" color="subtle" as="p">
          {t('coreScenario.task.noScenario')}
        </Typography>
      )}
      {taskId && scenario && (
        <TaskScenarioForm
          taskId={taskId}
          current={scenario.current}
          isPending={scenario.pending}
          library={library}
        />
      )}
    </Stack>
  );
}
