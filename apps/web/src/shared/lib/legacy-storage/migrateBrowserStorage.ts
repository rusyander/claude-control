import { migrateLegacyStorageKeys } from './migrate';

export function safeStorage(pick: () => Storage): Storage | undefined {
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
