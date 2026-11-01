import { z } from 'zod';
import { commandIssues, commandProofSchema, type CommandIssue } from './commands.ts';
import type { EstimateBasis } from './economy.ts';
import { uuidv7 } from './ids.ts';
import { LAUNCH_POLICIES } from './journal-data.ts';
import { PRESET_IDS, scenarioRefSchema, type OverlayEntry, type ScenarioRef } from './scenario.ts';
import type { GrantConfirmation, UserLayerReport } from './user-layer.ts';

/**
 * Оценка = создание задачи (07:7, G5): `POST /v1/estimate`. Суд полномочий первым, id задачи
 * выдаёт ядро, `task.created.origin.cmdId` — ключ повтора (тот же `cmdId` находит задачу, второй
 * не создаёт). Единицы и цена приходят состоянием задачи и SSE: план — это сессия, не ответ ручки.
 */

const line = (max: number) => z.string().min(1).max(max);

export const estimateFieldsSchema = z.strictObject({
  title: line(300),
  /** Источник требований, хранится артефактом (02:54). */
  request: z.string().min(1).max(64_000),
  repos: z
    .array(z.strictObject({ path: line(1000), baseRef: line(300).nullable() }))
    .min(1)
    .max(8),
  scenario: z.union([scenarioRefSchema, z.strictObject({ preset: z.enum(PRESET_IDS) })]),
  launchPolicy: z.enum(LAUNCH_POLICIES),
  /** Ждать ли CI — живое решение человека для этой задачи (R:S1-09). */
  ciWait: z.boolean(),
});
export type EstimateFields = z.infer<typeof estimateFieldsSchema>;

/** Тело `POST /v1/estimate`; `proof` — тот же, что у команды (число страницы, подпись устройства). */
export const estimateBodySchema = z.strictObject({
  cmdId: uuidv7,
  fields: estimateFieldsSchema,
  proof: commandProofSchema,
});
export type EstimateBody = z.infer<typeof estimateBodySchema>;

/** Разбор тела оценки: ошибка — список проблем с путём, как у команды (400, P42). */
export function parseEstimateBody(
  input: unknown,
): { ok: true; body: EstimateBody } | { ok: false; issues: CommandIssue[] } {
  const parsed = estimateBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: commandIssues(parsed.error.issues, '', input) };
  return { ok: true, body: parsed.data };
}

export const PREFLIGHT_STATUS = ['ok', 'failed', 'not-checked'] as const;
export type PreflightStatus = (typeof PREFLIGHT_STATUS)[number];

export interface EstimateReply {
  taskId: string;
  seq: number;
  /** `refused` — дорога предпроверки упала или сценарий/правка негодны: задача есть, ничего не идёт. */
  state: 'estimating' | 'refused';
  replayed: boolean;
  preflight: { road: string; status: PreflightStatus; detail: string }[];
  overlay: { rejected: OverlayEntry[] };
  scenario: ScenarioRef | null;
  problems: string[];
  /**
   * Числа из истории прогонов (03 §Economy): `history` — оценка и разброс [p10, p90] в токенах;
   * `no-history` — истории нет, числа `null`, а не выдуманные.
   */
  estimate: {
    minutes: number | null;
    tokens: number | null;
    spread: [number, number] | null;
    basis: EstimateBasis;
  };
  /** Слой пользователя на экране запуска (07:23-24): опись, режимы, подмены, предупреждения. */
  userLayer: UserLayerReport;
  /** Гранты, которые человек подтверждает до запуска (06:108-112); нет — пусто. */
  grants: GrantConfirmation[];
}
