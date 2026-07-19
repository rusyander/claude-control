import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  /** Приподнятая карточка используется для активных и выделенных элементов. */
  isRaised?: boolean;
  /** Интерактивная карточка реагирует на наведение и получает фокус. */
  isInteractive?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  className?: string;
  children: ReactNode;
}
