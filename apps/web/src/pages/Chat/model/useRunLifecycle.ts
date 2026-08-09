import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '@claude-control/contracts';
import { agentRuns, type RunStatus } from '@shared/lib/agent-runs';
import { chatKeys } from '@entities/Chat';

/** Как часто спрашивать сервер о чужих прогонах. Ответ — из памяти, не с диска. */
const ADOPT_INTERVAL_MS = 5000;

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

  // Подхватываем прогоны, что идут на сервере, но не заводились здесь.
  //
  // Раз при входе этого мало: ход начинают и с телефона, и из терминала, и из
  // соседнего окна панели, причём ПОСЛЕ того, как страница открылась. Своего
  // события у чужого хода нет — сервер о нём рассказывает только тому, кто
  // спросил, — поэтому спрашиваем. Пока этого не было, чужой разговор не
  // показывал ни живого вывода, ни точки на табе, а его завершение не освежало
  // список чатов: новый разговор появлялся там лишь после перезагрузки.
  // Ответ — реестр в памяти сервера, поэтому такт частый и дешёвый.
  useEffect(() => {
    void agentRuns.resumeActive();
    const timer = window.setInterval(() => {
      // Скрытая вкладка ничего не показывает — и спрашивать ей незачем; при
      // возвращении такт всё равно наступит через несколько секунд.
      if (document.visibilityState === 'visible') void agentRuns.resumeActive();
    }, ADOPT_INTERVAL_MS);
    return () => window.clearInterval(timer);
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
