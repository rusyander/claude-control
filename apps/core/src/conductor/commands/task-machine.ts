import {
  TASK_MACHINE,
  nextState,
  taskEndedOutcome,
  type TaskEvent,
} from '@agentdeck/contracts/core/states';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Команда, которая двигает машину задачи одним событием: переход по таблице или
 * `state-conflict` с текущим состоянием. Конец машины — всегда `task.ended` (P17): исход берётся
 * из таблицы, а не из списка здесь.
 */
export function taskEvent(event: TaskEvent): ApplyCommand {
  return async (task, command) => {
    const { cmdId } = command;
    const from = task.state.task;
    const step = nextState(TASK_MACHINE, from, event);
    if (!step.ok) {
      const result = reject(
        task,
        cmdId,
        'state-conflict',
        `${command.kind} not allowed in ${from}`,
      );
      return { ...result, state: task.state };
    }
    const moved = task.append({
      kind: 'task.transition',
      actor: 'core',
      cmdId,
      data: { taskId: task.taskId, event, from, to: step.to },
    });
    const ended = taskEndedOutcome(step.to);
    if (ended) {
      task.append({
        kind: 'task.ended',
        actor: 'core',
        cmdId,
        cause: moved.seq,
        data: { outcome: ended },
      });
    }
    return applied(task, cmdId, { from, to: step.to });
  };
}
