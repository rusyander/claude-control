import {
  cancelQueued,
  clearRun,
  continueRun,
  decidePermission,
  enqueue,
  quietRun,
  restoreQueue,
  resumeActive,
  setActiveId,
  setAutoApprove,
  setOnBackgroundEvent,
  setOnFinished,
  setOnHandoff,
  setOnPermissionRequest,
  stopAll,
  stopRun,
} from './agent-runs.commands';
import { retryRun, startRun } from './agent-runs.lifecycle';
import { ensureSlotsWatch, setWatched } from './agent-runs.slots';
import { loadSpend } from './agent-runs.spend';

// Бюджет потоков действует с первой отправки, а не с первого опроса
// `/chat/active`: колбэк перераспределения ставится при сборке стора.
ensureSlotsWatch();

/**
 * Стор прогонов агента. В отличие от одного стрима на страницу, здесь их может
 * быть несколько сразу: агент продолжает работать в проекте, даже когда ты
 * переключился на другой таб. Каждый прогон — свой процесс на сервере и свой
 * поток событий; стор сводит их статусы по проектам для цветных точек на табах.
 *
 * Обновления иммутабельны (новый объект прогона на каждое событие) — этого ждёт
 * `useSyncExternalStore`. Снимок статусов по проектам кэшируется и пересчитывается
 * только при смене статуса или по таймеру зависания, а не на каждый токен текста,
 * иначе лента табов перерисовывалась бы на каждую букву ответа.
 *
 * Сам модуль — только сборка: состояние живёт в `agent-runs.state`, своды — в
 * `agent-runs.statuses`, поток и жизненный цикл — в `agent-runs.stream` и
 * `agent-runs.lifecycle`, остальные операции — в `agent-runs.commands`.
 */
export const agentRuns = {
  start: startRun,
  enqueue,
  cancelQueued,
  restoreQueue,
  resumeActive,
  loadSpend,
  stop: stopRun,
  retry: retryRun,
  continue: continueRun,
  stopAll,
  clear: clearRun,
  quiet: quietRun,
  setOnFinished,
  setActiveId,
  setWatched,
  setOnBackgroundEvent,
  setOnPermissionRequest,
  setOnHandoff,
  setAutoApprove,
  decidePermission,
};

export { EMPTY_RUN } from './agent-runs.constants';
export { getRun, subscribeRuns } from './agent-runs.state';
export { getActiveRuns, getChatStatuses, getProjectStatuses } from './agent-runs.statuses';
export { getTotalCost, getTotalTokens } from './agent-runs.spend';
export { shouldAutoRetry } from './agent-runs.retry';
export { getAnsweredQuestions, markQuestionAnswered } from './answered-questions';
export { parseSseFrame } from './agent-runs.sse';
export type {
  AgentRun,
  HandoffEvent,
  PendingPermission,
  QueuedMessage,
  SendOutcome,
  StartInput,
  StreamedTool,
} from './agent-runs.types';
