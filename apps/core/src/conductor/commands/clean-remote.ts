import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { z } from 'zod';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';
import { publisherOf } from './publisher-port.ts';

/**
 * Убрать ветки и метки задачи с сервера (P102): удаляются РОВНО названные человеком ссылки —
 * никаких масок и «всё ветки задачи». Каждое удаление — действие outbox `ref-delete` с арендой
 * по прочитанному sha; итог подтверждается чтением сервера, а не ответом пуша. Без порта
 * публикатора — отказ `publisher-unwired`, не «удалено» без действия.
 */

export function refsOf(f: { branches: readonly string[]; tags?: readonly string[] }): string[] {
  return [
    ...f.branches.map((b) => `refs/heads/${b.replace(/^refs\/heads\//, '')}`),
    ...(f.tags ?? []).map((t) => `refs/tags/${t.replace(/^refs\/tags\//, '')}`),
  ];
}

export const applyCleanRemote: ApplyCommand = async (task, command, env) => {
  const f = command.fields as z.infer<(typeof COMMAND_FIELDS)['clean-remote']>;
  if (!task.state.created)
    return reject(task, command.cmdId, 'state-conflict', 'task is not created yet');
  const port = publisherOf(env);
  if (!port) return reject(task, command.cmdId, 'publisher-unwired', 'the publisher is not wired');
  const got = await port.cleanRemote(task, { refs: refsOf(f), remote: f.remote ?? null });
  if ('unknown' in got) return reject(task, command.cmdId, 'remote-unknown', got.unknown);
  if (got.failed.length > 0)
    return reject(
      task,
      command.cmdId,
      'clean-remote-failed',
      got.failed.map((x) => `${x.ref}: ${x.code}`).join('; '),
    );
  return applied(task, command.cmdId, {
    deleted: got.deleted.join(' '),
    absent: got.absent.join(' '),
  });
};
