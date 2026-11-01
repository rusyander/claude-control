import type { REPORT_POINTS } from '@agentdeck/contracts/core/journal';

export type ReportPoint = (typeof REPORT_POINTS)[number];

/** Чем кончилась задача на точке отчёта: `ended` — исход задачи, иначе — готова к публикации. */
export interface ReportInput {
  taskId: string;
  at: ReportPoint;
  /** Исход `task.ended`; на `ready-to-publish` не нужен. */
  ended: 'done' | 'cancelled' | 'failed' | null;
}

export type WriteReportOutcome =
  | { kind: 'written'; sha256: string; bytes: number; seq: number }
  /** Отчёт на этой точке уже есть: второй не пишется (повтор крючка после краха). */
  | { kind: 'exists' };
