import { z } from 'zod';
import { uuidv7 } from './ids.ts';
import { REPORT_POINTS, REQUIREMENT_VERDICTS } from './journal-data.ts';

/**
 * Итоговый отчёт задачи (00 §Words «Final report», 06:28, P96): единицы, требования с
 * доказательствами, развилки, решённые по умолчанию, непроверенное, остатки и предложения.
 * Тело ложится артефактом по sha256, в журнале — `report.final` со ссылкой.
 */

const line = (max: number) => z.string().min(1).max(max);
const whatWhy = z.strictObject({ what: line(2000), why: line(2000) });

export const FINAL_REPORT_SUGGESTIONS = [
  'un-quarantine',
  'register-check',
  'coverage-gap',
  'profile-moved',
  'ownership',
  'late-answer',
] as const;
export type FinalReportSuggestion = (typeof FINAL_REPORT_SUGGESTIONS)[number];

export const finalReportSchema = z.strictObject({
  taskId: uuidv7,
  at: z.enum(REPORT_POINTS),
  outcome: z.enum(['done', 'cancelled', 'failed', 'ready-to-publish']),
  units: z.array(
    z.strictObject({
      unitId: uuidv7,
      name: line(200),
      state: z.string().min(1),
      branch: z.string(),
    }),
  ),
  requirements: z.array(
    z.strictObject({
      requirementId: uuidv7,
      ordinal: z.number().int().positive(),
      text: z.string().max(16_000),
      verdict: z.enum(REQUIREMENT_VERDICTS),
      evidence: z.array(z.string()),
    }),
  ),
  /**
   * Вопросы вне списка (решение `human-point` с `point: null`), `step_done.forks` и умолчания
   * самого ядра (основание `not-modelled…`).
   */
  forks: z.array(
    z.strictObject({
      stepId: uuidv7.nullable(),
      source: z.enum(['step_done', 'ask_human', 'blocker', 'core']),
      question: line(2000),
      options: z.array(line(300)),
      chosen: line(300),
      reason: z.string().max(1000),
    }),
  ),
  unverified: z.array(whatWhy),
  residuals: z.array(whatWhy),
  suggestions: z.array(
    z.strictObject({ kind: z.enum(FINAL_REPORT_SUGGESTIONS), detail: line(2000) }),
  ),
  lateAnswers: z.array(z.strictObject({ askId: uuidv7, delivered: z.boolean() })),
});
export type FinalReport = z.infer<typeof finalReportSchema>;
