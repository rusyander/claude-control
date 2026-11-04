import type { LegacyGroupRun, LegacyGroupRunState } from '@agentdeck/contracts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';

/**
 * Прежние запуски групп (планы разделения) для страницы групп над ядром (этап 10, F1) — только
 * чтение. Ядро их не подхватывает (Q10, спека 10:8): недоведённый запуск показан остановленным
 * для ядра, а не продолжается им. Поэтому наружу идут лишь название, ветка и статус каждой
 * группы — ни копия, ни чат, ни запрос, из которых можно было бы собрать задачу ядра.
 */

/** Группа дошла до конца прежним путём: дальше с ней ничего не случится. */
const TERMINAL = new Set(['done', 'failed']);

export function legacyRunState(plan: SplitPlanRecord): LegacyGroupRunState {
  if (plan.cancelledAt) return 'cancelled';
  // План без групп ничего не начал — но и не кончил: честнее «не доведён», чем «завершён».
  if (plan.groups.length === 0) return 'half-run';
  return plan.groups.every((group) => TERMINAL.has(group.status)) ? 'finished' : 'half-run';
}

export function legacyGroupRuns(plans: Record<string, SplitPlanRecord>): LegacyGroupRun[] {
  return Object.values(plans)
    .map((plan) => ({
      parentChatId: plan.parentChatId,
      projectPath: plan.projectPath,
      createdAt: plan.createdAt,
      state: legacyRunState(plan),
      groups: plan.groups.map((group) => ({
        title: group.title,
        branch: group.branch,
        status: group.status,
      })),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
