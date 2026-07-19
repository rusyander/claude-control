import type { ReactNode } from 'react';

export interface VirtualListProps<TItem> {
  items: TItem[];
  /** Высота строки в пикселях: нужна для расчёта окна прокрутки. */
  rowHeight: number;
  /** Высота видимой области. */
  height: number;
  renderRow: (item: TItem, index: number) => ReactNode;
  getKey: (item: TItem, index: number) => string;
  /**
   * Ниже этого количества строк виртуализация не включается: она усложняет
   * поиск по странице и выделение текста, а выигрыша на коротком списке нет.
   */
  threshold?: number;
}
