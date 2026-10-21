import type { ChildQuestion } from '../ChildQuestion.types';

export interface ChildQuestionBodyProps {
  question: ChildQuestion;
  /** Ответ уходит в ЧАТ ребёнка, не в тот разговор, где карточка стоит. */
  onAnswer: (chatId: string, answer: string) => void;
}
