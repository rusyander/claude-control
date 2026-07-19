import type { CSSProperties } from 'react';
import styles from './typography.module.scss';
import type { TypographyProps } from './typography.types';

/**
 * Единственный способ выводить текст в приложении: сырые теги абзацев,
 * заголовков и span не используются.
 * Вариант задаёт пару «размер + высота строки» из шкалы токенов, поэтому
 * типографика остаётся согласованной, а тема и режим крупного текста
 * подхватываются автоматически.
 */
export function Typography({
  variant = 'body',
  color = 'default',
  weight,
  align,
  truncate,
  clamp,
  as,
  className,
  children,
  ...rest
}: TypographyProps) {
  // Заголовки по умолчанию рендерятся заголовочными тегами: так структура
  // страницы остаётся осмысленной для скринридеров без ручного as.
  const Component = as ?? defaultTag(variant);

  const classes = [
    styles.root,
    styles[variant],
    styles[`color-${color}`],
    weight && styles[`weight-${weight}`],
    align && styles[`align-${align}`],
    truncate && styles.truncate,
    clamp && styles.clamp,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const style = clamp ? ({ WebkitLineClamp: clamp } as CSSProperties) : undefined;

  return (
    <Component className={classes} style={style} {...rest}>
      {children}
    </Component>
  );
}

function defaultTag(variant: TypographyProps['variant']): 'h1' | 'h2' | 'h3' | 'p' | 'span' {
  if (variant === 'heading-lg') return 'h1';
  if (variant === 'heading') return 'h2';
  if (variant === 'heading-sm') return 'h3';
  if (variant === 'caption' || variant === 'mono') return 'span';
  return 'p';
}
