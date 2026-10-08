import type { CardState } from './queue.types';
import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';

/**
 * Свести выбранное с ответом сервера. Вопрос исчез (ответили за компьютером,
 * прогон остановлен) — его ответ забывается, текущим становится следующий.
 * Пришёл новый — встаёт в конец и ждёт своей очереди, не перебивая текущий.
 * Ничего не изменилось — тот же объект: перерисовывать нечего.
 */
export function reconcile(state: CardState, asks: readonly InboxAsk[]): CardState {
  const live = new Set(asks.map((ask) => ask.key));
  const stale = Object.keys(state.answers).filter((key) => !live.has(key));
  const editingGone = state.editing !== undefined && !live.has(state.editing);
  if (stale.length === 0 && !editingGone) return state;
  const answers = { ...state.answers };
  for (const key of stale) delete answers[key];
  return editingGone ? { answers } : { ...state, answers };
}
