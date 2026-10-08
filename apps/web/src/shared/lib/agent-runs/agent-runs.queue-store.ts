import type { QueuedMessage } from './agent-runs.types';
import { PREFIX } from './agent-runs.queue-store.constants';
import { remove } from './remove';
import type { StoredQueue } from './agent-runs.queue-store.types';

/**
 * Сохранить очередь разговора. Первый непустой id — основной (обычно
 * `sessionId`, он переживает перезагрузку); остальные написания того же
 * разговора стираем, чтобы одна очередь не читалась дважды.
 */
export function saveQueue(ids: (string | undefined)[], items: QueuedMessage[]): void {
  const known = ids.filter((id): id is string => Boolean(id));
  const primary = known[0];
  if (!primary) return;
  for (const id of known.slice(1)) remove(id);
  if (items.length === 0) {
    remove(primary);
    return;
  }
  try {
    const payload: StoredQueue = { savedAt: Date.now(), items };
    localStorage.setItem(PREFIX + primary, JSON.stringify(payload));
  } catch {
    // Не поместилось — очередь остаётся в памяти вкладки.
  }
}
