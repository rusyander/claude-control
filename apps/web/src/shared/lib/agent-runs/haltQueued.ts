import { stoppedByUser, cancelAutoRetry } from './agent-runs.retry';
import { persistQueue } from './persistQueue';
import { emit } from './emit';
import { runs } from './agent-runs.state.constants';
import { findKey } from './findKey';

/**
 * Прогоны остановил сервер по решению человека («Отменить план»): дописанное
 * в их очередь не уходит, а сбой конца хода не перезапускается — как после
 * «Остановить». Сам прогон сервер уже снял, звать `/stop` незачем (F3).
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
    if (run && run.queued.length > 0) {
      runs.set(key, { ...run, queued: [] });
      persistQueue(key);
      changed = true;
    }
  }
  if (changed) emit();
}
