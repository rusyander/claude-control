import type { ConfigPort } from '../api/config.types.ts';

/**
 * Отпечаток привязанного владельца Telegram (этап 12, D29, P187) из ДЕЙСТВУЮЩЕЙ настройки ядра —
 * той, что записало само ядро по строгой команде человека. Файл правлен мимо API (дрейф), настройка
 * не прочиталась или раздела нет — `null`: канал закрыт, пира `telegram` не бывает. Иначе правка
 * файла рукой (или сессией, читающей диск) открыла бы канал в обход суда полномочий.
 */
export function telegramOwnerOf(config: ConfigPort | undefined): string | null {
  if (!config) return null;
  let read: ReturnType<ConfigPort['view']>;
  try {
    read = config.view();
  } catch {
    return null;
  }
  if (!('value' in read)) return null;
  const view = read.value;
  if (view.drift) return null;
  if (view.issues.some((issue) => issue.section === 'telegram')) return null;
  return view.doc.telegram?.owner ?? null;
}
