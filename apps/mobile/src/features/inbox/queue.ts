import type { InboxAsk } from '@agentdeck/contracts/chat-inbox';
import type { AskAnswer, CardState } from './queue.types';

export const EMPTY_CARD: CardState = { answers: {} };

export interface CardView {
  /** Отвеченные — свёрнутыми строками, в порядке вопросов. */
  done: { ask: InboxAsk; answer: AskAnswer }[];
  /** Тот, что спрашиваем сейчас. Нет — отвечено всё. */
  current?: InboxAsk;
  /** Ещё не дошли. */
  upcoming: InboxAsk[];
  /** Всё отвечено — можно отправлять. */
  ready: boolean;
  /** Номер текущего (с единицы) и сколько всего. */
  step: number;
  total: number;
}

export function cardView(asks: readonly InboxAsk[], state: CardState): CardView {
  const editing = asks.find((ask) => ask.key === state.editing);
  const pending = asks.find((ask) => !state.answers[ask.key]);
  const current = editing ?? pending;
  const done: CardView['done'] = [];
  const upcoming: InboxAsk[] = [];
  for (const ask of asks) {
    if (ask === current) continue;
    const answer = state.answers[ask.key];
    if (answer) done.push({ ask, answer });
    else upcoming.push(ask);
  }
  return {
    done,
    ...(current ? { current } : {}),
    upcoming,
    ready: asks.length > 0 && !pending && !editing,
    step: current ? asks.indexOf(current) + 1 : asks.length,
    total: asks.length,
  };
}
