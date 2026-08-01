import type { TypographyProps } from './typography.types';

/**
 * Заголовки по умолчанию рендерятся заголовочными тегами: так структура
 * страницы остаётся осмысленной для скринридеров без ручного as.
 */
export function defaultTag(variant: TypographyProps['variant']): 'h1' | 'h2' | 'h3' | 'p' | 'span' {
  if (variant === 'heading-lg') return 'h1';
  if (variant === 'heading') return 'h2';
  if (variant === 'heading-sm') return 'h3';
  if (variant === 'caption' || variant === 'mono') return 'span';
  return 'p';
}
