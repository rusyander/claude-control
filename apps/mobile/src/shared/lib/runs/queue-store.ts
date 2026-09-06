import AsyncStorage from '@react-native-async-storage/async-storage';
import { QUEUE_MAX_AGE_MS } from './constants';
import { runs } from './store';
import type { QueuedMessage } from './types';

const PREFIX = 'claude-control:chat-queue:';

interface StoredQueue {
  savedAt: number;
  items: QueuedMessage[];
}

/**
 * Очередь дописанного — в AsyncStorage, как черновик.
 *
 * До этого она жила только в памяти: система выгрузила приложение из фона,
 * человек его перезапустил — и написанное пропало бесследно, ни в ленте, ни в
 * транскрипте. Хранилище обёрнуто в try/catch: переполнение или отказ
 * хранилища не должны ронять чат — очередь тогда остаётся памятью, как была.
 *
 * Вложения складываем как есть: не поместились — запись просто не состоится.
 * Молча ронять файлы, оставляя текст, значило бы отправить агенту не то.
 */
async function read(id: string): Promise<QueuedMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + id);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredQueue;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return [];
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > QUEUE_MAX_AGE_MS) {
      await remove(id);
      return [];
    }
    return parsed.items;
  } catch {
    return [];
  }
}

async function remove(id: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + id);
  } catch {
    // См. комментарий выше: хранилище может быть недоступно.
  }
}

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

/** Прочитать сохранённую очередь по любому из написаний разговора. */
export async function loadQueue(...ids: (string | undefined)[]): Promise<QueuedMessage[]> {
  for (const id of ids) {
    if (!id) continue;
    const items = await read(id);
    if (items.length > 0) return items;
  }
  return [];
}

/** Забыть сохранённую очередь разговора (ушла, отменена или протухла). */
export async function forgetQueue(...ids: (string | undefined)[]): Promise<void> {
  for (const id of ids) if (id) await remove(id);
}

/**
 * Записать очередь прогона такой, какая она сейчас в сторе. Основным
 * написанием берём `sessionId`: временный `new-…` после перезапуска не значит
 * ничего, и сохранённая под ним очередь стала бы недостижимой.
 */
export function persistQueue(key: string): Promise<void> {
  const run = runs.get(key);
  return saveQueue([run?.sessionId, key], run?.queued ?? []);
}
