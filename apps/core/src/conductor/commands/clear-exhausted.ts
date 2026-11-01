import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { HopControlReply } from '@agentdeck/contracts/core/hops';
import type { z } from 'zod';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Снять исчерпание маршрута (ответ 402, P122, G11): факт держит хост звеньев, и снимает его
 * ТОЛЬКО человек этой командой — ни ядро, ни звено сами не снимают (бюджет контура кончился
 * не на время, а до решения человека). Команда идёт через порт управления звеном (`routes/hops`
 * зоны H); не подключён — честный отказ `hop-unwired`, а не «снято» без действия.
 *
 * Маршрут обязан быть в разрешённом наборе задачи: команда — строка ЭТОЙ задачи, и снятие
 * чужого маршрута из её журнала было бы действием без следа там, где его будут искать.
 */

export const applyClearExhausted: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['clear-exhausted']>;
  const { state } = task;
  if (!state.created || state.ended)
    return reject(
      task,
      command.cmdId,
      'state-conflict',
      state.ended ? `task already ended (${state.ended})` : 'task is not created yet',
    );
  if (!allowedRoutesOf(state).some((triple) => triple.route.id === f.routeId))
    return reject(
      task,
      command.cmdId,
      'unknown-route',
      `${f.routeId} is not in the allowed routes of this task`,
    );
  const hop = env.hops?.();
  if (!hop) return reject(task, command.cmdId, 'hop-unwired', 'the hop host client is not wired');
  let reply: HopControlReply;
  try {
    reply = await hop({ op: 'clear-exhausted', routeId: f.routeId });
  } catch (error) {
    // Звено не ответило — снято ли, неизвестно: отказ с причиной, человек повторит.
    const why = error instanceof Error ? error.message : String(error);
    return reject(task, command.cmdId, 'hop-unreachable', `hop did not answer: ${why}`);
  }
  if (reply.op !== 'clear-exhausted' || !reply.ok) {
    const detail =
      'code' in reply ? `${reply.code}: ${reply.detail}` : `unexpected reply ${reply.op}`;
    return reject(task, command.cmdId, 'hop-refused', detail);
  }
  return applied(task, command.cmdId, { routeId: f.routeId, cleared: String(reply.cleared) });
};
