import type { OverBudget } from '@agentdeck/contracts/core/scenario';
import type { LearnedStats } from '../learned/learned.types.ts';

export type BudgetSource = 'scenario' | 'learned' | 'none';

export interface BudgetInput {
  /** Область строки `budget.state`: `step:<id>`, `task:<id>`. */
  scope: string;
  /** Бюджет шага из сценария (`StepDef.budget`). */
  scenario: { tokens?: number; minutes?: number };
  /** Выученное этого ключа (или вида шага проекта); `null` — прогонов не было. */
  learned: LearnedStats | null;
  /** Потрачено: токены бюджета (G10) и активные мс (`activeElapsed`, сон не в счёт). */
  used: { tokens: number; activeMs: number };
  overBudget: OverBudget;
}

export interface BudgetLimit {
  value: number | null;
  source: BudgetSource;
}

export interface BudgetDecision {
  scope: string;
  limits: { tokens: BudgetLimit; minutes: BudgetLimit };
  used: { tokens: number; minutes: number };
  /** Какие пределы пройдены; пусто — в бюджете. */
  over: ('tokens' | 'minutes')[];
  /** Что делать при перерасходе (`overBudget` сценария); `null` — в бюджете. */
  action: OverBudget | null;
  reasons: string[];
  numbers: Record<string, number>;
}
