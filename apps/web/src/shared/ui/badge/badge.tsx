import styles from './badge.module.scss';
import type { BadgeProps } from './badge.types';

/** Метка статуса: состояние сущности, тип решения в permissions, имя группы. */
export function Badge({ tone = 'neutral', withDot, className, children }: BadgeProps) {
  const classes = [styles.root, styles[tone], className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      {withDot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}
