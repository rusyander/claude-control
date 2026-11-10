import { z } from 'zod';
import { BOARD_STOPS } from './board.ts';
import { registryId, sha256Hex, uuidv7 } from './ids.ts';
import {
  HUMAN_ASK_SOURCES,
  JOURNAL_DATA_V1,
  LIMIT_KINDS,
  REPORT_POINTS,
  WINDOW_VERDICTS,
} from './journal-data.ts';
import { LEAD_PROFILES, TASK_CLASSES } from './lead.ts';
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
  /**
   * Ключ вопроса (`human.asked.dedupe`): у вопросов ведущего он различает карточку приёма
   * (`intake:<taskId>`) и класс (`classify:<taskId>`) одного источника `intake`. `null` — без ключа.
   */
  dedupe: z.string().nullable(),
  stepId: uuidv7.nullable(),
  lateAnswer: z.boolean(),
  answer: z.string().nullable(),
  /**
   * Этап 12 (P153): действие по умолчанию из `human.asked`; `null` — вопрос блокирует, и задача
   * «ждёт вас» (`contracts/core/waiting`). Ядро шлёт поле всегда; необязательно для видов до 12.
   */
  defaultAction: z.string().nullable().optional(),
  /**
   * Этап 12 (D29, P188): факты вопроса для карточки вне панели (бот Telegram): текст и варианты
   * из `human.asked`; цель отказа права (пункт 5) — проект единицы шага, путь и действие решения
   * `permit`, на которое ссылается вопрос; `answeredBy` — канал из `human.answered`.
   */
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  permit: z
    .strictObject({ project: z.string().min(1), target: z.string().min(1), op: z.string().min(1) })
    .optional(),
  answeredBy: z.string().min(1).optional(),
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

/**
 * Этап 12: задача ждёт окна (`waiting-window`) — последнее решение `tier`: вердикт, когда окно
 * откроется, и маршруты, на которые человек может перевести задачу кликом (`set-model`/`set-cli`).
 * Метки — как в журнале: `alternatives` `<adapter>/<kind>:<id>`, `skipped` `<kind>:<id>=<verdict>`.
 * Сама задача маршрут не меняет никогда (P155).
 */
export const windowWaitViewSchema = z.strictObject({
  stepId: uuidv7.nullable(),
  routeId: registryId,
  verdict: z.enum(WINDOW_VERDICTS),
  resetAt: nonNeg.nullable(),
  alternatives: z.array(z.string()),
  skipped: z.array(z.string()),
  /**
   * Начатая задача (P169): что человек может выбрать кликом — `cli:<переходник>` и `model:<id>`
   * (`tier.offers`). Окно её маршрут не двигает; нет — вариантов перевода нет.
   */
  offers: z.array(z.string()).optional(),
  seq: nonNeg,
});

/** Этап 12: MR единицы для карточки — личность из `publish.mr`, конец из `publish.mr-state`. */
export const mrViewSchema = z.strictObject({
  unitId: uuidv7,
  url: z.string().min(1),
  iid: nonNeg,
  title: z.string().optional(),
  state: z.enum(['opened', 'merged', 'closed']),
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
  /** Этап 11 (P135): класс задачи ведущего; нет — класс ещё не решён или задача не ведущего. */
  class: z.enum(TASK_CLASSES).optional(),
  /** Этап 11 (P144): профиль ведения задачи. */
  profile: z.enum(LEAD_PROFILES).optional(),
  groupId: z.string().min(1).max(200).optional(),
  /** Этап 11 (P135, W3-18): дочерняя задача XL — задача-родитель (`task.created.parentTaskId`). */
  parentTaskId: uuidv7.optional(),
  /**
   * Этап 11 (P141): шаг ждёт места сеанса — кто держит место и с каких пор. `holder.sessionId`
   * `null` — держатель ещё не открыл сеанс (место выдано, хост запускается).
   */
  waiting: z
    .strictObject({
      for: z.literal('session'),
      holder: z.strictObject({ taskId: uuidv7, sessionId: uuidv7.nullable() }),
      since: nonNeg,
    })
    .nullable()
    .optional(),
  /** Этап 12: ожидание окна с вариантами перевода; `null` — задача окна не ждёт. */
  windowWait: windowWaitViewSchema.nullable().optional(),
  /** Этап 12 (P157): где задача остановится; нет — задача не с доски и `set-stop` не было. */
  stop: z.enum(BOARD_STOPS).optional(),
  /** Этап 12: открытый перехват единицы человеком; `null` — перехвата нет. */
  takeover: z
    .strictObject({
      unitId: uuidv7,
      copy: z.string().min(1),
      seq: nonNeg,
      chatTaskId: uuidv7.optional(),
    })
    .nullable()
    .optional(),
  /**
   * Этап 12: эта задача — чат перехвата (`task.created.takeoverOf`): чья задача и какая единица.
   * Панель по нему усыновляет разговор в книгу чата — «Открыть чат» ведёт в этот разговор.
   */
  takeoverOf: z.strictObject({ taskId: uuidv7, unitId: uuidv7 }).optional(),
  /** Этап 12: MR единиц задачи; нет — ни одного MR не открыто. */
  mrs: z.array(mrViewSchema).optional(),
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
export type WindowWaitView = z.infer<typeof windowWaitViewSchema>;
export type MrView = z.infer<typeof mrViewSchema>;
