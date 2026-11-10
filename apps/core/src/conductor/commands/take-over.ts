import { TASK_MACHINE, nextState } from '@agentdeck/contracts/core/states';
import { openTakeoverOf } from '../../journal/reduce/fold-view.ts';
import { humanChannel } from '../human/channel.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Перехват единицы человеком (P161, D9). Доказательство — строгое (`authority.ts`, как `grant`):
 * команда отдаёт права записи в копию сеансу чата. Порядок:
 *   1. задача должна уметь встать на паузу (машина задачи) или уже стоять на ней, и не быть
 *      уже перехваченной;
 *   2. порт открывает чат перехвата (`chat@1` на месте в копии единицы, ключ оценки = `cmdId`);
 *   3. `task.takeover{unitId, copy, chatTaskId}`, затем переход `pause`: свёртка делает её мягкой
 *      (вид команды не `pause`, `now` нет) — сеанс шага снимается в безопасной точке;
 *   4. такт доски: место сеанса свободно, голова очереди стартует сейчас (P154).
 * Пока перехват открыт, шагов нет: продолжение отказывает (`resume.ts`), снять паузу может только
 * возврат (`hand-back`).
 */
export const applyTakeOver: ApplyCommand = async (task, command, env) => {
  const { cmdId } = command;
  const conflict = (reason: string) => ({
    ...reject(task, cmdId, 'state-conflict', reason),
    state: task.state,
  });
  const open = openTakeoverOf(task.state);
  if (open) return conflict(`unit ${open.unitId} is already taken over`);
  const from = task.state.task;
  // Уже на паузе (человек остановил раньше) — перехват без второго перехода.
  const step = from === 'paused' ? null : nextState(TASK_MACHINE, from, 'pause');
  if (step && !step.ok) return conflict(`take-over not allowed in ${from}`);
  const port = env.takeover?.();
  if (!port) return reject(task, cmdId, 'takeover-unwired', 'takeover wiring is not connected');
  const got = await port.open(task, cmdId);
  if (!got.ok) return reject(task, cmdId, got.code, got.reason);
  const actor = humanChannel(task, cmdId).actor;
  task.append({
    kind: 'task.takeover',
    actor,
    cmdId,
    data: { unitId: got.unitId, copy: got.copy, chatTaskId: got.chatTaskId },
  });
  if (step) {
    task.append({
      kind: 'task.transition',
      actor: 'core',
      cmdId,
      data: { taskId: task.taskId, event: 'pause', from, to: step.to },
    });
  }
  env.board?.()?.tick();
  return applied(task, cmdId, {
    from,
    to: task.state.task,
    unitId: got.unitId,
    copy: got.copy,
    chatTaskId: got.chatTaskId,
  });
};
