import type { DeliveryReply } from '@agentdeck/contracts/core/publish';
import { unitCopyOf } from '../../conductor/copy/journal-view.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { pathKey } from '../../platform/paths.ts';
import { judgeUnit, type AttemptDeps } from './attempt.ts';

/**
 * Проба сдачи копии (`GET /v1/delivery`, `tests-cli delivery`) — ТОТ ЖЕ суд, что шаг публикации:
 * `judgeUnit` с составом самой единицы и без перебазировки. Раньше у групп была своя проверка
 * сдачи в панели (`delivery-check`); две проверки называли разное, и группа узнавала отказ ядра
 * только на публикации. Журнал проба не пишет: ожидание форжа — отказ `wait-forge` в ответе, а
 * не строка `publish.backoff`.
 */

/**
 * Живая единица, чья копия — эта папка; нет — `undefined`. Сравнение — `pathKey` платформы:
 * длинная настоящая форма (8.3 и ссылки раскрыты), регистр свёрнут там, где его не различает
 * том. `git rev-parse --show-toplevel` клиента отдаёт длинное имя, а журнал хранит путь, как его
 * дала ОС при создании копии (временная папка — короткое имя).
 */
export function unitOfCopy(
  tasks: readonly LiveTask[],
  copy: string,
): { task: LiveTask; unitId: string } | undefined {
  const want = pathKey(copy);
  for (const task of tasks) {
    for (const unitId of Object.keys(task.state.units)) {
      const dir = unitCopyOf(task, unitId)?.dir;
      if (dir && pathKey(dir) === want) return { task, unitId };
    }
  }
  return undefined;
}

export async function probeDelivery(
  deps: AttemptDeps,
  registry: Pick<TaskRegistry, 'liveTasks'>,
  copy: string,
): Promise<DeliveryReply | { missing: string }> {
  const found = unitOfCopy(registry.liveTasks(), copy);
  if (!found) return { missing: `no live unit of the core has its copy at ${copy}` };
  const { task, unitId } = found;
  const head = { taskId: task.taskId, unitId, copy };
  const composed = publicationOf(task.state, unitId).composed;
  const judged = await judgeUnit(deps, task, unitId, composed?.compositionId ?? null, true);
  if (judged.kind === 'allowed') return { ...head, verdict: 'ready' };
  if (judged.kind === 'wait')
    return {
      ...head,
      verdict: 'refused',
      next: 'wait-forge',
      unmet: [`forge-unknown ${judged.cause}`],
    };
  return { ...head, verdict: 'refused', next: judged.next, unmet: judged.unmet };
}
