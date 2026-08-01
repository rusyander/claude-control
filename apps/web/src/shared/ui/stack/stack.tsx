import type { CSSProperties } from 'react';
import styles from './stack.module.scss';
import { toCss } from './stack.lib';
import type { StackProps } from './stack.types';

/**
 * Заменяет любой flex-контейнер. Раскладка задаётся пропами, а не отдельным
 * scss-классом, поэтому в проекте почти нет классов вида «обёртка с флексом».
 * Полиморфен через as и пробрасывает остальные атрибуты на элемент —
 * поэтому годится и для семантических тегов, и для контейнеров с data-атрибутами.
 */
export function Stack({
  direction = 'column',
  gap,
  padding,
  margin,
  marginTop,
  width,
  minWidth,
  flex,
  flexShrink,
  align,
  justify,
  wrap,
  as,
  className,
  children,
  ...rest
}: StackProps) {
  const Component = as ?? 'div';

  const classes = [
    styles.root,
    styles[direction],
    wrap && styles.wrap,
    align && styles[`align-${align}`],
    justify && styles[`justify-${justify}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const style: CSSProperties = {
    gap: toCss(gap),
    padding: toCss(padding),
    margin: toCss(margin),
    marginTop: toCss(marginTop),
    width: toCss(width),
    minWidth: toCss(minWidth),
    flex,
    flexShrink,
  };

  return (
    <Component className={classes} style={style} {...rest}>
      {children}
    </Component>
  );
}
