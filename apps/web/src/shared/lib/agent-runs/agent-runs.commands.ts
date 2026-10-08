import { nextQueueSeq } from './agent-runs.state';
import type { QueuedMessage } from './agent-runs.types';
import { persistQueue } from './persistQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { setRun } from './setRun';
import { findKey } from './findKey';

/**
 * Команды стора поверх жизненного цикла: очередь дописанного, остановка,
 * подхват идущих прогонов, права и подключение колбэков страницы.
 */

/**
 * Дописать сообщение в занятый прогон. Кнопка отправки из-за этого больше не
 * блокируется: задача может идти часами, и всё это время «сказать ещё одно»
 * было нельзя — оставалось либо ждать, либо убивать агента и начинать заново.
 *
 * Возвращает id места в очереди — по нему сообщение можно отменить, пока оно
 * не ушло.
 */
export function enqueue(id: string, message: Omit<QueuedMessage, 'id'>): string {
  const key = findKey(id) ?? id;
  const queuedId = `queued-${Date.now()}-${nextQueueSeq()}`;
  const run = runs.get(key);
  setRun(key, {
    id: run?.id || key,
    queued: [...(run?.queued ?? []), { ...message, id: queuedId }],
  });
  persistQueue(key);
  emit();
  return queuedId;
}
