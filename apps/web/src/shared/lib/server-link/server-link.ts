import { useSyncExternalStore } from 'react';
import type { ServerLinkState } from './server-link.types';

/**
 * Связь вкладки с сервером панели — по потоку `/api/events`. Источник один:
 * `FileWatchProvider` сообщает об открытии и ошибке потока. Ошибку не
 * объявляем сразу: перезапуск сервера рвёт поток на секунду-две, и браузер
 * переподключается сам — «пропала связь» на каждый такой разрыв был бы шумом.
 * Поток не открылся за `LINK_GRACE_MS` — связь пропала.
 */
export const LINK_GRACE_MS = 5_000;

let state: ServerLinkState = 'unknown';
let graceTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: ServerLinkState): void {
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Поток открылся: связь есть, отложенное «пропала» отменяется. */
export function reportLinkUp(): void {
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  graceTimer = undefined;
  set('up');
}

/** Поток оборвался: через срок ожидания, если не открылся снова, — «пропала». */
export function reportLinkError(): void {
  if (graceTimer !== undefined || state === 'down') return;
  graceTimer = setTimeout(() => {
    graceTimer = undefined;
    set('down');
  }, LINK_GRACE_MS);
}

export function getServerLink(): ServerLinkState {
  return state;
}

export function subscribeServerLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Для тестов: исходное состояние без висящего таймера. */
export function resetServerLink(): void {
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  graceTimer = undefined;
  state = 'unknown';
}

export function useServerLink(): ServerLinkState {
  return useSyncExternalStore(subscribeServerLink, getServerLink, () => 'unknown' as const);
}
