import { pageTabStorageKey } from './pageTabStorageKey';

export function rememberPageTab(page: string, tab: string): void {
  try {
    globalThis.localStorage?.setItem(pageTabStorageKey(page), tab);
  } catch {
    // Память вкладки — удобство, а не данные: без неё ничего не ломается.
  }
}
