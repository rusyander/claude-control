import type {
  ProjectTestAutomationStatus,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStatus,
} from '@agentdeck/contracts';
import type { BadgeTone } from '@shared/ui/badge';

/**
 * Цвета статусов, важностей и готовности — один набор на всё рабочее место.
 *
 * Держатся в entity, а не в каждом списке: библиотека, ручной прогон, история и
 * отчёт показывают одни и те же значения, и провал, покрашенный в трёх местах
 * по-разному, читается как три разные вещи.
 */

export const STATUS_TONE: Record<ProjectTestStatus, BadgeTone> = {
  unknown: 'neutral',
  running: 'info',
  passed: 'success',
  failed: 'danger',
  skipped: 'warning',
  // Помеха чужой поломкой — не провал этого кейса, но и не пропуск по решению
  // человека: отдельный тон, иначе она теряется среди пропущенных.
  blocked: 'warning',
};

export const PRIORITY_TONE: Record<ProjectTestPriority, BadgeTone> = {
  blocker: 'danger',
  high: 'warning',
  medium: 'neutral',
  low: 'neutral',
};

export const READINESS_TONE: Record<ProjectTestReadiness, BadgeTone> = {
  draft: 'neutral',
  ready: 'success',
  obsolete: 'warning',
};

export const AUTOMATION_TONE: Record<ProjectTestAutomationStatus, BadgeTone> = {
  manual: 'neutral',
  toAutomate: 'info',
  automated: 'success',
};

/** Доля зелёного в наборе, 0–100: ею красят полосы прогресса и покрытия. */
export function percentOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
