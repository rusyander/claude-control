import { useMemo } from 'react';
import { useChatStatuses, useProjectStatuses, type RunStatus } from '@shared/lib/agent-runs';
import {
  mergeAwaitingProjectStatuses,
  mergeAwaitingStatuses,
  useAwaitingChats,
} from '@entities/Chat';

export interface ChatDots {
  /** Статус по разговору: в одном проекте агентов несколько, и зовёт кто-то один. */
  chatStatuses: Map<string, RunStatus>;
  /** Свод по проекту — точка на его вкладке. */
  projectStatuses: Map<string, RunStatus>;
}

/**
 * Цветные точки в списке чатов и на вкладках проектов.
 *
 * Двух источников здесь не избежать: живые прогоны знает стор, но разговор мог
 * встать на вопросе задолго до того, как открыли панель, или идти вовсе мимо
 * неё — из терминала, с телефона, из расширения редактора. Такие видны только
 * по транскрипту, и точку им ставит тот же механизм, что и живым.
 */
export function useChatDots(): ChatDots {
  const liveProjectStatuses = useProjectStatuses();
  const liveChatStatuses = useChatStatuses();
  const awaitingChats = useAwaitingChats();

  const chatStatuses = useMemo(
    () => mergeAwaitingStatuses(liveChatStatuses, awaitingChats),
    [liveChatStatuses, awaitingChats],
  );
  const projectStatuses = useMemo(
    () => mergeAwaitingProjectStatuses(liveProjectStatuses, awaitingChats),
    [liveProjectStatuses, awaitingChats],
  );

  return { chatStatuses, projectStatuses };
}
