import { journalLines, type SelftestPair } from '../../__fixtures__/selftest.ts';
import { sessionStarted as started, usage } from '../../integrity/__fixtures__/selftests.ts';
import { SPEND_OVER_ESTIMATE_SIGNAL } from '../spend-over-estimate.ts';
import { S1, STEP } from './ids.ts';

/** Сессия шага пар расточительства: вердикт называет их шаг и сессию, как у всех пар зоны. */
export const sessionStarted = (sessionId: string) => {
  const row = started(sessionId);
  return { ...row, stepId: STEP, data: { ...row.data, stepId: STEP } };
};

/**
 * Пара самопроверки «расход сверх оценки» (этап 11, F3): оценка запуска по истории с верхней
 * границей 10 000 токенов бюджета; расход 21 000 (> 2×) — сигнал, 19 000 — тишина. Строка
 * расхода делится на вход/чтение/запись кэша так, что токены бюджета = вход + запись + выход.
 */

export const ESTIMATE_UPPER = 10_000;

export const estimateRow = (basis: 'history' | 'no-history', upper = ESTIMATE_UPPER) => ({
  kind: 'signal' as const,
  data: {
    signal: 'estimate-history',
    severity: 'info',
    subject: 'estimate',
    detail: JSON.stringify(
      basis === 'history'
        ? { minutes: 5, tokens: upper / 2, spread: [upper / 4, upper], basis }
        : { minutes: null, tokens: null, spread: null, basis },
    ),
  },
});

/**
 * Строка расхода с ровно `budget` токенами бюджета: вход = budget − 500, выход 500, запись
 * кэша 0 (чтение кэша — не бюджет).
 */
export const budgetUsage = (messageId: string, budget: number) => {
  const row = usage(S1, 0, { messageId });
  return {
    ...row,
    data: { ...row.data, input: budget - 500, cacheRead: 50_000, cacheWrite: 0, output: 500 },
  };
};

export const SPEND_OVER = journalLines([
  estimateRow('history'),
  sessionStarted(S1),
  budgetUsage('m-1', 12_000),
  budgetUsage('m-2', 9_000),
]);
/** Почти-двойник: тот же ход, расход 19 000 — ниже 2× верхней границы. */
export const SPEND_UNDER = journalLines([
  estimateRow('history'),
  sessionStarted(S1),
  budgetUsage('m-1', 12_000),
  budgetUsage('m-2', 7_000),
]);

export const SPEND_SELFTESTS: SelftestPair[] = [
  { signal: SPEND_OVER_ESTIMATE_SIGNAL, fires: SPEND_OVER, silent: SPEND_UNDER },
];
