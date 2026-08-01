import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@claude-control/contracts';
import { agentRuns, type RunStatus } from '@shared/lib/agent-runs';
import { chatKeys } from '@entities/Chat';

export interface RunLifecycleInput {
  /** Разговор, открытый прямо сейчас: его прогон стор не считает фоновым. */
  chatId?: string;
  isRunning: boolean;
  runText: string;
  runStatus: RunStatus;
  /** Перечитать переписку открытого разговора. */
  refresh: (id?: string) => void;
  /** Момент последнего успешного чтения истории и сама история. */
  messagesUpdatedAt: number;
  messagesData?: { messages: ChatMessage[] };
}

/**
 * Стыковка стора прогонов с историей Claude Code: подхват прогонов, живших до
 * перезагрузки страницы, перечитывание переписки после хода агента и уборка
 * потокового дубля, когда тот же ответ уже пришёл из транскрипта.
 */
export function useRunLifecycle({
  chatId,
  isRunning,
  runText,
  runStatus,
  refresh,
  messagesUpdatedAt,
  messagesData,
}: RunLifecycleInput): void {
  const queryClient = useQueryClient();
  const finishedAt = useRef(0);

  // Любой завершившийся прогон освежает список чатов: там появляются новые
  // разговоры и обновляются заголовки — в том числе у фоновых агентов.
  useEffect(() => {
    agentRuns.setOnFinished(() => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.list });
    });
    return () => agentRuns.setOnFinished(undefined);
  }, [queryClient]);

  // После перезагрузки страницы подхватываем прогоны, что ещё идут на сервере, —
  // их живой вывод и цветные точки на табах возвращаются сами, без повторной
  // отправки. Один раз при входе на страницу чата.
  useEffect(() => {
    void agentRuns.resumeActive();
  }, []);

  // Открытый чат — чтобы стор не уведомлял о его собственном завершении.
  useEffect(() => {
    agentRuns.setActiveId(chatId);
  }, [chatId]);

  // Завершение прогона активного чата — перечитываем его переписку из истории.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      finishedAt.current = Date.now();
      window.setTimeout(() => refresh(), 500);
    }
    wasRunningRef.current = isRunning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  // Ответ живёт в двух местах: пока печатается — в потоке, после записи в
  // транскрипт — в истории. Как только история перечитана, потоковый дубль
  // прячем: у обычного ответа прогон убираем совсем, а у «вопроса»/ошибки
  // оставляем — чтобы жёлтая/красная точка не пропала.
  useEffect(() => {
    if (isRunning || !runText) return;
    if (!finishedAt.current || messagesUpdatedAt <= finishedAt.current) return;
    if (!messagesData?.messages.some((message) => message.role === 'assistant')) return;

    if (runStatus === 'idle') agentRuns.clear(chatId ?? '');
    else agentRuns.quiet(chatId ?? '');
  }, [messagesUpdatedAt, messagesData, isRunning, runText, runStatus, chatId]);
}
