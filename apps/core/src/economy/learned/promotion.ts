import type {
  FirstPassSample,
  LearnedRaise,
  LearnedRaiseQuery,
} from '@agentdeck/contracts/core/economy';
import type { Promotion } from '@agentdeck/contracts/core/lead';
import { keyOf } from './derive.ts';
import type { LearnedTable } from './learned.types.ts';

/**
 * Подъём по обучению (этап 11, F1, P140) — заменяет `lowerFailed`. Пробы первого прохода ключа
 * идут по времени; окно — последние `window` проб с последнего подъёма (или сброса). Проб в окне
 * не меньше `minSamples` и доля первого прохода НИЖЕ `threshold` — ключ поднят на одну ступень,
 * доказательство — id проб окна, окно начинается заново. Так подъёмы цепляются по ступени за
 * новое окно; потолок (Opus xhigh) держит суд `tier`. Обратного хода нет: проходы после подъёма
 * его не снимают — снимает только сброс человека (`learned-reset`).
 */

export interface PromotionOutcome {
  rungs: number;
  /** id проб окна последнего подъёма; подъёма нет — пусто. */
  evidence: string[];
  /** Доля первого прохода в текущем окне (после последнего подъёма); проб нет — `null`. */
  rate: number | null;
  /** Проб в текущем окне. */
  samples: number;
}

const rateOf = (xs: readonly FirstPassSample[]): number | null =>
  xs.length === 0 ? null : xs.filter((s) => s.passed).length / xs.length;

export function promotionOf(
  samples: readonly FirstPassSample[],
  promotion: Promotion,
): PromotionOutcome {
  let start = 0;
  let rungs = 0;
  let evidence: string[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const window = samples.slice(Math.max(start, i + 1 - promotion.window), i + 1);
    if (window.length < promotion.minSamples) continue;
    const rate = rateOf(window) as number;
    if (rate >= promotion.threshold) continue;
    rungs += 1;
    evidence = window.map((s) => s.sampleId);
    start = i + 1;
  }
  const current = samples.slice(Math.max(start, samples.length - promotion.window));
  return { rungs, evidence, rate: rateOf(current), samples: current.length };
}

/**
 * Подъём ключа для суда `tier`: по ключу с классом задачи, если проб этого класса не меньше
 * `minSamples`, иначе по ключу целиком. Проб нет — `null` (поднимать не по чему).
 */
export function learnedRaiseOf(
  table: LearnedTable,
  query: LearnedRaiseQuery,
  promotion: Promotion,
): LearnedRaise | null {
  const all = table.firstPass?.[keyOf(query.key)] ?? [];
  if (all.length === 0) return null;
  const ofClass = query.class === null ? [] : all.filter((s) => s.class === query.class);
  const byClass = ofClass.length >= promotion.minSamples;
  const got = promotionOf(byClass ? ofClass : all, promotion);
  return {
    rungs: got.rungs,
    evidence: got.evidence,
    rate: got.rate,
    samples: got.samples,
    basis: byClass ? 'key+class' : 'key',
  };
}
