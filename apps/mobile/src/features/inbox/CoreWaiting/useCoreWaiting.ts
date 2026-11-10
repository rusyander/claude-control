import { useQueries, useQuery } from '@tanstack/react-query';
import type { TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import { CORE_TASKS_KEY } from '../../../entities/core-task';
import { api } from '../../../shared/api/client';
import { coreWaitingCards, liveTaskIds, type WaitingTaskView } from './coreWaiting';
import type { CoreWaitingCard } from './coreWaiting.types';

/** Список задач — как у экрана задач ядра; виды идущих задач — реже: их по одному запросу на задачу. */
const LIST_POLL_MS = 3_000;
const VIEW_POLL_MS = 5_000;

/**
 * Задачи ядра, которые ждут человека: список `/core/tasks` и вид каждой идущей задачи
 * `/core/tasks/:id` (вопросы есть только в виде). Ключи кэша — те же, что у экранов задач ядра
 * (`entities/core-task`): открытый экран и вкладка «Вопросы» делят один запрос.
 */
export function useCoreWaiting(enabled: boolean): CoreWaitingCard[] {
  const list = useQuery({
    queryKey: [CORE_TASKS_KEY],
    queryFn: () => api.get<TasksReply>('/core/tasks'),
    enabled,
    refetchInterval: LIST_POLL_MS,
  });
  const tasks = list.data?.tasks ?? [];
  const ids = liveTaskIds(tasks);
  const details = useQueries({
    queries: ids.map((taskId) => ({
      queryKey: [CORE_TASKS_KEY, taskId],
      queryFn: () => api.get<TaskReply>(`/core/tasks/${encodeURIComponent(taskId)}`),
      enabled,
      refetchInterval: VIEW_POLL_MS,
    })),
  });
  const views = new Map<string, WaitingTaskView>();
  details.forEach((detail, index) => {
    const taskId = ids[index];
    if (taskId && detail.data?.view) views.set(taskId, detail.data.view);
  });
  return coreWaitingCards(tasks, views);
}
