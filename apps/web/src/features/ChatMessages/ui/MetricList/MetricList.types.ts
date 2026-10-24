export interface MetricItem {
  key: string;
  label: string;
  value: string;
  /** Тихая приписка под значением. */
  hint?: string;
}

export interface MetricListProps {
  items: MetricItem[];
  /**
   * Имя data-атрибута списка; у каждой колонки — тот же с `-cell` и ключом
   * колонки (`data-hub-meta` → `data-hub-meta-cell="model"`): по ним ищут
   * проверки и тесты.
   */
  attr: `data-${string}`;
  className?: string;
}
