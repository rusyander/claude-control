import AsyncStorage from '@react-native-async-storage/async-storage';
import { PREFIX } from './queue-store.constants';
import type { QueuedMessage } from './types';
import type { StoredQueue } from './queue-store.types';
import { QUEUE_MAX_AGE_MS } from './constants';
import { remove } from './remove';

/** Ключ до переименования продукта: очередь переносится при первом чтении. */
/** Прежнее имя панели собрано из частей: история репозитория переписывается заменой слова. */
export const LEGACY_PREFIX = `${['claude', 'control'].join('-')}:chat-queue:`;

/** Очередь под прежним ключом: переложить под новый и убрать старый — один раз. */
export async function adoptLegacy(id: string): Promise<string | null> {
  const raw = await AsyncStorage.getItem(LEGACY_PREFIX + id);
  if (!raw) return null;
  await AsyncStorage.setItem(PREFIX + id, raw);
  await AsyncStorage.removeItem(LEGACY_PREFIX + id);
  return raw;
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
export async function read(id: string): Promise<QueuedMessage[]> {
  try {
    const raw = (await AsyncStorage.getItem(PREFIX + id)) ?? (await adoptLegacy(id));
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

/** Прочитать сохранённую очередь по любому из написаний разговора. */
export async function loadQueue(...ids: (string | undefined)[]): Promise<QueuedMessage[]> {
  for (const id of ids) {
    if (!id) continue;
    const items = await read(id);
    if (items.length > 0) return items;
  }
  return [];
}
