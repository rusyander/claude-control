import { releaseResource } from '../services.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * `release-resource {rid}` (G25, P90): снятие с чтением назад; исход команды — факт чтения
 * (`verified` или `leak` с причиной), не «снято» на слово. Нет такого ресурса, уже снят или вид
 * снимается своей дорогой — отказ с кодом.
 */
export const applyReleaseResource: ApplyCommand = async (task, command) => {
  const { rid } = command.fields as { rid: string };
  const got = await releaseResource(task, rid);
  if ('rejected' in got) return reject(task, command.cmdId, got.rejected, got.reason);
  const outcome: Record<string, string> =
    'verified' in got ? { rid, verified: got.verified } : { rid, leak: got.leak };
  return applied(task, command.cmdId, outcome);
};
