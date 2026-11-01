import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';
import { publisherOf } from './publisher-port.ts';

/**
 * «Опубликовать сейчас» (P96): единица идёт в голову очереди публикаций своего репозитория, и
 * CI после публикации не ждётся. Ни открытого вопроса, ни условия готовности команда НЕ снимает —
 * публикация по-прежнему проходит готовность целиком. Строка `command.applied` с `unitId` —
 * то, что читает свёртка (`publishNowSeq`); очередь без порта просто не двигается.
 */

const ENDED: ReadonlySet<string> = new Set(['done', 'closed']);

export const applyPublishNow: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['publish-now']>;
  const { state } = task;
  if (!state.created || state.ended)
    return reject(
      task,
      command.cmdId,
      'state-conflict',
      state.ended ? `task already ended (${state.ended})` : 'task is not created yet',
    );
  const unit = Object.hasOwn(state.units, f.unitId) ? state.units[f.unitId] : undefined;
  if (!unit)
    return reject(task, command.cmdId, 'unknown-unit', `unit ${f.unitId} is not in this task`);
  if (ENDED.has(unit.state))
    return reject(task, command.cmdId, 'state-conflict', `unit ${f.unitId} already ${unit.state}`);
  publisherOf(env)?.promote(f.unitId);
  return applied(task, command.cmdId, { unitId: f.unitId });
};
