import { openTakeoverOf } from '../../journal/reduce/fold-view.ts';
import type { ApplyCommand } from './commands.types.ts';
import { reject } from './outcome.ts';
import { taskEvent } from './task-machine.ts';

/**
 * Продолжение (G10): событие `resume` машины задачи. Дальше — то же, что после перезапуска ядра
 * (P11): `next` видит шаг без живой сессии и велит `run-step`; памяти паузы вне журнала нет.
 * Этап 12 (P161): пока единицу ведёт человек (`task.takeover` открыт), продолжение отказано —
 * паузу перехвата снимает только возврат (`hand-back`), который сначала кончает чат перехвата.
 */
const resumeEvent = taskEvent('resume');

export const applyResume: ApplyCommand = async (task, command, env) => {
  const open = openTakeoverOf(task.state);
  if (open) {
    const result = reject(
      task,
      command.cmdId,
      'state-conflict',
      `unit ${open.unitId} is taken over by a human: hand it back to resume`,
    );
    return { ...result, state: task.state };
  }
  return resumeEvent(task, command, env);
};
