/** Точка уборки: конец шага, единицы или задачи (01 §Resources, `resource.created.release`). */
export type CleanupPoint =
  | { kind: 'step-end'; stepId: string }
  | { kind: 'unit-end'; unitId: string }
  | { kind: 'task-end' };

export interface CleanupItem {
  rid: string;
  kind: string;
  why: string;
}

/**
 * Суд уборки (класс `cleanup`, P90, F10): что снять на этой точке и что оставить с причиной.
 * Своё ядро снимает без вопроса; оставленное идёт в остатки итогового отчёта.
 */
export interface CleanupDecision {
  at: CleanupPoint;
  release: CleanupItem[];
  keep: CleanupItem[];
}

export interface CleanupResult {
  verified: { rid: string; fact: string }[];
  leaks: { rid: string; reason: string }[];
  skipped: { rid: string; reason: string }[];
}
