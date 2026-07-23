import type { ToastHistoryEntry, ToastItem } from './toast.types';

/**
 * Журнал уведомлений — модуль-синглтон рядом со стором тостов. Показ тостов он
 * не меняет: `toastStore` просто дублирует сюда каждое появившееся уведомление,
 * а журнал хранит последние из них с временем и считает непрочитанные (те, что
 * пришли после последнего открытия колокольчика).
 *
 * Как и стор тостов, живёт вне React и читается через `useSyncExternalStore`.
 */

/** Сколько уведомлений держим в журнале — кольцо на N, старейшие вытесняются. */
const MAX_HISTORY = 30;

let entries: ToastHistoryEntry[] = [];
let unread = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToastHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastHistory(): ToastHistoryEntry[] {
  return entries;
}

export function getUnreadCount(): number {
  return unread;
}

/**
 * Занести показанный тост в журнал. Новейшие — в начале списка, чтобы колокольчик
 * показывал их сверху. За пределом кольца старейшие отбрасываются.
 */
export function recordToast(toast: ToastItem): void {
  const entry: ToastHistoryEntry = {
    id: toast.id,
    tone: toast.tone,
    message: toast.message,
    title: toast.title,
    at: Date.now(),
  };
  entries = [entry, ...entries].slice(0, MAX_HISTORY);
  unread += 1;
  emit();
}

/** Пометить все прочитанными — вызывается при открытии журнала. */
export function markToastsRead(): void {
  if (unread === 0) return;
  unread = 0;
  emit();
}

/** Очистить журнал целиком. */
export function clearToastHistory(): void {
  if (entries.length === 0 && unread === 0) return;
  entries = [];
  unread = 0;
  emit();
}
