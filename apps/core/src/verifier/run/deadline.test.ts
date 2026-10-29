import { describe, expect, it } from 'vitest';
import { DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, deadlineOf } from './deadline.ts';

/**
 * Срок прогона учится и на снятых прогонах (A1r3-F08): прогон, обрезанный сроком на T, шёл дольше
 * T — следующий срок не меньше 2T. Иначе 40-минутный набор резался на 30 минутах на каждом ключе.
 */

describe('run deadline learns from runs cut short (A1r3-F08)', () => {
  it('a run aborted at the default deadline doubles the next one; finished runs still give p95 x3', () => {
    expect(deadlineOf([], [DEFAULT_DEADLINE_MS]).ms).toBe(2 * DEFAULT_DEADLINE_MS);
    expect(deadlineOf([], [DEFAULT_DEADLINE_MS]).basis).toMatch(/aborted/);
    // p95 × 3 больше — он и решает.
    expect(deadlineOf([60 * 60_000], [10_000]).ms).toBe(3 * 60 * 60_000);
    // Короткая отмена (пауза через секунду) не урезает щедрое умолчание.
    expect(deadlineOf([], [1_000]).ms).toBe(DEFAULT_DEADLINE_MS);
    // Удвоение не растёт без предела.
    expect(deadlineOf([], [MAX_DEADLINE_MS]).ms).toBe(MAX_DEADLINE_MS);
    expect(deadlineOf([]).ms).toBe(DEFAULT_DEADLINE_MS);
  });
});
