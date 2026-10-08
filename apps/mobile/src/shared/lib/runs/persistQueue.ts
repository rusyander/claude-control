import { saveQueue } from './queue-store';
import { runs } from './store';

/**
 * Записать очередь прогона такой, какая она сейчас в сторе. Основным
 * написанием берём `sessionId`: временный `new-…` после перезапуска не значит
 * ничего, и сохранённая под ним очередь стала бы недостижимой.
 */
export function persistQueue(key: string): Promise<void> {
  const run = runs.get(key);
  return saveQueue([run?.sessionId, key], run?.queued ?? []);
}
