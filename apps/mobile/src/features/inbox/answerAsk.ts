import type { CardState, AskAnswer } from './queue.types';

/** Ответить на вопрос: он сворачивается, открывается следующий. */
export function answerAsk(state: CardState, key: string, answer: AskAnswer): CardState {
  const { editing: _editing, ...rest } = state;
  return { ...rest, answers: { ...state.answers, [key]: answer } };
}
