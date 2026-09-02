import type { Question } from '../ui/QuestionCard.types';

/**
 * Разбор input вызова: формат нам не подконтролен, и приходит он в двух видах.
 * Из потока — строкой JSON (так его отдаёт CLI), из запроса прав perm-guard —
 * уже разобранным объектом. Оба ведут к одной карточке, поэтому и разбор один.
 */
export function parseQuestions(input: unknown): Question[] | undefined {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const questions = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  return questions as Question[];
}
