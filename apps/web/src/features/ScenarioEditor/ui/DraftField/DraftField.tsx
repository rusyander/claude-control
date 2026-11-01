import { useState } from 'react';
import { TextField } from '@shared/ui/text-field';
import type { DraftFieldProps } from './DraftField.types';

/**
 * Поле, чей текст разбирается в значение схемы (список через запятую, строки, число). Текст
 * держится свой: разбор «a, » → `['a']` иначе съедал бы запятую под курсором и вписать второй
 * id было бы нельзя. Форма шага пересоздаётся при выборе другого шага — текст берётся заново.
 */
export function DraftField({ value, onCommit, ...field }: DraftFieldProps) {
  const [text, setText] = useState(value);
  return (
    <TextField
      {...field}
      value={text}
      onChange={(next) => {
        setText(next);
        onCommit(next);
      }}
    />
  );
}
