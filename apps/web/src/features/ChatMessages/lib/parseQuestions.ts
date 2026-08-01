import type { Question } from '../ui/QuestionCard.types';

/** Разбор input вызова: пришёл он строкой JSON, и формат нам не подконтролен. */
export function parseQuestions(input: string): Question[] | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    const questions = (parsed as { questions?: unknown }).questions;
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    return questions as Question[];
  } catch {
    return undefined;
  }
}
