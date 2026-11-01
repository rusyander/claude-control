import type { StepPathListProps } from './StepPathList.types';
import styles from './StepPathList.module.scss';

/**
 * Список шагов с местами «+» между строками — общий у «Порядка работы» групп и у редактора
 * сценария ядра. `listRef` — из `useStepDrag`: по нему перенос ищет места и возвращает фокус
 * ручке перенесённого шага.
 */
export function StepPathList({ listRef, label, children }: StepPathListProps) {
  return (
    <ol ref={listRef} className={styles.list} aria-label={label}>
      {children}
    </ol>
  );
}
