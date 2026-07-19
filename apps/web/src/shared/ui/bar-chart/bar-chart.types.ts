export interface BarChartItem {
  /** Уникальный ключ строки: подписи могут совпадать у разных сущностей. */
  id: string;
  label: string;
  value: number;
  /** Подпись значения справа: показывается всегда, а не по наведению. */
  valueLabel: string;
  /** Номер слота палитры, закреплённый за сущностью. */
  seriesIndex?: number;
  hint?: string;
}

export interface BarChartProps {
  items: BarChartItem[];
  /** Сколько строк показать; остальные сворачиваются в «Прочее». */
  limit?: number;
  otherLabel?: string;
  /** Клик по строке открывает подробности. Без обработчика строки неинтерактивны. */
  onItemClick?: (id: string) => void;
}
