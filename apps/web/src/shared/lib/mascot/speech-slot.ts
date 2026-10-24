import { useSyncExternalStore } from 'react';

/**
 * Место для реплики Деки внутри страницы. Чат ставит его над полем ввода: там
 * реплика стоит в потоке страницы и ничего не накрывает. Нет места — реплика
 * всплывает облачком у боковой панели, как на остальных страницах. Место одно:
 * последнее зарегистрированное и есть текущее.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function set(next: HTMLElement | null): void {
  if (slot === next) return;
  slot = next;
  listeners.forEach((listener) => listener());
}

/** Поставить место; вернёт снятие — оно снимает только СВОЁ место, не чужое. */
export function registerMascotSpeechSlot(element: HTMLElement): () => void {
  set(element);
  return () => {
    if (slot === element) set(null);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMascotSpeechSlot(): HTMLElement | null {
  return slot;
}

export function useMascotSpeechSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getMascotSpeechSlot, () => null);
}
