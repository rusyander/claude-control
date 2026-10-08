import { saveQueue } from './agent-runs.queue-store';
import { runs } from './agent-runs.state.constants';

/**
 * Записать очередь прогона такой, какая она сейчас в сторе.
 *
 * Основным написанием берём `sessionId`: временный `new-…` живёт до первого
 * события потока и после перезагрузки не значит ничего, а сохранённая под ним
 * очередь стала бы недостижимой.
 */
export function persistQueue(key: string): void {
  const run = runs.get(key);
  saveQueue([run?.sessionId, key], run?.queued ?? []);
}
