import { STORAGE_KEY } from '../model/useTestedProject.constants';

export function readStored(): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Приватное окно и запрет на хранилище — не повод падать: просто нет памяти.
    return '';
  }
}
