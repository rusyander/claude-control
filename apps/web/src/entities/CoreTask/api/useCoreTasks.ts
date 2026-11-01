import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HealthReply, TaskReply, TasksReply } from '@agentdeck/contracts/core/panel-api';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { queryKeys } from '@shared/api/query-keys';
import type { CommandDraft } from '../model/command';
import { followCoreEvents, type SseEvent } from '../model/sse';
import { coreGet, coreUrl, sendCoreCommand } from './coreApi';

/** Список задач ядра; ядра нет — ошибка запроса с кодом `core-absent` (карточка решает сама). */
export function useCoreTasks() {
  return useQuery({
    queryKey: queryKeys.core.tasks,
    queryFn: () => coreGet<TasksReply>('/tasks'),
    retry: false,
  });
}

/** Пауза между перечитками здоровья ядра: запись звена сторожем видна без перезагрузки. */
const HEALTH_REFRESH_MS = 10_000;

/** Здоровье ядра: звенья панели, очередь, окна маршрутов. Ядра нет — ошибка, ответ решает страница. */
export function useCoreHealth() {
  return useQuery({
    queryKey: queryKeys.core.health,
    queryFn: () => coreGet<HealthReply>('/health'),
    refetchInterval: HEALTH_REFRESH_MS,
    retry: false,
  });
}

/** Задача целиком: свёртка ядра, живость и вид для панели. */
export function useCoreTask(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.core.task(taskId ?? ''),
    queryFn: () => coreGet<TaskReply>('/tasks/:id', { id: taskId ?? '' }),
    enabled: Boolean(taskId),
    retry: false,
  });
}

/** Только вид задачи для панели (P43: числа расхода посчитаны ядром через `spendOf`). */
export function useCoreTaskView(taskId: string | undefined): {
  view: TaskView | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const { data, isLoading, error } = useCoreTask(taskId);
  return { view: data?.view, isLoading, error };
}

/** Пауза между перечитками вида, пока строки ленты идут подряд: одна перечитка на пачку. */
const VIEW_REFRESH_MS = 400;

/**
 * Живая лента задачи: каждая строка журнала из потока — в `onEvent`, вид задачи перечитывается
 * (не чаще раза в `VIEW_REFRESH_MS`). Обрыв возобновляется с последнего номера (`Last-Event-ID`);
 * отказ (задачи нет, ядро не подтвердило себя) — `refusal`, повтор решает страница.
 */
export function useCoreTaskEvents(
  taskId: string | undefined,
  onEvent?: (event: SseEvent) => void,
): { lastEventId: string | undefined; refusal: number | undefined; dropped: boolean } {
  const queryClient = useQueryClient();
  const [lastEventId, setLastEventId] = useState<string | undefined>();
  const [refusal, setRefusal] = useState<number | undefined>();
  const [dropped, setDropped] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!taskId) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: queryKeys.core.task(taskId) });
      }, VIEW_REFRESH_MS);
    };
    setRefusal(undefined);
    void followCoreEvents({
      url: `/api${coreUrl('/tasks/:id/events', { id: taskId })}`,
      signal: abort.signal,
      onEvent: (event) => {
        setDropped(false);
        if (event.id !== undefined) setLastEventId(event.id);
        handler.current?.(event);
        refresh();
      },
      onRefusal: (status) => setRefusal(status),
      onDrop: () => setDropped(true),
    });
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [taskId, queryClient]);

  return { lastEventId, refusal, dropped };
}

/** Команда задачи (число страницы → конверт); после исхода вид задачи перечитывается. */
export function useCoreCommand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: CommandDraft) => sendCoreCommand(draft),
    onSuccess: (_outcome, draft) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.core.task(draft.taskId) }),
  });
}
