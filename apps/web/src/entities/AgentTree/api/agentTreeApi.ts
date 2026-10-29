import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { chatKeys } from '@entities/Chat';
import type { AgentExtensions, AgentStopResult, AgentTranscript } from '@agentdeck/contracts';
import { MAIN_AGENT_ID, type AgentHistory } from '@agentdeck/contracts/agent-history';

/** Окно шагов: последние `limit` (`start` нет) или `limit` с номера шага `start`. */
export interface StepWindow {
  limit: number;
  start?: number;
}

export const agentTreeKeys = {
  transcript: (chatId: string, agentId: string, window: StepWindow) =>
    ['chats', chatId, 'agents', agentId, window.limit, window.start ?? 'tail'] as const,
  extensions: (chatId: string, agentId: string | undefined) =>
    ['chats', chatId, 'extensions', agentId ?? 'main'] as const,
  history: (chatId: string) => ['chats', chatId, 'agent-history'] as const,
};

/**
 * Пока кто-то работает (разговор идёт или в ответе есть работающие), историю
 * перечитываем с шагом опроса прогресса: «сейчас работают» рядом с кнопкой —
 * живое число, а не снимок до F5. Сервер отвечает условно (ETag) — неизменная
 * история приходит 304 без тела.
 */
const HISTORY_LIVE_POLL_MS = 5000;

/**
 * Шаг опроса истории: разговор идёт или в последнем ответе кто-то работает
 * (фоновый субагент живёт и между ходами) — опрашиваем; иначе молчим.
 */
export function historyPollMs(
  isRunning: boolean,
  history: AgentHistory | undefined,
): number | false {
  const live = Boolean(history && history.live.agents + history.live.subagents > 0);
  return isRunning || live ? HISTORY_LIVE_POLL_MS : false;
}

/**
 * История агентов по всем сессиям разговора (у группы — все её звенья).
 */
export function useAgentHistory(chatId: string | undefined, isRunning: boolean) {
  return useQuery({
    queryKey: agentTreeKeys.history(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<AgentHistory>(
        `/chat/${encodeURIComponent(chatId ?? '')}/agent-history`,
      );
      return data;
    },
    enabled: Boolean(chatId),
    staleTime: 4000,
    refetchInterval: (query) => historyPollMs(isRunning, query.state.data),
    meta: { silentError: true },
  });
}

/** Идущего субагента перечитываем, как и прогресс идущего прогона. */
const RUNNING_POLL_MS = 4000;

/**
 * Ход агента окном шагов: субагента — по его транскрипту, главного агента
 * сессии (`MAIN_AGENT_ID`) — по главному транскрипту, прочитанному целиком.
 * Только чтение: файлы пишет сам CLI, панель в них не пишет.
 */
export function useAgentTranscript(
  chatId: string | undefined,
  agentId: string | undefined,
  window: StepWindow,
  isRunning: boolean,
) {
  return useQuery({
    queryKey: agentTreeKeys.transcript(chatId ?? '', agentId ?? '', window),
    queryFn: async () => {
      const chat = encodeURIComponent(chatId ?? '');
      const url =
        agentId === MAIN_AGENT_ID
          ? `/chat/${chat}/main-agent`
          : `/chat/${chat}/agents/${encodeURIComponent(agentId ?? '')}`;
      const { data } = await apiClient.get<AgentTranscript>(url, {
        params: window.start === undefined ? { limit: window.limit } : window,
      });
      return data;
    },
    enabled: Boolean(chatId && agentId),
    // Шаги старше окна не меняются: при «Показать раньше» прежнее окно — заглушка
    // до ответа, а не пустая панель.
    placeholderData: (previous) => previous,
    refetchInterval: isRunning ? RUNNING_POLL_MS : false,
    meta: { silentError: true },
  });
}

/**
 * Скиллы, хуки и MCP агента по времени: главного (`agentId` нет) или субагента.
 * Читается только при открытом окне; у идущего агента — с тем же шагом опроса.
 */
export function useAgentExtensions(
  chatId: string | undefined,
  agentId: string | undefined,
  enabled: boolean,
  isRunning: boolean,
) {
  return useQuery({
    queryKey: agentTreeKeys.extensions(chatId ?? '', agentId),
    queryFn: async () => {
      const chat = encodeURIComponent(chatId ?? '');
      const url = agentId
        ? `/chat/${chat}/agents/${encodeURIComponent(agentId)}/extensions`
        : `/chat/${chat}/extensions`;
      const { data } = await apiClient.get<AgentExtensions>(url);
      return data;
    },
    enabled: enabled && Boolean(chatId),
    refetchInterval: enabled && isRunning ? RUNNING_POLL_MS : false,
    meta: { silentError: true },
  });
}

/**
 * «Остановить» субагента: `stop_task` живому процессу CLI. Ответ `requested` —
 * CLI принял запрос, а снят ли агент, скажет его итог в транскрипте, — поэтому
 * сразу перечитываем прогресс разговора.
 */
export function useStopAgent(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data } = await apiClient.post<AgentStopResult>(
        `/chat/${encodeURIComponent(chatId)}/agents/${encodeURIComponent(agentId)}/stop`,
      );
      return data;
    },
    // Итог пишет сам узел строкой рядом с кнопкой — общий тост дал бы второй.
    meta: { silentError: true },
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.progress(chatId) }),
  });
}
