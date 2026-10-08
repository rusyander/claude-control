import type { PickedAnswers, Question } from '../ui/QuestionCard/QuestionCard.types';

/**
 * Собрать ответ на карточку вопросов в одно сообщение.
 *
 * Одним, а не по сообщению на вопрос: каждое сообщение — это новый ход агента,
 * и три сообщения подряд заставили бы его отвечать на первый вопрос, ничего не
 * зная про два оставшихся. Поэтому карточка собирается целиком и уходит разом.
 *
 * Один вопрос — просто подпись выбранного варианта, как и было: приписывать
 * заголовок к единственному ответу значит писать агенту то, что он и так знает.
 */
export function composeAnswer(questions: Question[], picked: PickedAnswers): string {
  if (questions.length === 1) return (picked[0] ?? []).join(', ');

  return questions
    .map((question, index) => {
      const chosen = picked[index] ?? [];
      if (chosen.length === 0) return '';
      const title = question.header || question.question || String(index + 1);
      return `${title}: ${chosen.join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
}
