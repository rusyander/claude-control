import { pageTabStorageKey } from './pageTabStorageKey';

/**
 * Хранилище браузера бывает недоступно (приватное окно, запрет сайта): тогда
 * вкладка просто не запоминается, страница работает как без памяти.
 */
export function readRememberedPageTab(page: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(pageTabStorageKey(page)) ?? undefined;
  } catch {
    return undefined;
  }
}
