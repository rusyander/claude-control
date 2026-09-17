/**
 * Ключи браузерного хранилища под прежним именем продукта.
 *
 * До 17.09.2026 панель называлась иначе, и всё, что она помнит в
 * браузере (вкладки проектов, черновики, свёрнутая боковая панель, очередь
 * сообщений, шаг онбординга), лежит под ключами `<прежнее имя>:…`. Без переноса
 * человек после обновления увидел бы пустые вкладки и потерял бы черновики.
 *
 * Перенос однократный: значение уходит под `agentdeck:…`, прежний ключ
 * удаляется. Удалять обязательно — иначе очищенный черновик воскресал бы из
 * старого ключа при каждой загрузке. Уже записанный новый ключ не затирается.
 */

/** Собрано из частей: история репозитория переписывается заменой слова. */
export const LEGACY_PREFIX = `${['claude', 'control'].join('-')}:`;
const PREFIX = 'agentdeck:';

/** Сколько ключей перенесено. */
export function migrateLegacyStorageKeys(storage: Storage | undefined): number {
  if (!storage) return 0;
  let moved = 0;
  try {
    const legacy: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_PREFIX)) legacy.push(key);
    }
    for (const key of legacy) {
      const value = storage.getItem(key);
      const fresh = PREFIX + key.slice(LEGACY_PREFIX.length);
      if (value !== null && storage.getItem(fresh) === null) {
        storage.setItem(fresh, value);
        moved += 1;
      }
      storage.removeItem(key);
    }
  } catch {
    // Хранилище недоступно или переполнено — панель работает и без памяти браузера.
  }
  return moved;
}

function safeStorage(pick: () => Storage): Storage | undefined {
  try {
    return pick();
  } catch {
    return undefined;
  }
}

/** Оба хранилища окна; вызывается до первого чтения любым модулем. */
export function migrateBrowserStorage(): void {
  if (typeof window === 'undefined') return;
  migrateLegacyStorageKeys(safeStorage(() => window.localStorage));
  migrateLegacyStorageKeys(safeStorage(() => window.sessionStorage));
}
