import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { CheckDecisionInput, CheckRequest } from '@agentdeck/contracts/core/records';
import type { CheckDeps } from '../../conductor/checks/index.ts';
import { freshPending } from '../../conductor/commands/fresh-rerun.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { WindowBook } from '../../economy/window/index.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Экономика во входе проверки (этап 5): окно — та же книга окон ядра, что судит шаги и отвечает
 * `/v1/health` (G7, одна на процесс), по маршруту сессии шага, просящего проверку; разовый
 * fresh-перезапуск — первая непотраченная отметка команды `fresh-rerun` журнала задачи.
 */

export interface CheckEconomyDeps {
  registry: Partial<Pick<TaskRegistry, 'live'>>;
  windows?: WindowBook;
  now?: () => number;
}

/**
 * Маршрут сессии шага: последняя сессия этого шага в журнале. Шага нет (псевдозадача, захват
 * вне шага) или сессии ещё нет — маршрута нет, окно не судит (`[]` — открыто, как у книги).
 */
export function stepRouteOf(task: LiveTask, stepId: string | null): string | null {
  if (!stepId) return null;
  let route: string | null = null;
  for (const s of Object.values(task.state.sessions)) if (s.stepId === stepId) route = s.route.id;
  return route;
}

export function checkEconomy(deps: CheckEconomyDeps): Pick<CheckDeps, 'window' | 'fresh'> {
  const now = deps.now ?? Date.now;
  const taskOf = (taskId: string): LiveTask | undefined => deps.registry.live?.(taskId);
  return {
    window(req: CheckRequest): readonly WindowDecision[] {
      const task = taskOf(req.taskId);
      const route = task ? stepRouteOf(task, req.stepId) : null;
      if (!route || !deps.windows) return [];
      return deps.windows.decide(route, now());
    },
    fresh(req: CheckRequest): CheckDecisionInput['fresh'] {
      const task = taskOf(req.taskId);
      if (!task) return null;
      return freshPending(readJournalLines(task.dir, task.taskId).lines);
    },
  };
}
