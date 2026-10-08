import type { QuestionState } from '../ui/QuestionCard/QuestionCard.types';

/** Отвечен — свёрнут, текущий — активен, остальные погашены до своей очереди. */
export function stateOf(
  index: number,
  current: number | undefined,
  hasAnswer: boolean,
): QuestionState {
  if (index === current) return 'current';
  if (hasAnswer) return 'done';
  return 'locked';
}
