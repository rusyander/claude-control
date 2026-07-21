export interface DonutArc {
  /** Доля сегмента в целом, 0..1. */
  fraction: number;
  /** Накопленная доля до начала сегмента, 0..1. */
  offset: number;
}

/**
 * Раскладка величин в дуги кольца: доля каждого сегмента и смещение его начала.
 * Порядок сохраняется исходным — цвет закреплён за категорией, сегменты не
 * переставляются по величине. Отрицательные значения гасятся до нуля, нулевая
 * сумма даёт нулевые доли (рисовать нечего) вместо деления на ноль.
 */
export function buildDonutArcs(values: number[]): DonutArc[] {
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0);
  let offset = 0;
  return values.map((value) => {
    const fraction = total > 0 ? Math.max(value, 0) / total : 0;
    const arc: DonutArc = { fraction, offset };
    offset += fraction;
    return arc;
  });
}
