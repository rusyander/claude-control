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
  /** Ответить выбранным вариантом (отправка в тот же разговор). */
  onPick?: (answer: string) => void;
  /** Пока идёт прогон, отвечать нельзя — варианты недоступны. */
  disabled?: boolean;
}
