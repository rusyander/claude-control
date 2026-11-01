import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import { type UsageLike, budgetTokens } from '../cost.ts';
import type { BudgetDecision, BudgetInput, BudgetLimit } from './budget.types.ts';

/**
 * Бюджеты (03 §Economy, G10): шаг — из сценария, иначе выученный p90 × 1.5; токены бюджета —
 * вход + запись кэша + выход (чтение кэша — расход, не бюджет), минуты — активное время (сон
 * машины не в счёт, `activeElapsed`). Перерасход — действие `overBudget` сценария; точка 7
 * остаётся за циклом. Число единиц разбиения — по полной цене единицы с её базовым контекстом,
 * никогда по числу пунктов (03:163).
 */

/** Запас над p90 прошлых прогонов (03:156). */
export const LEARNED_BUDGET_FACTOR = 1.5;

function limitOf(scenario: number | undefined, learnedP90: number | null): BudgetLimit {
  if (scenario !== undefined) return { value: scenario, source: 'scenario' };
  if (learnedP90 !== null && learnedP90 > 0)
    return { value: Math.ceil(learnedP90 * LEARNED_BUDGET_FACTOR), source: 'learned' };
  return { value: null, source: 'none' };
}

export function decideBudget(input: BudgetInput): BudgetDecision {
  const learned = input.learned && input.learned.runs > 0 ? input.learned : null;
  const tokens = limitOf(input.scenario.tokens, learned?.p90Tokens ?? null);
  const minutes = limitOf(input.scenario.minutes, learned?.p90Minutes ?? null);
  const used = { tokens: input.used.tokens, minutes: input.used.activeMs / 60_000 };
  const over: BudgetDecision['over'] = [];
  if (tokens.value !== null && used.tokens > tokens.value) over.push('tokens');
  if (minutes.value !== null && used.minutes > minutes.value) over.push('minutes');
  const reasons = [
    `tokens ${used.tokens} of ${tokens.value ?? 'no limit'} (${tokens.source})`,
    `minutes ${used.minutes.toFixed(1)} of ${minutes.value ?? 'no limit'} (${minutes.source})`,
  ];
  if (over.length > 0) reasons.push(`over budget (${over.join(', ')}): ${input.overBudget}`);
  return {
    scope: input.scope,
    limits: { tokens, minutes },
    used,
    over,
    action: over.length > 0 ? input.overBudget : null,
    reasons,
    numbers: {
      tokensUsed: used.tokens,
      tokensLimit: tokens.value ?? -1,
      minutesUsed: Math.round(used.minutes * 10) / 10,
      minutesLimit: minutes.value ?? -1,
      factor: LEARNED_BUDGET_FACTOR,
    },
  };
}

/**
 * Префикс области токенов в `budget.state` (G10). Голая `step:<id>` — область СРОКА шага: свёртка
 * этапа 4 читает её `limit` как минуты (`STEP_BUDGET_SCOPE`), и строка токенов под ней сдвинула бы
 * срок шага на число токенов. Одна запись области токенов — здесь; исполнитель и читатели берут её.
 */
export const TOKEN_SCOPE_PREFIX = 'tokens:';

/** Область токенов для области решения (`step:<id>` → `tokens:step:<id>`). */
export const tokenScopeOf = (scope: string): string => `${TOKEN_SCOPE_PREFIX}${scope}`;

/** Строка `budget.state` по токенам (в журнал — только при изменении решения задачи). */
export function budgetState(d: BudgetDecision): JournalDataV1['budget.state'] {
  return { scope: tokenScopeOf(d.scope), spent: d.used.tokens, limit: d.limits.tokens.value };
}

/** Токены бюджета набора ходов: повтор по messageId уже заменён свёрткой (сюда — последние). */
export function spentTokens(usage: Iterable<UsageLike>): number {
  let sum = 0;
  for (const u of usage) sum += budgetTokens(u);
  return sum;
}

export interface TaskTotals {
  tokens: number;
  minutes: number;
  sessions: number;
  steps: number;
}

/** Итоги задачи: шаги (с подагентами), сеансы, токены и активные минуты. */
export function taskTotals(
  steps: readonly { tokens: number; activeMs: number }[],
  sessions: number,
): TaskTotals {
  return {
    tokens: steps.reduce((s, x) => s + x.tokens, 0),
    minutes: steps.reduce((s, x) => s + x.activeMs, 0) / 60_000,
    sessions,
    steps: steps.length,
  };
}

/** Цена единицы разбиения: её работа плюс базовый контекст её сеанса (G9). */
export function unitCost(workTokens: number, baseTokens: number): number {
  return workTokens + baseTokens;
}

/**
 * Число единиц по цене (03:163): наименьшее n, при котором доля работы плюс база каждой единицы
 * укладывается в предел единицы. База не делится — она платится каждой единицей заново,
 * поэтому дробить мелко дороже. Предел недостижим даже при `maxUnits` — `null`.
 */
export function unitCountByCost(input: {
  workTokens: number;
  baseTokens: number;
  unitCapTokens: number;
  maxUnits: number;
}): { units: number; totalTokens: number } | null {
  for (let n = 1; n <= input.maxUnits; n += 1)
    if (unitCost(input.workTokens / n, input.baseTokens) <= input.unitCapTokens)
      return { units: n, totalTokens: Math.round(input.workTokens + n * input.baseTokens) };
  return null;
}
