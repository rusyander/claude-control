import { useSyncExternalStore } from 'react';
import { subscribeRuns, getAnsweredQuestions } from './agentRunsStore';

/**
 * Вопросы, на которые уже ответили. Память общая: карточка переживает и уход на
 * другую вкладку, и перезагрузку — иначе тот же вопрос выглядит неотвеченным, а
 * второй ответ стоит ещё одного хода агента.
 */
export function useAnsweredQuestions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeRuns, getAnsweredQuestions, getAnsweredQuestions);
}
