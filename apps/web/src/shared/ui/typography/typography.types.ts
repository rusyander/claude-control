import type { ElementType, HTMLAttributes, ReactNode, Ref } from 'react';

export type TypographyVariant =
  'heading-lg' | 'heading' | 'heading-sm' | 'body-lg' | 'body' | 'body-sm' | 'caption' | 'mono';

export type TypographyColor =
  'default' | 'muted' | 'subtle' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'inverse';

export interface TypographyProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'children' | 'color'
> {
  /** Атрибут подписи поля: Typography часто выступает <label>. */
  htmlFor?: string;
  /**
   * Ссылка на DOM-элемент. В React 19 ref — обычный проп функционального
   * компонента, поэтому forwardRef здесь не нужен.
   */
  ref?: Ref<HTMLElement>;
  variant?: TypographyVariant;
  color?: TypographyColor;
  weight?: 'regular' | 'medium' | 'semibold';
  align?: 'left' | 'center' | 'right';
  /** Обрезать одной строкой с многоточием. */
  truncate?: boolean;
  /** Ограничить N строками. Полезно для описаний скиллов в карточках. */
  clamp?: number;
  /** Тег, которым отрисовать текст: заголовок, абзац, span. */
  as?: ElementType;
  className?: string;
  children: ReactNode;
}
