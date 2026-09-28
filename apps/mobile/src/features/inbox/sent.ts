import { useSyncExternalStore } from 'react';

/**
 * Ответы, отправленные с этого телефона, — по ключам `sentKeys(chat, ask)`.
 *
 * Карточка исчезает сразу по нажатию «Отправить», а сервер перестаёт отдавать
 * вопрос лишь со следующим опросом (сообщение ещё встаёт в очередь, транскрипт
 * ещё дописывается). Без этой памяти отправленная карточка на секунды
 * возвращалась бы — и её хотелось бы нажать второй раз. Живёт в памяти
 * приложения: переживает переход в чат и обратно, а после перезапуска
 * приложения сервер уже не отдаёт отвеченного.
 */
let sent: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function markSent(keys: readonly string[]): void {
  if (keys.length === 0) return;
  sent = new Set([...sent, ...keys]);
  emit();
}

export function forgetSent(keys: readonly string[]): void {
  if (keys.length === 0) return;
  const next = new Set(sent);
  for (const key of keys) next.delete(key);
  sent = next;
  emit();
}

export function useSent(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => sent,
    () => sent,
  );
}
