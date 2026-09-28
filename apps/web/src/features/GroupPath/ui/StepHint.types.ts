import type { ReactNode } from 'react';

export interface StepHintProps {
  /** id подсказки — на него ссылается `aria-describedby` кнопки строки. */
  id: string;
  isShown: boolean;
  children: ReactNode;
}
