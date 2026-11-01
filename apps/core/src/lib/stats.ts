/**
 * Статистика длительностей — общая для срока прогона проверки (`verifier/run/deadline.ts`) и порога
 * тишины наблюдателя (этап 8: выученный p95 хода).
 */

/** p95 по ближайшему рангу; нечисла и отрицательные отброшены; пустой список — `null`. */
export function p95(samples: readonly number[]): number | null {
  const clean = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const rank = Math.ceil(0.95 * clean.length);
  return clean[Math.min(clean.length, Math.max(1, rank)) - 1]!;
}
