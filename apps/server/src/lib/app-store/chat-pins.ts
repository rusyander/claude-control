import type { AppState } from './app-store.types.ts';

/**
 * Закреплённые разговоры списка (владелец, 07.10.2026): id корня → момент
 * закрепления. Закрепляется только корень — ветвь разделения едет за ним, —
 * поэтому запись одна на ветвь, а не на каждого ребёнка.
 *
 * Потолок — от мусора, а не от человека: сотня закреплённых уже не «сверху»,
 * а второй список. Старейшие уходят первыми.
 */
const MAX_PINS = 100;

export function getChatPins(state: AppState): Record<string, string> {
  return state.chatPins ?? {};
}

/** Закрепить или открепить; `false` — менять было нечего, сохранять не нужно. */
export function setChatPin(state: AppState, chatId: string, pinned: boolean, at: string): boolean {
  const pins = state.chatPins ?? {};
  if (pinned === Boolean(pins[chatId])) return false;
  if (pinned) pins[chatId] = at;
  else delete pins[chatId];
  state.chatPins = pins;
  prune(pins);
  return true;
}

function prune(pins: Record<string, string>): void {
  const keys = Object.keys(pins);
  if (keys.length <= MAX_PINS) return;
  const ordered = keys.sort((a, b) => (pins[a] ?? '').localeCompare(pins[b] ?? ''));
  for (const key of ordered.slice(0, keys.length - MAX_PINS)) delete pins[key];
}
