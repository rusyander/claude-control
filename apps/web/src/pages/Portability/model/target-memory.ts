import { TRANSFER_TARGET_KEY, LEGACY_TRANSFER_TARGET_KEY } from './target-memory.constants';

/**
 * Последняя выбранная цель переноса или `''`.
 *
 * Без памяти цель терялась при каждой перезагрузке и после записи переноса
 * (страница перечитывается), и три вкладки из пяти встречали человека пустыми.
 * Недоступное хранилище (приватное окно, запрет сайта) — не ошибка: цель
 * просто не вспомнится.
 */
export function readRememberedTarget(): string {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return '';
    const current = storage.getItem(TRANSFER_TARGET_KEY);
    if (current !== null) return current;
    const legacy = storage.getItem(LEGACY_TRANSFER_TARGET_KEY);
    if (legacy === null) return '';
    storage.setItem(TRANSFER_TARGET_KEY, legacy);
    storage.removeItem(LEGACY_TRANSFER_TARGET_KEY);
    return legacy;
  } catch {
    return '';
  }
}
