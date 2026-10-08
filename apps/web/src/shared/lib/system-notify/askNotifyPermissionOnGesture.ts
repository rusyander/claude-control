import { ASKED_KEY } from './systemNotify.constants';
import { api } from './api';

/** Жесты, на которых браузер разрешает спросить. */
export const GESTURES = ['pointerdown', 'keydown'] as const;

/** Перехват до страницы: жест, который страница гасит у себя, тоже считается. */
export const CAPTURE = { capture: true } as const;

export function wasAsked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberAsked(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Хранилище недоступно — спросим ещё раз в следующей сессии, не страшно.
  }
}

/**
 * Спросить разрешение на первом жесте человека — один раз. На загрузке не
 * спрашивает ничего; возвращает снятие подписки.
 */
export function askNotifyPermissionOnGesture(): () => void {
  const NotificationApi = api();
  if (!NotificationApi || NotificationApi.permission !== 'default' || wasAsked()) {
    return () => undefined;
  }
  const detach = (): void => {
    for (const gesture of GESTURES) document.removeEventListener(gesture, ask, CAPTURE);
  };
  function ask(): void {
    detach();
    if (NotificationApi?.permission !== 'default' || wasAsked()) return;
    rememberAsked();
    void NotificationApi.requestPermission().catch(() => undefined);
  }
  for (const gesture of GESTURES) document.addEventListener(gesture, ask, CAPTURE);
  return detach;
}
