import type { RowText } from '../model/describe';

export interface RowTextViewProps {
  text: RowText;
  /** Подсказка — одна строка мелким шрифтом; окно шага — весь текст как есть. */
  variant: 'hint' | 'full';
}
