import type { ReactNode } from 'react';
import type { IconName } from '@shared/ui/icon';

export interface PageTabItem<T extends string> {
  id: T;
  label: string;
  icon?: IconName;
  /** Число рядом с подписью: сколько записей на вкладке. Нет числа — нет плашки. */
  count?: number;
  /**
   * Что значит число, если это не «всего записей» (на «Сравнении» — сколько
   * различается): подсказка при наведении и часть доступного имени вкладки.
   * Без неё 147 различий читались как 147 записей всего.
   */
  countHint?: string;
  /**
   * Короткая пометка вместо числа, требующая внимания («не сохранено»): видна
   * с любой вкладки, чтобы несохранённое не терялось за соседней.
   */
  note?: string;
}

export interface PageTabsProps<T extends string> {
  /** Раздел страницы — из него строятся id вкладок и панелей. */
  page: string;
  /** Доступное имя полосы: «Разделы защиты данных». */
  label: string;
  tabs: readonly PageTabItem<T>[];
  active: T;
  onSelect: (tab: T) => void;
}

export interface PageTabPanelProps {
  page: string;
  tab: string;
  /** Строка под полосой: что лежит на этой вкладке. Ярлыки короткие — подпись объясняет. */
  hint?: string;
  children: ReactNode;
}
