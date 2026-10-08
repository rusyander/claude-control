import styles from '../ui/PendingActionCard/PendingActionCard.module.scss';

/** Класс строки диффа по её первому знаку — как в унифицированном диффе. */
export const diffLineClass = (line: string): string | undefined => {
  if (line.startsWith('+') && !line.startsWith('+++')) return styles.diffAdd;
  if (line.startsWith('-') && !line.startsWith('---')) return styles.diffDel;
  return undefined;
};
