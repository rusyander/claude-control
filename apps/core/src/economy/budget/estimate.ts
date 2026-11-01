import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import { quantile } from '../cost.ts';
import type { LearnedTable, TaskSample } from '../learned/learned.types.ts';

/**
 * Оценка до запуска из истории (03:157 «pre-launch estimate from history with its spread»):
 * прошлые задачи того же сценария — сначала в тех же проектах, при нехватке — в любых. Числа —
 * медиана, разброс [p10, p90] токенов бюджета; минуты — медиана активного времени. Отменённые
 * задачи не в счёт (их расход оборван). Истории нет — `no-history` с `null`, а не выдумка.
 */

/** Меньше образцов в проекте — берётся весь сценарий. */
export const ESTIMATE_MIN_SAMPLES = 3;

export interface EstimateQuery {
  scenarioId: string | null;
  projects: readonly string[];
}

const NONE: EstimateReply['estimate'] = {
  minutes: null,
  tokens: null,
  spread: null,
  basis: 'no-history',
};

export function estimateFromHistory(
  table: LearnedTable,
  query: EstimateQuery,
): EstimateReply['estimate'] {
  const finished = table.tasks.filter(
    (t) => t.outcome !== 'cancelled' && t.scenarioId === query.scenarioId && t.tokens > 0,
  );
  const inProject = finished.filter((t) => t.projects.some((p) => query.projects.includes(p)));
  const pool: TaskSample[] = inProject.length >= ESTIMATE_MIN_SAMPLES ? inProject : finished;
  if (pool.length === 0) return NONE;
  const tokens = pool.map((t) => t.tokens);
  const minutes = pool.map((t) => t.activeMs / 60_000);
  return {
    tokens: quantile(tokens, 0.5),
    minutes: Math.round((quantile(minutes, 0.5) as number) * 10) / 10,
    spread: [quantile(tokens, 0.1) as number, quantile(tokens, 0.9) as number],
    basis: 'history',
  };
}
