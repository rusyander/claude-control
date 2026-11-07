import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentNodeDetail, AgentsListReply } from '@agentdeck/contracts/core/agents';
import { panelCorePath, type TaskReply } from '@agentdeck/contracts/core/panel-api';
import { apiClient } from '@shared/api/client';
import { coreGet, coreUrl, followCoreEvents } from '@entities/CoreTask';
import { agentsQuery, liveTaskIds } from '../model/coreAgents';
import type { AgentFilters } from '../model/coreAgents.types';

/**
 * Агенты чата — у ядра (этап 11, W3-17): список узлов всех задач разговора, узел подробно со
 * страницами вызовов, поток изменений идущих задач и выгрузка. Транскрипты CLI панель для этого
 * не читает.
 */
export const agentTreeKeys = {
  all: ['core-agents'] as const,
  chat: (chatId: string) => ['core-agents', 'chat', chatId] as const,
  list: (chatId: string, filters: AgentFilters) =>
    ['core-agents', 'chat', chatId, 'list', filters] as const,
  node: (taskId: string, nodeId: string) => ['core-agents', 'node', taskId, nodeId] as const,
  task: (taskId: string) => ['core-agents', 'task', taskId] as const,
};

/**
 * Пока кто-то идёт или идёт сам разговор, список перечитывается с этим шагом: поток задачи
 * приносит изменения сразу, но новую задачу чата (следующий ход, возобновление) видно только
 * в списке.
 */
const LIVE_POLL_MS = 10_000;
/** Изменения потока сливаются: десяток вызовов подряд — одно перечитывание, не десять. */
const STREAM_DEBOUNCE_MS = 300;
/** Идущий узел подробно перечитывается с этим шагом. */
const NODE_POLL_MS = 4_000;

/** Узлы всех задач чата (или группы — `filters.groupId`) по фильтрам ядра. */
export function useCoreAgents(
  chatId: string | undefined,
  filters: AgentFilters,
  isRunning: boolean,
) {
  return useQuery({
    queryKey: agentTreeKeys.list(chatId ?? '', filters),
    queryFn: () =>
      coreGet<AgentsListReply>('/agents', undefined, agentsQuery(chatId ?? '', filters)),
    enabled: Boolean(chatId),
    staleTime: 3_000,
    refetchInterval: (query) =>
      isRunning || query.state.data?.nodes.some((node) => node.status === 'running')
        ? LIVE_POLL_MS
        : false,
    meta: { silentError: true },
  });
}

/**
 * Поток дерева каждой идущей задачи чата: кадр узла — перечитать список и открытый узел (с
 * паузой, чтобы серия кадров дала одно чтение). Кадр `end` — задача кончилась, поток закрыт ядром:
 * подписка гасится, иначе клиент переподключался бы к законченной задаче.
 */
export function useAgentsLive(chatId: string | undefined, taskIds: readonly string[]): void {
  const client = useQueryClient();
  const key = taskIds.join(',');
  useEffect(() => {
    if (!chatId || key === '') return undefined;
    const controllers: AbortController[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void client.invalidateQueries({ queryKey: agentTreeKeys.chat(chatId) });
        void client.invalidateQueries({ queryKey: ['core-agents', 'node'] });
      }, STREAM_DEBOUNCE_MS);
    };
    for (const taskId of key.split(',')) {
      const controller = new AbortController();
      controllers.push(controller);
      void followCoreEvents({
        url: panelCorePath('/tasks/:id/agents/stream', { id: taskId }),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.event === 'snapshot') return;
          refresh();
          if (event.event === 'end') controller.abort();
        },
      }).catch(() => undefined);
    }
    return () => {
      clearTimeout(timer);
      for (const controller of controllers) controller.abort();
    };
  }, [chatId, key, client]);
}

/** Поток только по идущим задачам списка — законченная задача кадров уже не пришлёт. */
export function useLiveTaskIds(nodes: AgentsListReply['nodes'] | undefined): string[] {
  return useMemo(() => liveTaskIds(nodes ?? []), [nodes]);
}

/** Узел подробно: вызовы постранично (`next` — курсор следующей страницы ядра). */
export function useAgentNode(taskId: string | undefined, nodeId: string | undefined) {
  return useInfiniteQuery({
    queryKey: agentTreeKeys.node(taskId ?? '', nodeId ?? ''),
    queryFn: ({ pageParam }) =>
      coreGet<AgentNodeDetail>(
        '/tasks/:id/agents/:nodeId',
        { id: taskId ?? '', nodeId: nodeId ?? '' },
        pageParam ? { page: pageParam } : undefined,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.toolCalls.next,
    enabled: Boolean(taskId && nodeId),
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.node.status === 'running' ? NODE_POLL_MS : false,
    meta: { silentError: true },
  });
}

/**
 * Группы задач чата — варианты фильтра «Группа»: у задачи, запущенной из пункта группы панели,
 * вид ядра несёт `groupId`. Задач у чата единицы — по запросу на каждую.
 */
export function useChatGroups(taskIds: readonly string[], enabled: boolean): string[] {
  const results = useQueries({
    queries: taskIds.map((taskId) => ({
      queryKey: agentTreeKeys.task(taskId),
      queryFn: () => coreGet<TaskReply>('/tasks/:id', { id: taskId }),
      enabled,
      staleTime: 60_000,
      meta: { silentError: true },
    })),
  });
  const groups = new Set<string>();
  for (const result of results) {
    const groupId = result.data?.view.groupId;
    if (groupId) groups.add(groupId);
  }
  return [...groups].sort();
}

/**
 * Выгрузка: замаскированные строки журнала об агентах каждой задачи чата одним файлом jsonl —
 * задачи по очереди, как в списке.
 */
export async function exportChatAgents(chatId: string, taskIds: readonly string[]): Promise<void> {
  const parts: string[] = [];
  for (const taskId of taskIds) {
    const { data } = await apiClient.get<string>(
      coreUrl('/tasks/:id/agents/export', { id: taskId }),
      { responseType: 'text', transformResponse: (raw: unknown) => raw },
    );
    if (data) parts.push(data.endsWith('\n') ? data : `${data}\n`);
  }
  const blob = new Blob(parts, { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `agents-${chatId}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
}
