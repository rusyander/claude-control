import { launchSplit } from '../split/index.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';
import { taskEvent } from './task-machine.ts';

const launchDraft = taskEvent('launch');

/**
 * Запуск. Черновик (задача без оценки) — событие `launch` машины задачи, как раньше. Задача,
 * ждущая запуска, — неявное утверждение последнего принятого деления с предпроверкой (P101):
 * без среды деления запуск отказан (`preflight-unwired`), а не идёт мимо проверки дорог.
 */
export const applyLaunch: ApplyCommand = async (task, command, cmdEnv) => {
  if (task.state.task !== 'awaiting-launch') return launchDraft(task, command, cmdEnv);
  const { cmdId } = command;
  const env = cmdEnv.split();
  if (!env) return reject(task, cmdId, 'preflight-unwired', 'split environment is not wired');
  const launched = await launchSplit(task, env, cmdId);
  if (launched.kind !== 'launched')
    return reject(task, cmdId, launched.code, launched.reasons.join('; '));
  return applied(task, cmdId, { to: 'running', units: launched.units.join(',') });
};
