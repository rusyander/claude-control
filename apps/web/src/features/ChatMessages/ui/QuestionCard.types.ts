export interface Option {
  label?: string;
  description?: string;
}

export interface Question {
  question?: string;
  header?: string;
  multiSelect?: boolean;
  options?: Option[];
}

export interface QuestionCardProps {
  questions: Question[];
  /** Ответить (отправка в тот же разговор). Нет — вопрос только для чтения. */
  onPick?: (answer: string) => void;
  /** Пока идёт прогон, отвечать нельзя — варианты недоступны. */
  disabled?: boolean;
}

/** Что уже выбрано: индекс вопроса → выбранные подписи вариантов. */
export type PickedAnswers = Record<number, string[] | undefined>;

/** Состояние одного вопроса в карточке — оно же решает, как он выглядит. */
export type QuestionState = 'done' | 'current' | 'locked';
