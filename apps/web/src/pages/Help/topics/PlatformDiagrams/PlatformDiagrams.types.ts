export interface DiagramProps {
  /** Перевод ключа `help.topics.platform.<key>` — словарь остаётся один. */
  tr: (key: string) => string;
}

/** Одна строка матрицы диаграммы 4. */
export interface CapabilityRow {
  label: string;
  /** Полностью · только как собеседник · не работает. */
  mark: 'yes' | 'partial' | 'no';
}
