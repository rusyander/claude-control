import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { humanChannel } from '../human/channel.ts';
import { requirementsInputOf } from '../requirements/index.ts';
import type { ApplyCommand } from './commands.types.ts';
import { applied, reject } from './outcome.ts';

interface EditRequirementsFields {
  add: { text: string }[];
  waive: { requirementId: string; reason: string }[];
}

/**
 * Правка списка требований человеком (02:56, G2): `add` — новый пункт с id ядра и источником
 * `human`; `waive` — снятие с причиной, единственная дорога к `waived`, решение — строка этой
 * команды (`decisionSeq` = её `command.received`). Всё проверяется ДО первой записи: неизвестные
 * или уже снятые id названы все сразу (P01), команда либо применена целиком, либо не применена.
 */
export const applyEditRequirements: ApplyCommand = async (task, command) => {
  const f = command.fields as unknown as EditRequirementsFields;
  if (task.state.ended)
    return reject(task, command.cmdId, 'task-ended', `task already ended (${task.state.ended})`);
  const input = requirementsInputOf(readJournalLines(task.dir, task.taskId).lines);
  const known = new Set(input.requirements.map((r) => r.id));
  const waived = new Set(input.waivers.map((w) => w.id));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const w of f.waive) {
    if (!known.has(w.requirementId))
      problems.push(`${w.requirementId}: not a requirement of this task`);
    else if (waived.has(w.requirementId)) problems.push(`${w.requirementId}: already waived`);
    else if (seen.has(w.requirementId))
      problems.push(`${w.requirementId}: waived twice in one command`);
    seen.add(w.requirementId);
  }
  if (problems.length > 0)
    return reject(task, command.cmdId, 'unknown-requirement', problems.join('; '));

  const actor = humanChannel(task, command.cmdId).actor;
  const decisionSeq = task.state.commands[command.cmdId]?.receivedSeq ?? 0;
  let ordinal = Math.max(0, ...input.requirements.map((r) => r.ordinal));
  const added: string[] = [];
  for (const point of f.add) {
    const requirementId = newId();
    added.push(requirementId);
    task.append({
      kind: 'requirement.extracted',
      actor,
      cmdId: command.cmdId,
      data: { requirementId, ordinal: ++ordinal, text: point.text, source: 'human', stepId: null },
    });
  }
  for (const w of f.waive)
    task.append({
      kind: 'requirement.verdict',
      actor,
      cmdId: command.cmdId,
      data: {
        requirementId: w.requirementId,
        verdict: 'waived',
        evidence: [],
        reason: w.reason,
        decisionSeq,
      },
    });
  // Вердикты остальных пунктов здесь не пересчитываются: это делает судья после шага, со
  // свежестью записей, — «открыто» без неё было бы ложным.
  return applied(task, command.cmdId, {
    added: added.join(','),
    waived: f.waive.map((w) => w.requirementId).join(','),
  });
};
