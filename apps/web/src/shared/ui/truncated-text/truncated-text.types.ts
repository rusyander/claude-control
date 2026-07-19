import type { TypographyProps } from '@shared/ui/typography';

export interface TruncatedTextProps {
  /** Полный текст: он же попадает в подсказку, если не помещается. */
  text: string;
  variant?: TypographyProps['variant'];
  color?: TypographyProps['color'];
  weight?: TypographyProps['weight'];
  className?: string;
}
