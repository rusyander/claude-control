/**
 * Ключ памяти браузера: цель переноса помнит этот зритель, а не сервер. Имя —
 * по общему образцу `agentdeck:<что>`, как у остальных ключей панели.
 */
export const TRANSFER_TARGET_KEY = 'agentdeck:portability-target';

/**
 * Прежнее имя ключа (с точками — единственный такой в панели). Читается один
 * раз и переносится под новое: выбор, сделанный до переименования, не теряется.
 */
export const LEGACY_TRANSFER_TARGET_KEY = 'agentdeck.portability.target';

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

/** Запомнить выбор; «не выбрана» стирает запись, а не хранит пустую строку. */
export function rememberTarget(target: string): void {
  try {
    const storage = globalThis.localStorage;
    if (target) storage?.setItem(TRANSFER_TARGET_KEY, target);
    else storage?.removeItem(TRANSFER_TARGET_KEY);
    // Прежний ключ не должен воскресить стёртый выбор при следующем чтении.
    storage?.removeItem(LEGACY_TRANSFER_TARGET_KEY);
  } catch {
    // Хранилище недоступно — выбор живёт до перезагрузки, как раньше.
  }
}
