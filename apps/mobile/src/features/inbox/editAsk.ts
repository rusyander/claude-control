import type { CardState } from './queue.types';

/** Вернуться к уже отвеченному. */
export function editAsk(state: CardState, key: string): CardState {
  return { ...state, editing: key };
}
