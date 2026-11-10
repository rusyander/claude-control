import { TASK_MACHINE, nextState } from '@agentdeck/contracts/core/states';
import { openTakeoverOf } from '../../journal/reduce/fold-view.ts';
import { humanChannel } from '../human/channel.ts';
import { liveStepOf } from '../takeover/target.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Возврат перехваченной единицы ядру (P161, D9). Порядок — часть свойства:
 *   1. открытый перехват и пауза — иначе отказ `state-conflict`;
 *   2. чат перехвата кончается ПЕРВЫМ (порт ждёт, пока его сеансы сняты): иначе две руки в одной
 *      копии, а грант чата на копию пережил бы возврат;
 *   3. `task.handback{note}`, переход `resume`, такт доски;
 *   4. `note` — сообщением шагу, который перехват прервал (`stepId` в исходе → `human/ledger.ts`),
 *      доставка на первой границе хода его сеанса. Изменённую человеком копию судит проверка шага
 *      заново: её запись — по содержимому, старая запись не повторяется.
 */
export const applyHandBack: ApplyCommand = async (task, command, env) => {
  const { cmdId } = command;
  const { note } = command.fields as { note?: string };
  const conflict = (reason: string) => ({
    ...reject(task, cmdId, 'state-conflict', reason),
    state: task.state,
  });
  const open = openTakeoverOf(task.state);
  if (!open) return conflict('no open takeover to hand back');
  const from = task.state.task;
  const step = nextState(TASK_MACHINE, from, 'resume');
  if (!step.ok) return conflict(`hand-back not allowed in ${from}`);
  const port = env.takeover?.();
  if (!port) return reject(task, cmdId, 'takeover-unwired', 'takeover wiring is not connected');
  const closed = await port.close(task, cmdId);
  if (!closed.ok) return reject(task, cmdId, closed.code, closed.reason);
  const text = note?.trim() ?? '';
  task.append({
    kind: 'task.handback',
    actor: humanChannel(task, cmdId).actor,
    cmdId,
    data: text.length > 0 ? { note: text } : {},
  });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event: 'resume', from, to: step.to },
  });
  env.board?.()?.tick();
  // Шаг перехваченной единицы; его нет (задача стояла между шагами) — последний живой шаг задачи.
  const target =
    text.length > 0 ? (liveStepOf(task.state, open.unitId) ?? liveStepOf(task.state)) : undefined;
  return applied(task, cmdId, {
    from,
    to: step.to,
    unitId: open.unitId,
    ended: closed.ended,
    ...(target ? { stepId: target.stepId } : {}),
  });
};
