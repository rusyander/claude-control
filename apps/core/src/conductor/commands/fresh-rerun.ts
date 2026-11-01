import type { COMMAND_FIELDS } from '@agentdeck/contracts/core/commands';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { CheckDecisionInput } from '@agentdeck/contracts/core/records';
import type { z } from 'zod';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

/**
 * Повтор проверки без кэша (G12, фаза 5): человек просит один прогон мимо записи — проверки по
 * id, единицы или ключа. Команда только ставит разовую отметку (`command.applied` с областью и
 * ссылкой); вход суда проверки несёт её (`CheckDeps.fresh`), суд гонит мимо повтора, и строка
 * решения `check` с `run` по ней — трата. Вторая такая же команда — второй разовый прогон.
 */

type FreshFields = z.infer<(typeof COMMAND_FIELDS)['fresh-rerun']>;
type Fresh = NonNullable<CheckDecisionInput['fresh']>;

export const applyFreshRerun: ApplyCommand = async (task, command) => {
  const f = command.fields as FreshFields;
  const { state } = task;
  if (!state.created || state.ended)
    return reject(
      task,
      command.cmdId,
      'state-conflict',
      state.ended ? `task already ended (${state.ended})` : 'task is not created yet',
    );
  return applied(task, command.cmdId, { fresh: f.scope, ref: f.ref });
};

/**
 * Причина решения `run` по разовой отметке — дословно та, что пишет суд проверки
 * (`verifier/decide`: `fresh one-shot (<scope> <ref>)`); по ней строка решения тратит отметку.
 */
export const freshReason = (f: Fresh): string => `fresh one-shot (${f.scope} ${f.ref})`;

/**
 * Первая непотраченная отметка задачи по порядку журнала: применённые команды `fresh-rerun`
 * минус решения `check` с `run`, чья причина названа этой отметкой (каждое тратит одну).
 */
export function freshPending(lines: readonly JournalLine[]): CheckDecisionInput['fresh'] {
  const received = new Map<string, Fresh>();
  const pending: Fresh[] = [];
  for (const l of lines) {
    if (l.kind === 'command.received') {
      const d = (l as JournalLine<'command.received'>).data;
      if (d.kind === 'fresh-rerun' && l.cmdId) received.set(l.cmdId, d.fields as Fresh);
      continue;
    }
    if (l.kind === 'command.applied') {
      const f = l.cmdId ? received.get(l.cmdId) : undefined;
      if (f) pending.push({ scope: f.scope, ref: f.ref });
      continue;
    }
    if (l.kind !== 'decision') continue;
    const d = (l as JournalLine<'decision'>).data;
    if (d.class !== 'check') continue;
    const out = d.output as { kind?: string; reason?: string };
    if (out.kind !== 'run') continue;
    const at = pending.findIndex((f) => freshReason(f) === out.reason);
    if (at >= 0) pending.splice(at, 1);
  }
  return pending[0] ?? null;
}
