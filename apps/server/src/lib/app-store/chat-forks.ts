import type { AppState } from './app-store.types.ts';

/**
 * Ветки правки своей реплики: сессия ветки → сессия, от которой она ответвилась
 * (`--fork-session`). Транскрипт об этом молчит — у ветки та же история и то же
 * название, — и без записи список показывал два одинаковых разговора
 * (Telegram 26.10). Помнит панель, отдаёт список (`forkOf`).
 *
 * Потолок — от мусора: ветка без исходного в списке всё равно подписана, а
 * сотни старых правок не нужны никому. Старейшие записи уходят первыми.
 */
const MAX_FORKS = 500;

export function getChatForks(state: AppState): Record<string, string> {
  return state.chatForks ?? {};
}

/** Записать ветку; `false` — записывать было нечего (та же сессия, уже записано). */
export function recordChatFork(state: AppState, fork: string, origin: string): boolean {
  if (!fork || !origin || fork === origin) return false;
  const forks = (state.chatForks ??= {});
  if (forks[fork] === origin) return false;
  forks[fork] = origin;
  const keys = Object.keys(forks);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FORKS))) delete forks[key];
  return true;
}
