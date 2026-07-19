import type { ElementType, HTMLAttributes, ReactNode } from 'react';

/** Число трактуем как пиксели, строку — как есть: так можно передать токен. */
export type SpaceValue = number | string;

export interface StackProps extends Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'> {
  direction?: 'row' | 'column';
  gap?: SpaceValue;
  padding?: SpaceValue;
  margin?: SpaceValue;
  marginTop?: SpaceValue;
  width?: SpaceValue;
  /**
   * Минимальная ширина. Нужна колонкам с длинным текстом внутри строки:
   * без min-width: 0 такая колонка не сжимается и выдавливает соседей
   * за границы карточки.
   */
  minWidth?: SpaceValue;
  /** Доля свободного места: 1 — занять остаток, 0 — не растягиваться. */
  flex?: number;
  /** Запрет сжатия: 0 оставляет блоку его собственную ширину. */
  flexShrink?: number;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  /** Тег контейнера: div по умолчанию, но бывает нужен section, nav или ul. */
  as?: ElementType;
  className?: string;
  children?: ReactNode;
}
