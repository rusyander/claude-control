import { PREFIX } from './draft-storage.constants';

/** Убрать черновик (например, после успешной отправки формы). */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // См. saveDraft.
  }
}
