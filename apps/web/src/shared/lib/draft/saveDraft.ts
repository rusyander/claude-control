import { PREFIX } from './draft-storage.constants';

/** Сохранить черновик; пустое значение стирает ключ. */
export function saveDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Хранилище недоступно — тихо пропускаем: потеря черновика не критична.
  }
}
