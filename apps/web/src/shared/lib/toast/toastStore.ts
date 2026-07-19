import type { ToastItem, ToastOptions, ToastTone } from './toast.types';

/**
 * Стор тостов — модуль-синглтон, а не React-контекст. Так уведомление можно
 * показать откуда угодно: не только из компонента, но и из глобального
 * обработчика мутаций (`MutationCache`), где хуки недоступны. Подписку на
 * список читает `useToasts` через `useSyncExternalStore`.
 */

/** Сколько тост держится по умолчанию — три секунды, как договорились. */
const DEFAULT_DURATION = 3000;

/**
 * Максимум одновременно видимых тостов. Они и так уходят через 3 c, но при
 * буре событий стопка не должна залезать на весь экран — старейший вытесняется.
 */
const MAX_VISIBLE = 5;

let items: ToastItem[] = [];
let sequence = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastItem[] {
  return items;
}

export function dismissToast(id: string): void {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

/** Убрать все тосты разом — например, при переходе на другую страницу. */
export function clearToasts(): void {
  if (items.length === 0) return;
  items = [];
  emit();
}

function push(tone: ToastTone, message: string, options: ToastOptions = {}): string {
  const trimmed = message?.trim();
  // Пустой текст не показываем: пустой тост только сбивает с толку.
  if (!trimmed) return '';

  sequence += 1;
  const id = `toast-${sequence}`;
  const item: ToastItem = {
    id,
    tone,
    message: trimmed,
    title: options.title,
    duration: options.duration ?? DEFAULT_DURATION,
    onClick: options.onClick,
  };

  // Старейший вытесняется, если стопка переросла лимит.
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  return id;
}

/**
 * Императивный API показа тостов. Импортируется где угодно:
 * `toast.success(t('toasts.saved'))`, `toast.error(toErrorMessage(e))`.
 */
export const toast = {
  success: (message: string, options?: ToastOptions) => push('success', message, options),
  error: (message: string, options?: ToastOptions) => push('error', message, options),
  warning: (message: string, options?: ToastOptions) => push('warning', message, options),
  info: (message: string, options?: ToastOptions) => push('info', message, options),
  dismiss: dismissToast,
  clear: clearToasts,
};
