const PREFIX = 'claude-control:draft:';

/**
 * Черновики форм в localStorage: набранный, но не отправленный текст переживает
 * перезагрузку страницы. Пустой черновик не храним — убираем ключ, чтобы не
 * копить мусор. Доступ к хранилищу обёрнут в try/catch: в приватном режиме или
 * при переполнении localStorage кидается, а черновик — не та вещь, ради которой
 * стоит ронять форму.
 */

/** Прочитать черновик по ключу контекста (пусто, если его нет). */
export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

/** Сохранить черновик; пустое значение стирает ключ. */
export function saveDraft(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(PREFIX + key, value);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // Хранилище недоступно — тихо пропускаем: потеря черновика не критична.
  }
}

/** Убрать черновик (например, после успешной отправки формы). */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // См. saveDraft.
  }
}
