import type { ReactNode } from 'react';

export interface SectionProps {
  /** Перевод ключа `help.topics.platform.<key>`. */
  tr: (key: string) => string;
  /**
   * Путь в снимках. Приходит извне, а не импортом: середина документа — самая
   * тяжёлая его часть, и место, куда она встаёт, решает сам документ.
   */
  guide: ReactNode;
}
