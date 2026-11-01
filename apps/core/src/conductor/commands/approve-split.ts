import { humanActorOf, latestSplit, launchable, launchSplit, linesOf } from '../split/index.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Утверждение деления человеком (02:69, точка 10): только последнее деление, принятое проверкой,
 * и только у задачи, ждущей запуска. `split.decided approved` — решение человека
 * (`decisionSeq` = строка приёма команды), затем запуск с предпроверкой (P101). Предпроверка
 * упала — команда отвергнута с названными дорогами, деление остаётся утверждённым: повтор
 * `launch` после починки не требует второго утверждения.
 */
export const applyApproveSplit: ApplyCommand = async (task, command, cmdEnv) => {
  const { cmdId } = command;
  // Поля уже разобраны схемой вида при приёме (`parseCommand`).
  const { splitId } = command.fields as { splitId: string };
  const env = cmdEnv.split();
  if (!env) return reject(task, cmdId, 'preflight-unwired', 'split environment is not wired');
  const split = latestSplit(linesOf(task));
  const missing: string[] = [];
  if (task.state.task !== 'awaiting-launch')
    missing.push(`task is ${task.state.task}, not awaiting-launch`);
  if (split?.splitId !== splitId) missing.push(`split ${splitId} is not the latest split`);
  else missing.push(...launchable(split));
  if (missing.length > 0) {
    const code = task.state.task === 'awaiting-launch' ? 'split-not-approvable' : 'state-conflict';
    return { ...reject(task, cmdId, code, missing.join('; ')), state: task.state };
  }
  const received = task.state.commands[cmdId]?.receivedSeq ?? task.state.seq;
  task.append({
    kind: 'split.decided',
    actor: humanActorOf(task, cmdId),
    cmdId,
    data: {
      splitId,
      outcome: 'approved',
      by: 'human',
      decisionSeq: received,
    },
  });
  const launched = await launchSplit(task, env, cmdId);
  if (launched.kind !== 'launched')
    return reject(task, cmdId, launched.code, launched.reasons.join('; '));
  return applied(task, cmdId, { to: 'running', units: launched.units.join(',') });
};
