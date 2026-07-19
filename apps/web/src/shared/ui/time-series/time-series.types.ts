export interface TimeSeriesPoint {
  /** Метка по оси X: дата или час. */
  label: string;
  value: number;
  /** Готовая подпись значения для всплывающей подсказки. */
  valueLabel: string;
}

export interface TimeSeriesProps {
  points: TimeSeriesPoint[];
  /** Название ряда: подставляется в подсказку, поэтому легенда не нужна. */
  seriesName: string;
  height?: number;
}
