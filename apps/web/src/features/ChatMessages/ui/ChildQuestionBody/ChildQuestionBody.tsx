import { markQuestionAnswered, useAnsweredQuestions } from '@shared/lib/agent-runs';
import { parseQuestions } from '../../lib/parseQuestions';
import { liveQuestionKey } from '../../lib/liveQuestionKey';
import { QuestionCard } from '../QuestionCard/QuestionCard';
import { ChildTextQuestion } from '../ChildTextQuestion/ChildTextQuestion';
import type { ChildQuestionBodyProps } from './ChildQuestionBody.types';

/**
 * Вопрос дочернего разговора с формой ответа — одна и та же в полосе над хабом
 * и в карточке группы: отметка «отвечено» общая, и ответ, данный в одном
 * месте, не предлагается второй раз в другом.
 */
export function ChildQuestionBody({ question, onAnswer }: ChildQuestionBodyProps) {
  const answered = useAnsweredQuestions();

  // Вопрос ТЕКСТОМ (журнал 97 g7): вариантов нет — поле ответа.
  if (question.text) {
    const textKey = liveQuestionKey(question.chatId, undefined, question.text);
    return (
      <ChildTextQuestion
        text={question.text}
        target={question.title}
        busy={question.isRunning}
        isAnswered={answered.has(textKey)}
        onAnswer={(answer) => {
          markQuestionAnswered(textKey);
          onAnswer(question.chatId, answer);
        }}
      />
    );
  }

  const parsed = parseQuestions(question.input);
  if (!parsed) return null;
  const key = liveQuestionKey(question.chatId, question.toolUseId, question.input);
  return (
    <QuestionCard
      questions={parsed}
      onPick={(answer) => {
        markQuestionAnswered(key);
        onAnswer(question.chatId, answer);
      }}
      busy={question.isRunning}
      isAnswered={answered.has(key)}
      // Подпись сохраняется и ПОСЛЕ ответа: «отправлено» без имени разговора
      // не говорит, кому именно из шестерых человек ответил.
      target={question.title}
    />
  );
}
