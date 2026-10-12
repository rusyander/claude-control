import type { ChangelogEntry } from '@agentdeck/contracts/changelog';

/** Ниже этой доли сегмент полосы не разглядеть: область с горсткой строк всё равно видна. */
const MIN_PERCENT = 2;

export interface AreaShare {
  area: ChangelogEntry['areas'][number]['area'];
  /** Доля ширины полосы, 0–100; в сумме 100. */
  percent: number;
}

/**
 * Ширины сегментов полосы «Что затронуто»: доля по сумме добавленных и удалённых
 * строк, но не меньше 2 % (иначе область с тремя строками исчезала бы), и
 * после подъёма долей общая сумма снова сводится к 100.
 */
export function areaShares(areas: ChangelogEntry['areas']): AreaShare[] {
  if (areas.length === 0) return [];
  const weights = areas.map((a) => Math.max(1, a.insertions + a.deletions));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const raised = weights.map((w) => Math.max(MIN_PERCENT, (w / total) * 100));
  const raisedTotal = raised.reduce((sum, p) => sum + p, 0);
  return areas.map((a, i) => ({ area: a.area, percent: (raised[i]! / raisedTotal) * 100 }));
}
