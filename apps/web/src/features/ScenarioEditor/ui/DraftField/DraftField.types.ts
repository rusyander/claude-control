import type { TextFieldProps } from '@shared/ui/text-field';

export interface DraftFieldProps extends Omit<TextFieldProps, 'value' | 'onChange'> {
  /** Начальный текст поля (значение схемы, записанное текстом). */
  value: string;
  /** Каждый ввод — текстом; разбор в значение схемы — у вызывающего. */
  onCommit: (text: string) => void;
}
