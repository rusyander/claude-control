import { useSyncExternalStore } from 'react';
import type { ToastItem } from './toast.types';
import { dismissToast, getToasts, subscribeToasts } from './toastStore';

/**
 * Подписка на список тостов для контейнера `Toaster`. Стор живёт вне React,
 * поэтому читаем его через `useSyncExternalStore` — без лишних перерисовок и
 * без рассинхрона при параллельных обновлениях.
 */
export function useToasts(): { toasts: ToastItem[]; dismiss: (id: string) => void } {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return { toasts, dismiss: dismissToast };
}
