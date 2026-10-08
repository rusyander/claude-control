export interface PathToolbarProps {
  query: string;
  onQuery: (query: string) => void;
  total: number;
  shown: number;
  /** Есть блоки скиллов — есть что сворачивать. */
  hasBlocks: boolean;
  isAllOpen: boolean;
  onToggleAll: () => void;
  /** Путь пуст — кнопка зовётся «первый шаг». */
  isEmpty: boolean;
  onAdd: () => void;
  /** Что сказать диктору: перенос шага, итог фильтра. */
  announcement: string;
}
