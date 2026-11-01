import type { CommandKind } from '@agentdeck/contracts/core/commands';
import type { LiveTask } from '../../journal/resume.ts';
import type { ApplyCommand, CommandResult } from './commands.types.ts';

/** Отказ команды с кодом — строка `command.rejected`, она же исход повтора того же `cmdId`. */
export function reject(task: LiveTask, cmdId: string, code: string, reason: string): CommandResult {
  const line = task.append({
    kind: 'command.rejected',
    actor: 'core',
    cmdId,
    data: { code, reason },
  });
  return { cmdId, status: 'rejected', code, reason, seq: line.seq };
}

/**
 * Успешный исход команды — строка `command.applied` с фактом применения. Списки (G12: `warnings`
 * рискованной команды) едут в том же исходе — повтор того же `cmdId` отдаёт записанное, второго
 * предупреждения нет.
 */
export function applied(
  task: LiveTask,
  cmdId: string,
  outcome: Record<string, string | string[]>,
): CommandResult {
  const line = task.append({ kind: 'command.applied', actor: 'core', cmdId, data: { outcome } });
  return { cmdId, status: 'applied', seq: line.seq, outcome };
}

/**
 * Вид, чья зона ещё не подключена: 501 `not-implemented` с номером фазы, а не молчаливое
 * «принято» — команда человека без действия хуже честного отказа. Зона заменяет вызов своей
 * функцией применения в файле вида.
 */
export function notYet(kind: CommandKind, phase: number): ApplyCommand {
  return async (task, command) =>
    reject(task, command.cmdId, 'not-implemented', `${kind} applies from phase ${phase}`);
}
