import { WINDOW_VERDICTS } from './journal-data.ts';
import type { LeadRole, TaskClass } from './lead.ts';
import type { LimitKind, ModelId, RouteId } from './routes.ts';

/**
 * Экономика шага (03 §Economy, 11 §Economy, фаза 5). Здесь только ТИПЫ и закрытые списки: судьи
 * живут в `apps/core/src/economy/` (окно, модель, продолжение, бюджет, прогрев), числа каждого
 * решения пишутся общим событием `decision` (`numbers`) — нового вида события на класс нет.
 */

/** Класс шага для таблицы окна (03:157-160): что откладывается на тесном окне, а что идёт всегда. */
export const STEP_CLASSES = [
  'work',
  'review',
  'background',
  'fix',
  'final-gate',
  'publish',
] as const;
export type StepClass = (typeof STEP_CLASSES)[number];

/** Откуда пришёл факт предела: событие CLI, заголовок ответа звена, ответ отказа, собственный счёт. */
export const LIMIT_FACT_SOURCES = ['cli-event', 'hop-header', 'refusal', 'core-count'] as const;
export type LimitFactSource = (typeof LIMIT_FACT_SOURCES)[number];

/** Факт предела на пару (маршрут, вид предела); `usedPct` `null` — источник процента не даёт. */
export interface LimitFact {
  routeId: RouteId;
  limitKind: LimitKind;
  usedPct: number | null;
  resetAt: number | null;
  /** Маршрут уже отказал по этому пределу (не предупреждение): держит, пока не сброшен. */
  refusal: boolean;
  /** CLI сказал «близко», но обслуживает: не отказ и не доля, держать нечего (P19). */
  warning?: boolean;
  source: LimitFactSource;
  /** Время наблюдения факта (стена, мс). */
  at: number;
}

/**
 * Вердикт окна: `warn` ничего не держит (P19), `refused` и `held` держат классы из `defer`,
 * `exhausted` (402) снимает только человек командой `clear-exhausted` (P122), `offline` — сеть
 * до маршрута недоступна (P116).
 */
export { WINDOW_VERDICTS };
export type WindowVerdict = (typeof WINDOW_VERDICTS)[number];

export interface WindowDecision {
  routeId: RouteId;
  limitKind: LimitKind;
  verdict: WindowVerdict;
  /** Классы шагов, которые ждут; пусто — идут все. `fix`, `final-gate`, `publish` сюда не попадают. */
  defer: StepClass[];
  resumeAt: number | null;
  reasons: string[];
}

/** Почему продолжение запрещено числами не по выбору, а по факту (P15). */
export const FORCED_FRESH = [
  'other-cli',
  'transcript-missing',
  'context-over-60',
  'unit-closed',
] as const;
export type ForcedFresh = (typeof FORCED_FRESH)[number];

/** Числа правила продолжения (03:150-155): решение `continuation` пишет их в `decision.numbers`. */
export interface ContinuationNumbers {
  contextTokens: number;
  cacheWarm: boolean;
  cacheAgeMs: number | null;
  expectedTurns: number;
  continueCost: number;
  freshCost: number;
  baseTokens: number;
  briefTokens: number;
  orientationTurns: number;
  windowTokens: number;
  forced?: ForcedFresh;
}

/** Основание решения о модели: с фазы 5 уровень сценария моделируется. */
export type TierBasis = 'modelled';

/** Ключ выученного (03 §Economy): неудача на меньшей модели помнится по этой пятёрке. */
export interface LearnedKey {
  project: string;
  stepKind: string;
  adapter: string;
  route: RouteId;
  model: ModelId | null;
  /** Этап 11 (P140): роль ведущего; нет — роль по умолчанию вида шага (строки `learned.json` v2). */
  role?: LeadRole;
}

/**
 * Проба первого прохода (этап 11, P140): узкая проверка куска зелёная с первой попытки на ступени
 * `rung`. `sampleId` — id шага, по которому проба снята: доказательство подъёма называет их.
 */
export interface FirstPassSample {
  sampleId: string;
  at: number;
  passed: boolean;
  rung: string;
  class: TaskClass | null;
}

/** Вход подъёма по обучению (`TierInput.learnedRaise`): ключ и класс задачи для отката по классу. */
export interface LearnedRaiseQuery {
  key: LearnedKey;
  class: TaskClass | null;
}

/**
 * Подъём по обучению: на сколько ступеней ключ уже поднят (одна за окно доказательств, не выше
 * потолка) и чем это доказано. `basis` — по ключу с классом (проб ≥ minSamples) или по ключу.
 */
export interface LearnedRaise {
  rungs: number;
  evidence: string[];
  rate: number | null;
  samples: number;
  basis: 'key+class' | 'key';
}

/** Основание чисел оценки: история прогонов есть — числа и разброс; нет — числа `null`. */
export const ESTIMATE_BASES = ['history', 'no-history'] as const;
export type EstimateBasis = (typeof ESTIMATE_BASES)[number];
