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
  /**
   * Агент этого разговора сейчас работает. Отвечать это НЕ мешает: вызов
   * `AskUserQuestion` в пакетном режиме возвращается ошибкой сразу и никого не
   * ждёт, так что вопрос задан посреди хода. Признак нужен только карточке —
   * сказать правду о судьбе ответа: он встанет в очередь и уйдёт по концу хода,
   * а не «агент думает над ним прямо сейчас».
   */
  busy?: boolean;
}

/** Что уже выбрано: индекс вопроса → выбранные подписи вариантов. */
export type PickedAnswers = Record<number, string[] | undefined>;

/** Состояние одного вопроса в карточке — оно же решает, как он выглядит. */
export type QuestionState = 'done' | 'current' | 'locked';
