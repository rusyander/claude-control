import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueuedMessage } from './types';
import { PREFIX } from './queue-store.constants';
import { remove } from './remove';
import type { StoredQueue } from './queue-store.types';

/**
 * Сохранить очередь разговора. Первый непустой id — основной (обычно
 * `sessionId`: он переживает перезапуск); остальные написания того же
 * разговора стираем, чтобы одна очередь не читалась дважды.
 */
export async function saveQueue(
  ids: (string | undefined)[],
  items: QueuedMessage[],
): Promise<void> {
  const known = ids.filter((id): id is string => Boolean(id));
  const primary = known[0];
  if (!primary) return;
  for (const id of known.slice(1)) await remove(id);
  if (items.length === 0) {
    await remove(primary);
    return;
  }
  try {
    const payload: StoredQueue = { savedAt: Date.now(), items };
    await AsyncStorage.setItem(PREFIX + primary, JSON.stringify(payload));
  } catch {
    // Не поместилось — очередь остаётся в памяти приложения.
  }
}
