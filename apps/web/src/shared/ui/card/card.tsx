import styles from './card.module.scss';
import type { CardProps } from './card.types';

/** Контейнер-карточка: единая рамка, радиус и тень для всех блоков приложения. */
export function Card({
  isRaised,
  isInteractive,
  padding = 'md',
  className,
  children,
  ...rest
}: CardProps) {
  const classes = [
    styles.root,
    isRaised && styles.raised,
    isInteractive && styles.interactive,
    styles[`padding-${padding}`],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
