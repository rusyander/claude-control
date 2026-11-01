import type { ContinuationNumbers, ForcedFresh } from '@agentdeck/contracts/core/economy';
import { CONTEXT_FRESH_SHARE } from '../lib/context-share.ts';
import { RELATIVE_RATES, writeRate } from './cost.ts';
import type {
  ContinuationDecision,
  ContinuationFacts,
  ContinuationInput,
  ContinuationSession,
} from './continuation.types.ts';

/**
 * Продолжить живую сессию шага или начать новую (03:150-155): единственный судья класса
 * `continuation`. Числа — в каждом решении (P14). Цена продолжения — контекст по цене чтения
 * кэша (тёплый) или записи (остыл) на первом ходе, дальше чтение; цена нового — запись базового
 * контекста и вводной, ходы ориентации и те же ходы работы по меньшему контексту. При одном
 * ходе это ровно формула 03:151-152; на нескольких — тот же счёт без допущения, что каждый ход
 * переписывает кэш. Меньшая цена побеждает.
 *
 * Новый сеанс без выбора (P15): другой CLI, транскрипта нет, контекст больше 60 % окна модели,
 * единица в `done`/`conditional`/`closed` (сданная единица не продолжается новой работой, F07).
 * Смена маршрута — тоже новый сеанс, кэш считается холодным (P119). Возраст кэша — от стены
 * последнего хода сессии, срок — по доле часовой записи её ходов, иначе факт маршрута.
 */

const LIVE: ReadonlySet<ContinuationSession['state']> = new Set(['starting', 'live', 'quiet']);
/**
 * Кончившаяся сессия продолжается `--resume` по транскрипту: каждый конец шага останавливает
 * свою сессию, и без этого `same-session` на настоящем цикле не наступал бы никогда. Только при
 * транскрипте, известном на месте (`true`); потерянная (`lost`) — нет: её конец не дописан.
 */
const RESUMABLE: ReadonlySet<ContinuationSession['state']> = new Set(['ended']);
const CLOSED_UNIT: ReadonlySet<string> = new Set(['done', 'conditional', 'closed']);

const NO_FACTS: ContinuationFacts = {
  now: 0,
  lastTurnAt: null,
  contextTokens: 0,
  cacheTtlMs: null,
  windowTokens: null,
  baseTokens: 0,
  briefTokens: 0,
  expectedTurns: 1,
  orientationTurns: 0,
};

/** Числа правила для пары «эта сессия → новый сеанс»; `coldCache` — смена маршрута (P119). */
export function continuationNumbers(
  facts: ContinuationFacts,
  coldCache = false,
): ContinuationNumbers {
  const rates = facts.rates ?? RELATIVE_RATES;
  const cacheAgeMs = facts.lastTurnAt === null ? null : Math.max(0, facts.now - facts.lastTurnAt);
  const ttl = facts.cacheTtlMs;
  const cacheWarm = !coldCache && ttl !== null && cacheAgeMs !== null && cacheAgeMs < ttl;
  const turns = Math.max(1, facts.expectedTurns);
  const ctx = facts.contextTokens;
  const write = writeRate(ttl, rates);
  const continueCost = ctx * (cacheWarm ? rates.read : write) + (turns - 1) * ctx * rates.read;
  const fresh = facts.baseTokens + facts.briefTokens;
  // Ход ориентации читает файлы и растит контекст: его цена — выученная, иначе чтение базы.
  const turnCost = facts.turnCost ?? fresh * rates.read;
  const freshCost =
    fresh * write + facts.orientationTurns * turnCost + (turns - 1) * fresh * rates.read;
  return {
    contextTokens: ctx,
    cacheWarm,
    cacheAgeMs,
    expectedTurns: turns,
    continueCost: Math.round(continueCost),
    freshCost: Math.round(freshCost),
    baseTokens: facts.baseTokens,
    briefTokens: facts.briefTokens,
    orientationTurns: facts.orientationTurns,
    windowTokens: facts.windowTokens ?? 0,
  };
}

/** Числа решения как запись `decision.numbers` (только числа: флаги — 0/1). */
export function numbersRecord(n: ContinuationNumbers): Record<string, number> {
  const { cacheWarm, cacheAgeMs, forced: _forced, ...rest } = n;
  return { ...rest, cacheWarm: cacheWarm ? 1 : 0, cacheAgeMs: cacheAgeMs ?? -1 };
}

function forcedOf(
  input: ContinuationInput,
  live: ContinuationSession,
  facts: ContinuationFacts,
): { forced: ForcedFresh; why: string } | null {
  if (input.unitState && CLOSED_UNIT.has(input.unitState))
    return { forced: 'unit-closed', why: `unit is ${input.unitState}: never continued` };
  if (live.adapter !== input.next.adapter)
    return {
      forced: 'other-cli',
      why: `session ${live.sessionId} runs ${live.adapter}, the step now asks ${input.next.adapter}`,
    };
  if (input.transcriptPresent === false)
    return { forced: 'transcript-missing', why: `session ${live.sessionId} has no transcript` };
  const window = facts.windowTokens;
  if (window !== null && window > 0 && facts.contextTokens > CONTEXT_FRESH_SHARE * window)
    return {
      forced: 'context-over-60',
      why: `context ${facts.contextTokens} > ${CONTEXT_FRESH_SHARE * 100}% of window ${window}`,
    };
  return null;
}

export function decideContinuation(input: ContinuationInput): ContinuationDecision {
  const basis = 'modelled' as const;
  const facts = input.facts ?? NO_FACTS;
  const measured = input.facts ? [] : ['no usage measured yet: numbers are zero'];
  const resumable = (s: ContinuationSession): boolean =>
    LIVE.has(s.state) || (input.transcriptPresent === true && RESUMABLE.has(s.state));
  const live = input.sessions
    .filter((s) => s.stepDefId === input.stepDefId && resumable(s))
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
  if (!live)
    return {
      mode: 'fresh',
      reason: 'no-live-session',
      reasons: [`no live session of step ${input.stepDefId}`, ...measured],
      numbers: continuationNumbers(facts, true),
      basis,
    };
  const forced = forcedOf(input, live, facts);
  if (forced)
    return {
      mode: 'fresh',
      reason: forced.forced,
      reasons: [`forced fresh (${forced.forced}): ${forced.why}`, ...measured],
      numbers: { ...continuationNumbers(facts, true), forced: forced.forced },
      basis,
    };
  const { next } = input;
  if (live.route.kind !== next.route.kind || live.route.id !== next.route.id)
    return {
      mode: 'fresh',
      reason: 'route-changed',
      reasons: [
        `session ${live.sessionId} goes over ${live.route.kind}:${live.route.id}, the step now asks ${next.route.kind}:${next.route.id}; its cache counts cold`,
        ...measured,
      ],
      numbers: continuationNumbers(facts, true),
      basis,
    };
  const numbers = continuationNumbers(facts);
  const costs = `continue ${numbers.continueCost} vs fresh ${numbers.freshCost} (cache ${numbers.cacheWarm ? 'warm' : 'cold'})`;
  if (numbers.continueCost > numbers.freshCost)
    return {
      mode: 'fresh',
      reason: 'cheaper-fresh',
      reasons: [`fresh is cheaper: ${costs}`, ...measured],
      numbers,
      basis,
    };
  return {
    mode: 'same-session',
    sessionId: live.sessionId,
    reasons: [
      `session ${live.sessionId} of step ${input.stepDefId} is ${live.state} on the same route; ${costs}`,
      ...measured,
    ],
    numbers,
    basis,
  };
}
