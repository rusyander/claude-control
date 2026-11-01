import { humanChannel } from '../human/channel.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Разрешение на пути и операции (06 §Session permissions, пункт 5): `grant.given`. Проект — ключ
 * репозитория задачи; чужой проект открыть нельзя. Грант действует посреди шага: судья права
 * перечитывает гранты из журнала на отказе `grant-required` (`conductor/human/permit-point.ts`).
 * Вопросов он сам не закрывает — ответ на вопрос пункта 5 человек даёт командой `answer`: один
 * грант может открыть пути, о которых вопроса не было, и молча закрытая карточка хуже явной.
 */
export const applyGrant: ApplyCommand = async (task, command) => {
  const f = command.fields as { project: string; globs: string[]; ops: ('edit' | 'exec-db')[] };
  const repos = task.state.created?.repos.map((r) => r.repoKey) ?? [];
  if (!repos.includes(f.project)) {
    return reject(
      task,
      command.cmdId,
      'unknown-project',
      `project ${f.project} is not a repo of this task (${repos.join(', ') || 'none'})`,
    );
  }
  task.append({
    kind: 'grant.given',
    actor: humanChannel(task, command.cmdId).actor,
    cmdId: command.cmdId,
    data: { cmdId: command.cmdId, project: f.project, globs: f.globs, ops: f.ops },
  });
  return applied(task, command.cmdId, { project: f.project, globs: String(f.globs.length) });
};
