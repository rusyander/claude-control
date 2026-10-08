import { TRANSFER_TARGET_KEY, LEGACY_TRANSFER_TARGET_KEY } from './target-memory.constants';

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
