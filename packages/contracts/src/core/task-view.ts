import { z } from 'zod';
import { registryId, sha256Hex, uuidv7 } from './ids.ts';
import {
  HUMAN_ASK_SOURCES,
  JOURNAL_DATA_V1,
  LIMIT_KINDS,
  REPORT_POINTS,
  WINDOW_VERDICTS,
} from './journal-data.ts';
import { routeSchema } from './route-schema.ts';
import { scenarioRefSchema } from './scenario.ts';
import { ASK_STATES, SESSION_STATES, STEP_STATES, TASK_STATES } from './states.ts';

/**
 * Вид задачи для панели (07:18-22, этап 9): одна свёртка журнала в то, что показывают лента,
 * бюджеты и отчёт. Собирает её ТОЛЬКО ядро (`api/task-view.ts`), панель её не пересчитывает:
 * расход — тем же `spendOf`, что считает экономика (P43, одна реализация), иначе числа на экране
 * разойдутся с решениями ядра. Схема строгая: лишнее поле — ошибка разбора у панели, а не тихо
 * проглоченная новая форма.
 */

const nonNeg = z.number().int().nonnegative();
const money = z.number().nonnegative();

export const CHECK_VIEW_MODES = ['run', 'replay', 'narrow'] as const;
export type CheckViewMode = (typeof CHECK_VIEW_MODES)[number];

/** Токены по видам — как `UsageTotals` свёртки (деньги отдельно, P127). */
export const usageViewSchema = z.strictObject({
  input: nonNeg,
  cacheRead: nonNeg,
  cacheWrite: nonNeg,
  cacheWrite1h: nonNeg,
  output: nonNeg,
  turns: nonNeg,
});

/** Итог `spendOf`: деньги, единицы окна и токены без цены не складываются в одну сумму. */
export const costViewSchema = z.strictObject({
  usd: money,
  windowUnits: z.number().nonnegative(),
  unpricedTokens: nonNeg,
  /** Версия прайса → ходов ею оценено: видно, какой ценой посчитан расход. */
  versions: z.record(z.string(), nonNeg),
  turns: nonNeg,
});

const spendPartSchema = z.strictObject({ tokens: usageViewSchema, cost: costViewSchema });

export const stepViewSchema = z.strictObject({
  stepId: uuidv7,
  unitId: uuidv7,
  stepKind: registryId,
  stepDefId: z.string().min(1),
  round: nonNeg,
  state: z.enum(STEP_STATES),
  startedSeq: nonNeg,
  budgetMs: nonNeg,
  outcome: z.enum(['done', 'failed', 'skipped']).nullable(),
  reason: z.string().nullable(),
});

export const sessionViewSchema = z.strictObject({
  sessionId: uuidv7,
  stepId: uuidv7,
  state: z.enum(SESSION_STATES),
  /** Переходник CLI и его версия из `session.started` (`null` — строка версии пуста). */
  cli: registryId,
  cliVersion: z.string().nullable(),
  route: routeSchema,
  /** `null` — модель по умолчанию CLI (`--model` не передан). */
  modelAsked: registryId.nullable(),
  modelServed: registryId.nullable(),
  effort: registryId.nullable(),
  startedSeq: nonNeg,
});

export const checkViewSchema = z.strictObject({
  decisionId: uuidv7,
  seq: nonNeg,
  stepId: uuidv7.nullable(),
  mode: z.enum(CHECK_VIEW_MODES),
  /** Почему так (причина решения или заголовок записи повтора) — английской прозой ядра, дословно. */
  why: z.string(),
  /** Запись, на которой стоит вердикт: у повтора — сразу, у прогона — когда он записан. */
  recordId: z.string().min(1).nullable(),
});

export const askViewSchema = z.strictObject({
  askId: uuidv7,
  state: z.enum(ASK_STATES),
  point: nonNeg,
  source: z.enum(HUMAN_ASK_SOURCES),
  stepId: uuidv7.nullable(),
  lateAnswer: z.boolean(),
  answer: z.string().nullable(),
});

export const budgetViewSchema = z.strictObject({
  scope: z.string().min(1),
  spent: nonNeg,
  limit: nonNeg.nullable(),
  seq: nonNeg,
});

export const windowViewSchema = z.strictObject({
  routeId: registryId,
  limitKind: z.enum(LIMIT_KINDS),
  verdict: z.enum(WINDOW_VERDICTS),
  resetAt: nonNeg.nullable(),
  seq: nonNeg,
});

/** Ссылка на итоговый отчёт: тело — артефакт по sha256 (`GET /v1/tasks/:id/report`). */
export const reportRefSchema = z.strictObject({
  seq: nonNeg,
  at: z.enum(REPORT_POINTS),
  sha256: sha256Hex,
  bytes: nonNeg,
});

/**
 * Сценарий задачи: действующая версия и правка, ждущая своей точки (`edit-scenario`, 02). Редактор
 * панели строит черновик от `pending.to`, если правка ждёт, иначе от `ref`.
 */
export const scenarioViewSchema = z.strictObject({
  ref: scenarioRefSchema,
  pending: z.strictObject({ to: scenarioRefSchema, applyNow: z.boolean() }).nullable(),
});

const splitProposed = JOURNAL_DATA_V1['split.proposed'];

/** Последнее предложенное деление и его решение (`split.proposed` → `split.decided`). */
export const splitViewSchema = z.strictObject({
  splitId: uuidv7,
  seq: nonNeg,
  by: splitProposed.shape.by,
  state: z.enum(['proposed', ...JOURNAL_DATA_V1['split.decided'].shape.outcome.options]),
  units: splitProposed.shape.units,
});

export const taskViewSchema = z.strictObject({
  taskId: uuidv7,
  seq: nonNeg,
  state: z.enum(TASK_STATES),
  ended: z.enum(['done', 'cancelled', 'failed']).nullable(),
  steps: z.array(stepViewSchema),
  sessions: z.array(sessionViewSchema),
  checks: z.array(checkViewSchema),
  asks: z.array(askViewSchema),
  budgets: z.array(budgetViewSchema),
  windows: z.array(windowViewSchema),
  spend: z.strictObject({
    tokens: usageViewSchema,
    cost: costViewSchema,
    bySession: z.record(uuidv7, spendPartSchema),
    byStep: z.record(uuidv7, spendPartSchema),
  }),
  report: reportRefSchema.nullable(),
  /** `null` — сценарий ещё не выбран (задача в черновике до первого шага). */
  scenario: scenarioViewSchema.nullable(),
  /** `null` — деления не предлагали. */
  split: splitViewSchema.nullable(),
  /** Что ждёт человека (живой исполнитель задачи), `null` — ничего или задача не исполняется. */
  attention: z.string().nullable(),
});

export type UsageView = z.infer<typeof usageViewSchema>;
export type CostView = z.infer<typeof costViewSchema>;
export type StepView = z.infer<typeof stepViewSchema>;
export type SessionView = z.infer<typeof sessionViewSchema>;
export type CheckView = z.infer<typeof checkViewSchema>;
export type AskView = z.infer<typeof askViewSchema>;
export type BudgetView = z.infer<typeof budgetViewSchema>;
export type WindowView = z.infer<typeof windowViewSchema>;
export type ReportRef = z.infer<typeof reportRefSchema>;
export type ScenarioView = z.infer<typeof scenarioViewSchema>;
export type SplitView = z.infer<typeof splitViewSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
