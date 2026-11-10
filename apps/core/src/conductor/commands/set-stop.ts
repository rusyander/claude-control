import type { BoardStop } from '@agentdeck/contracts/core/board';
import { publicationOf } from '../../journal/reduce/publish.ts';
import { boardStopOf } from '../../journal/reduce/fold-view.ts';
import { humanChannel } from '../human/channel.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Смена остановки задачи (P157, D7): строка `task.stop`, последняя действует (`boardStopOf`).
 * После первого `publish.mr` — отказ `state-conflict` (409): MR уже открыт, и «до MR» / «до
 * конца» решено фактом, а не словом — смена задним числом сняла бы наблюдение за чужими
 * заметками или открыла бы его мимо решения человека.
 */
export const applySetStop: ApplyCommand = async (task, command) => {
  const { stop } = command.fields as { stop: BoardStop };
  const published = Object.keys(task.state.units).find((u) => publicationOf(task.state, u).mr);
  if (published !== undefined) {
    const result = reject(
      task,
      command.cmdId,
      'state-conflict',
      `set-stop not allowed after publish.mr (unit ${published})`,
    );
    return { ...result, state: task.state };
  }
  const from = boardStopOf(task.state);
  task.append({
    kind: 'task.stop',
    actor: humanChannel(task, command.cmdId).actor,
    cmdId: command.cmdId,
    data: { stop },
  });
  return applied(task, command.cmdId, { stop, from: from ?? 'none' });
};
