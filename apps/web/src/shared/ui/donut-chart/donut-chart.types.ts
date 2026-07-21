export interface DonutSegment {
  /** Уникальный ключ сегмента. */
  id: string;
  label: string;
  value: number;
  /** Готовая подпись значения для легенды и подсказки. */
  valueLabel: string;
  /** Номер слота палитры (1..5), закреплённый за категорией. */
  seriesIndex: number;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  /** Название состава для скринридера. */
  ariaLabel: string;
  /** Крупное число в центре кольца — итоговый показатель. */
  centerValue?: string;
  /** Подпись под числом в центре. */
  centerLabel?: string;
}
