/**
 * Срок прогона (01: «running: learned p95 × 3»). Выученные длительности — `ms` прошлых записей
 * той же проверки и единицы (без пауз, P43). Нет истории — щедрый срок по умолчанию: обрезать
 * впервые увиденную проверку значило бы назвать медленную красной. Нижняя граница защищает
 * быстрые проверки от шума машины под нагрузкой.
 */

export const DEFAULT_DEADLINE_MS = 30 * 60_000;
export const MIN_DEADLINE_MS = 60_000;
export const DEADLINE_FACTOR = 3;

/** p95 по ближайшему рангу; пустой список — `null`. */
export function p95(samples: readonly number[]): number | null {
  const clean = samples.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const rank = Math.ceil(0.95 * clean.length);
  return clean[Math.min(clean.length, Math.max(1, rank)) - 1]!;
}

/** Потолок удвоения после снятых прогонов: висящий набор не держит слот сутками. */
export const MAX_DEADLINE_MS = 6 * 3_600_000;

/**
 * `abortedMs` — длительности снятых прогонов (срок, отмена): снятый на T шёл дольше T, поэтому
 * следующий срок не меньше 2T (A1r3-F08). Без этого проверка дольше умолчания резалась на каждом
 * ключе и не заканчивалась никогда — снятый прогон без вердикта в выученные не попадал.
 */
export function deadlineOf(
  learnedMs: readonly number[],
  abortedMs: readonly number[] = [],
): { ms: number; basis: string } {
  const p = p95(learnedMs);
  const base =
    p === null
      ? { ms: DEFAULT_DEADLINE_MS, basis: 'no history: default' }
      : {
          ms: Math.max(MIN_DEADLINE_MS, Math.ceil(p * DEADLINE_FACTOR)),
          basis: `p95 ${p} ms × ${DEADLINE_FACTOR} over ${learnedMs.length} runs`,
        };
  const cut = abortedMs.filter((n) => Number.isFinite(n) && n > 0);
  if (cut.length === 0) return base;
  const floor = Math.min(MAX_DEADLINE_MS, 2 * Math.max(...cut));
  return floor > base.ms
    ? { ms: floor, basis: `${base.basis}; raised to 2× the longest aborted run (${cut.length})` }
    : base;
}
