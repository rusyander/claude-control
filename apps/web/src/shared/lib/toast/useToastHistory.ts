import { useSyncExternalStore } from 'react';
import type { ToastHistoryEntry } from './toast.types';
import { getToastHistory, getUnreadCount, subscribeToastHistory } from './toastHistoryStore';

/**
 * Подписка на журнал уведомлений для колокольчика. Стор живёт вне React, поэтому
 * читаем его через `useSyncExternalStore` — и список, и счётчик непрочитанных
 * приходят из одного источника без рассинхрона.
 */
export function useToastHistory(): { entries: ToastHistoryEntry[]; unread: number } {
  const entries = useSyncExternalStore(subscribeToastHistory, getToastHistory, getToastHistory);
  const unread = useSyncExternalStore(subscribeToastHistory, getUnreadCount, getUnreadCount);
  return { entries, unread };
}
