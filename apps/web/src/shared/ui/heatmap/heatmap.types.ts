export interface HeatmapCell {
  /** Уникальный ключ ячейки. */
  id: string;
  /** Подпись оси и заголовок подсказки: час, день недели и т.п. */
  label: string;
  value: number;
  /** Готовая подпись значения для всплывающей подсказки. */
  valueLabel: string;
}

export interface HeatmapScale {
  /** Подпись у слабого края шкалы. */
  min: string;
  /** Подпись у насыщенного края шкалы. */
  max: string;
}

export interface HeatmapProps {
  cells: HeatmapCell[];
  /** Название набора для скринридера: график сам по себе слепому недоступен. */
  ariaLabel: string;
  /** Ячеек в строке; по умолчанию всё в одну строку. */
  columns?: number;
  /** Сколько подписей оси показать максимум. */
  maxAxisLabels?: number;
  /** Пояснение цветовой шкалы «меньше → больше». */
  scale?: HeatmapScale;
}
