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

/**
 * Перенести черновик с одного ключа контекста на другой.
 *
 * Нужно, когда новый чат становится настоящим: его ключ меняется с `home`/
 * `project:…` на `chat:<id>`, а всё, что было записано под старым ключом (текст
 * поля, пер-чат оверрайд модели/усилия), иначе потерялось бы. Переносим только
 * непустое значение и стираем старый ключ, чтобы не плодить мусор. Пустой
 * источник или совпадающие ключи — no-op.
 */
export function migrateDraft(fromKey: string, toKey: string): void {
  if (fromKey === toKey) return;
  const value = loadDraft(fromKey);
  if (!value) return;
  saveDraft(toKey, value);
  clearDraft(fromKey);
}
