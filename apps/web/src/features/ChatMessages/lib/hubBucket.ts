import type { ChildStageGroup } from '../ui/ChildStages.types';
import type { HubBucket } from './hubSummary.types';

/** Код закрытия группы отменой плана (`split-conveyor` → `cancel`). */
export const PLAN_CANCELLED = 'split-group-plan-cancelled';

export function hubBucket(group: ChildStageGroup): HubBucket {
  // Подготовка копии — уже работа группы: место она держит, прогон вот-вот
  // пойдёт; в «очереди» её не было бы видно среди занятых мест.
  if (group.isRunning || group.pending === 'setup') return 'running';
  // Закрыта отменой плана — решение человека, а не сбой: рядом со строкой
  // «остановлена: план отменён человеком» фишка писала «упала» (живой прогон 26.09, O3).
  if (group.errorCode === PLAN_CANCELLED) return 'cancelled';
  if (group.pending === 'failed' || group.status === 'failed') return 'failed';
  if (
    group.pending === 'held' ||
    // Оборвана до своего чата: сама не продолжится — «Завести заново» или
    // «Убрать» решает человек.
    group.pending === 'interrupted' ||
    group.waitingFor === 'question' ||
    group.waitingFor === 'decision'
  ) {
    return 'ask';
  }
  // Принятая человеком — своя корзина (TK-accepted): «готово» говорит, что
  // панель довела группу, «принято» — что человек её посмотрел.
  if (group.status === 'done' && group.acceptance?.acceptedAt) return 'accepted';
  if (group.status === 'done') return 'done';
  // Пауза человека — не очередь: сама она не стартует (как и пауза с чатом).
  if (group.pending === 'paused') return 'idle';
  if (group.pending) return 'queued';
  // Чат есть, прогона нет, итога нет: ждёт фон, повтор, доставку или просто
  // остановлен. Это не «готово» и не «ждёт вас» — корзина своя.
  return 'idle';
}
