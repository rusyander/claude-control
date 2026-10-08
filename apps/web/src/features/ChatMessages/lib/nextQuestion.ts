import type { Question, PickedAnswers } from '../ui/QuestionCard/QuestionCard.types';

/**
 * Какой вопрос спрашиваем сейчас. `undefined` — отвечены все, карточка готова
 * к отправке.
 *
 * Множественный выбор закрывается не первым щелчком, а подтверждением: иначе
 * вопрос «отметьте всё, что подходит» схлопывался бы после первой же галочки,
 * не дав поставить вторую.
 */
export function nextQuestion(
  questions: Question[],
  picked: PickedAnswers,
  confirmed: Record<number, boolean>,
): number | undefined {
  const index = questions.findIndex((question, at) => {
    if ((picked[at] ?? []).length === 0) return true;
    return Boolean(question.multiSelect) && !confirmed[at];
  });
  return index === -1 ? undefined : index;
}
