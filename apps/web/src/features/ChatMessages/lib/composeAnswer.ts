import type { PickedAnswers, Question } from '../ui/QuestionCard.types';

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

/**
 * Тот же ответ, но для канала подтверждения прав: через него агент и ждёт
 * выбора. Канал умеет ровно две вещи — разрешить или отказать с текстом.
 * Разрешить нельзя: CLI тогда выполнит вызов сам и упрётся в то, что в режиме
 * `-p` спрашивать не у кого («Answer questions?»). Значит, ответ едет текстом
 * отказа — и этот текст обязан читаться как решение человека, а не как запрет,
 * иначе агент поймёт его как «нельзя» и пойдёт извиняться вместо работы.
 */
export function answerMessage(answer: string): string {
  return `Пользователь выбрал: ${answer}`;
}

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
