import { CACHE_TTL_LONG_MS, CACHE_TTL_SHORT_MS, promptCost, quantile, writeRate } from '../cost.ts';
import { continuationNumbers } from '../continuation.ts';

/**
 * Оракул P14 (08:27, G6): правило продолжения против измеренного расхода экономической
 * библиотеки. Предсказание считает НАСТОЯЩАЯ `continuationNumbers`, не копия формулы.
 *
 * - Возврат в сессию (`resumes`): предсказано — перенос контекста прошлого хода по цене чтения
 *   (кэш тёплый по сроку) или записи (остыл); измерено — цена входа хода минус запись нового
 *   (сообщение и прошлый вывод платятся в обоих вариантах одинаково).
 * - Новый сеанс (`fresh`): предсказано — запись первого запроса (база + вводная) и ходы
 *   ориентации по выученной цене; измерено — цена входа всех ходов до первой правки файла.
 *   Выученное (медианы ходов и цены хода) берётся с чётных строк, проверка — на нечётных.
 *
 * Вердикт: разброс — в каждой группе (продолжение тёплое, холодное, новый сеанс) с ≥ 5
 * образцами отношение «измерено / предсказано» накрывает 1 полосой [p10, p90] (допуск 2 % —
 * счёт токенов); порядок — пары образцов, чья измеренная цена отличается ≥ 10 %, упорядочены
 * предсказанием так же, как измерением, в ≥ 80 %. Меньше 20 пар — «не доказано», не зелёный.
 */

export type ResumeRow = [number, number, number, number, number, number, number, number];
export type FreshRow = [number, number, number, number, number, number, number, number, number];

export interface EconFixture {
  resumes: ResumeRow[];
  fresh: FreshRow[];
}

export const MIN_PAIRS = 20;
export const MIN_RANK_AGREEMENT = 0.8;
export const SPREAD_TOLERANCE = 0.02;
const MIN_GROUP = 5;
const PAIR_GAP = 0.1;

export interface Sample {
  group: 'continue-warm' | 'continue-cold' | 'fresh';
  predicted: number;
  measured: number;
}

export interface Learned {
  orientationTurns: number;
  turnCostRatio: number;
}

const usage = (input: number, read: number, write: number, w1h: number) => ({
  input,
  cacheRead: read,
  cacheWrite: write,
  cacheWrite1h: w1h,
  output: 0,
});

/** Медианы ходов ориентации и цены хода ориентации на токен базы. */
export function learnFresh(rows: readonly FreshRow[]): Learned {
  const turns = rows.map((r) => Math.max(0, r[0] - 1));
  const ratios = rows
    .filter((r) => r[0] > 1)
    .map((r) => {
      const base = r[1] + r[2] + r[3];
      const first = promptCost(usage(r[1], r[2], r[3], r[4]));
      const all = promptCost(usage(r[5], r[6], r[7], r[8]));
      return base > 0 ? (all - first) / (r[0] - 1) / base : 0;
    });
  return {
    orientationTurns: quantile(turns, 0.5) ?? 0,
    turnCostRatio: quantile(ratios, 0.5) ?? 0,
  };
}

export function resumeSample(row: ResumeRow): Sample {
  const [gapS, prevCtx, ttlLong, ctx, input, read, write, w1h] = row;
  const ttl = ttlLong ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS;
  const n = continuationNumbers({
    now: gapS * 1000,
    lastTurnAt: 0,
    contextTokens: prevCtx,
    cacheTtlMs: ttl,
    windowTokens: null,
    baseTokens: 0,
    briefTokens: 0,
    expectedTurns: 1,
    orientationTurns: 0,
  });
  const fresh = Math.max(0, ctx - prevCtx) * writeRate(ttl);
  return {
    group: n.cacheWarm ? 'continue-warm' : 'continue-cold',
    predicted: n.continueCost,
    measured: promptCost(usage(input, read, write, w1h)) - fresh,
  };
}

export function freshSample(row: FreshRow, learned: Learned): Sample {
  const base = row[1] + row[2] + row[3];
  const ttl = row[4] > 0 ? CACHE_TTL_LONG_MS : CACHE_TTL_SHORT_MS;
  const n = continuationNumbers({
    now: 0,
    lastTurnAt: null,
    contextTokens: 0,
    cacheTtlMs: ttl,
    windowTokens: null,
    baseTokens: base,
    briefTokens: 0,
    expectedTurns: 1,
    orientationTurns: learned.orientationTurns,
    turnCost: learned.turnCostRatio * base,
  });
  return {
    group: 'fresh',
    predicted: n.freshCost,
    measured: promptCost(usage(row[5], row[6], row[7], row[8])),
  };
}

export interface OracleVerdict {
  verdict: 'proven' | 'not-proven' | 'failed';
  pairs: number;
  agreement: number;
  groups: { group: Sample['group']; n: number; p10: number; p90: number; covers: boolean }[];
  learned: Learned;
  reasons: string[];
}

export function judgeSamples(samples: readonly Sample[], learned: Learned): OracleVerdict {
  const groups = (['continue-warm', 'continue-cold', 'fresh'] as const).map((group) => {
    const ratios = samples
      .filter((s) => s.group === group && s.predicted > 0)
      .map((s) => s.measured / s.predicted);
    const p10 = quantile(ratios, 0.1) ?? 0;
    const p90 = quantile(ratios, 0.9) ?? 0;
    const covers =
      ratios.length < MIN_GROUP || (p10 <= 1 + SPREAD_TOLERANCE && p90 >= 1 - SPREAD_TOLERANCE);
    return { group, n: ratios.length, p10, p90, covers };
  });
  let pairs = 0;
  let agree = 0;
  for (let i = 0; i < samples.length; i += 1)
    for (let j = i + 1; j < samples.length; j += 1) {
      const a = samples[i] as Sample;
      const b = samples[j] as Sample;
      const hi = Math.max(a.measured, b.measured);
      if (hi <= 0 || Math.abs(a.measured - b.measured) < PAIR_GAP * hi) continue;
      pairs += 1;
      if (Math.sign(a.predicted - b.predicted) === Math.sign(a.measured - b.measured)) agree += 1;
    }
  const agreement = pairs === 0 ? 0 : agree / pairs;
  const reasons: string[] = [];
  for (const g of groups)
    if (!g.covers) reasons.push(`${g.group}: measured/predicted [${g.p10}, ${g.p90}] misses 1`);
  if (pairs >= MIN_PAIRS && agreement < MIN_RANK_AGREEMENT)
    reasons.push(`ranking agrees on ${agreement} of ${pairs} pairs`);
  let verdict: OracleVerdict['verdict'] = reasons.length > 0 ? 'failed' : 'proven';
  if (pairs < MIN_PAIRS) {
    verdict = 'not-proven';
    reasons.push(`only ${pairs} measured pairs (< ${MIN_PAIRS})`);
  }
  return { verdict, pairs, agreement, groups, learned, reasons };
}

/** Целиком: учёба на чётных строках новых сеансов, проверка на нечётных и на всех возвратах. */
export function judgeEcon(fixture: EconFixture): OracleVerdict {
  const train = fixture.fresh.filter((_, i) => i % 2 === 0);
  const test = fixture.fresh.filter((_, i) => i % 2 === 1);
  const learned = learnFresh(train);
  const samples = [
    ...fixture.resumes.map(resumeSample),
    ...test.map((r) => freshSample(r, learned)),
  ];
  return judgeSamples(samples, learned);
}
