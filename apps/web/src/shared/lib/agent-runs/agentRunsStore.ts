import { steer } from './agent-runs.steer';
import { enqueue } from './agent-runs.commands';
import { retryRun, startRun } from './agent-runs.lifecycle';
import { ensureSlotsWatch, setWatched } from './agent-runs.slots';
import { loadSpend } from './agent-runs.spend';
import { cancelQueued } from './cancelQueued';
import { haltQueued } from './haltQueued';
import { continueRun } from './continueRun';
import { clearRun } from './clearRun';
import { dismissError } from './dismissError';
import { quietRun } from './quietRun';
import { setOnFinished } from './setOnFinished';
import { setActiveId } from './setActiveId';
import { setOnBackgroundEvent } from './setOnBackgroundEvent';
import { setOnPermissionRequest } from './setOnPermissionRequest';
import { setOnHandoff } from './setOnHandoff';
import { setAutoApprove } from './setAutoApprove';
import { decideBranchGate } from './decideBranchGate';
import { decidePermission } from './decidePermission';
import { resumeActive } from './resumeActive';
import { restoreQueue } from './restoreQueue';
import { stopRun } from './stopRun';
import { stopAll } from './stopAll';

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
  steer,
  cancelQueued,
  restoreQueue,
  resumeActive,
  loadSpend,
  stop: stopRun,
  haltQueued,
  retry: retryRun,
  continue: continueRun,
  stopAll,
  clear: clearRun,
  dismissError,
  quiet: quietRun,
  setOnFinished,
  setActiveId,
  setWatched,
  setOnBackgroundEvent,
  setOnPermissionRequest,
  setOnHandoff,
  setAutoApprove,
  decidePermission,
  decideBranchGate,
};

export { EMPTY_RUN } from './agent-runs.constants';
export { getRun } from './getRun';
export { subscribeRuns } from './subscribeRuns';
export { getActiveRuns, getChatStatuses, getProjectStatuses } from './agent-runs.statuses';
export { getTotalCost, getTotalTokens } from './agent-runs.spend';
export { shouldAutoRetry } from './shouldAutoRetry';
export { getAnsweredQuestions, markQuestionAnswered } from './answered-questions';
export { parseSseFrame } from './parseSseFrame';
export type {
  AgentRun,
  HandoffEvent,
  PendingBranchGate,
  BranchGateChild,
  PendingPermission,
  QueuedMessage,
  SendOutcome,
  StartInput,
  StreamedTool,
} from './agent-runs.types';
