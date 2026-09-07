import type { ProjectTestBaseline } from '@agentdeck/contracts';

/**
 * Показ сверки скриншотов: что выбрано, чем это подписать и каким цветом.
 *
 * Логика отдельно от разметки не ради красоты: «эталона нет» и «эталон не
 * прочитался» выглядят одинаково пусто, а значат противоположное — первое
 * нормально для нового кейса, второе означает сломанный файл, и путать их
 * нельзя. Поэтому состояние точки — закрытый список, а не догадка по наличию
 * картинок.
 */

export type BaselineTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONES: Record<ProjectTestBaseline['status'], BaselineTone> = {
  match: 'success',
  diff: 'warning',
  new: 'neutral',
  error: 'danger',
};

export function baselineTone(status: ProjectTestBaseline['status']): BaselineTone {
  return TONES[status] ?? 'neutral';
}

/** Выбранная точка: пропавшая заменяется первой, чтобы окно не пустело. */
export function pickPoint(
  points: ProjectTestBaseline[],
  pointId: string,
): ProjectTestBaseline | undefined {
  return points.find((point) => point.pointId === pointId) ?? points[0];
}

/**
 * Доля расхождения процентом. Округляем до сотых: расхождение в один пиксель
 * из миллиона — это 0,0001 %, и «0 %» на экране означало бы «совпало», хотя
 * порог оно могло и превысить.
 */
export function ratioPercent(ratio: number | undefined): string {
  if (ratio === undefined || Number.isNaN(ratio)) return '';
  return `${(ratio * 100).toFixed(2)}%`;
}

/** Превышен ли порог. Порога нет — судить не о чем, и мы этого не выдумываем. */
export function isOverThreshold(point: ProjectTestBaseline): boolean {
  if (point.diffRatio === undefined || point.maxDiffRatio === undefined) return false;
  return point.diffRatio > point.maxDiffRatio;
}
