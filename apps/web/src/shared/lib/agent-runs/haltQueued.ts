import { stoppedByUser, cancelAutoRetry } from './agent-runs.retry';
import { rebuildStatuses } from './agent-runs.statuses';
import { persistQueue } from './persistQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/**
 * Прогоны остановил сервер по решению человека («Отменить план»): дописанное
 * в их очередь не уходит, а сбой конца хода не перезапускается — как после
 * «Остановить». Сам прогон сервер уже снял, звать `/stop` незачем (F3).
 *
 * Вопрос группы тоже снят: ответа на него больше никто не ждёт, и законченный
 * ход вопросом держал бы «агент ждёт ответа» на вкладке проекта, пока чат не
 * откроют (живая приёмка 09.10). У идущего хода метка снимается заранее —
 * его конец по остановке застанет её уже снятой.
 */
export function haltQueued(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) {
    const key = findKey(id) ?? id;
    stoppedByUser.add(key);
    stoppedByUser.add(id);
    cancelAutoRetry(key);
    cancelAutoRetry(id);
    const run = runs.get(key);
    if (!run) continue;
    if (run.queued.length > 0) {
      runs.set(key, { ...run, queued: [] });
      persistQueue(key);
      changed = true;
    }
    if (run.askedQuestion || run.status === 'waiting') {
      const current = runs.get(key) ?? run;
      runs.set(key, {
        ...current,
        askedQuestion: false,
        ...(current.status === 'waiting' ? { status: 'idle' as const } : {}),
      });
      changed = true;
    }
  }
  if (!changed) return;
  rebuildStatuses();
  emit();
}
