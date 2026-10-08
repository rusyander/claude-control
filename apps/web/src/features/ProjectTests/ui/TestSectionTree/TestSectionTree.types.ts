import type { SectionNode } from '@entities/ProjectTest';

export interface TestSectionTreeProps {
  sections: SectionNode[];
  /** Всего кейсов в группе — счётчик корневой строки «Все секции». */
  total: number;
  /** Выбранная ветка; пусто — отбор по секциям не стоит. */
  selected: string;
  onSelect: (path: string) => void;
}
