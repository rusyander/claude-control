import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from './__fixtures__/command-env.ts';
import { R1, R2, seedRequirements } from '../model-tools/__fixtures__/seed.ts';
import { decideRequirements, requirementsInputOf } from '../requirements/index.ts';

/**
 * `edit-requirements` через вход команд ядра (`processCommand`: приём, полномочия, применение):
 * добавленный пункт получает id ядра и источник `human`; снятие — единственная дорога к `waived`
 * (G2), решение — строка приёма команды; неизвестные или уже снятые id названы все, и ни одна
 * строка не пишется.
 */

const proof = async (): Promise<CommandProof> => ({
  token: 'core',
  nonce: 'valid',
  peer: 'clear',
  signature: 'absent',
});

function edit(taskId: string, fields: CommandEnvelope['fields']): CommandEnvelope {
  return { cmdId: newId(), kind: 'edit-requirements', target: { taskId }, fields, proof: {} };
}

describe('edit-requirements', () => {
  it('G2 adds a human point with a core id and waives a point with the reason, decided by the command line', async () => {
    const { task, taskId } = await openFresh();
    seedRequirements(task, [R1, R2]);
    const cmd = edit(taskId, {
      add: [{ text: 'keeps the input on error' }],
      waive: [{ requirementId: R2, reason: 'out of scope for this ticket' }],
    });
    const out = await processCommand(task, cmd, proof, commandEnv());
    expect(out).toMatchObject({ status: 'applied', outcome: { waived: R2 } });
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const received = lines.find((l) => l.kind === 'command.received' && l.cmdId === cmd.cmdId);
    const added = lines.filter((l) => l.kind === 'requirement.extracted').at(-1);
    expect(added).toMatchObject({
      actor: 'human:panel',
      data: { ordinal: 3, source: 'human', stepId: null, text: 'keeps the input on error' },
    });
    expect((added?.data as { requirementId: string }).requirementId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7/,
    );
    expect(lines.find((l) => l.kind === 'requirement.verdict')?.data).toEqual({
      requirementId: R2,
      verdict: 'waived',
      evidence: [],
      reason: 'out of scope for this ticket',
      decisionSeq: received?.seq,
    });
    const judged = decideRequirements({ ...requirementsInputOf(lines), evidence: {} });
    expect(judged.requirements.map((r) => r.verdict)).toEqual(['open', 'waived', 'open']);
    task.close();
  });

  it('P01 unknown, already waived and doubled ids are all named; nothing is written', async () => {
    const { task, taskId } = await openFresh();
    seedRequirements(task, [R1, R2]);
    await processCommand(
      task,
      edit(taskId, { add: [], waive: [{ requirementId: R1, reason: 'first' }] }),
      proof,
      commandEnv(),
    );
    const before = readJournalLines(task.dir, task.taskId).lines.length;
    const stranger = newId();
    const out = await processCommand(
      task,
      edit(taskId, {
        add: [{ text: 'must not land' }],
        waive: [
          { requirementId: stranger, reason: 'x' },
          { requirementId: R1, reason: 'again' },
          { requirementId: R2, reason: 'a' },
          { requirementId: R2, reason: 'b' },
        ],
      }),
      proof,
      commandEnv(),
    );
    expect(out).toMatchObject({ status: 'rejected', code: 'unknown-requirement' });
    expect(out.reason).toContain(`${stranger}: not a requirement`);
    expect(out.reason).toContain(`${R1}: already waived`);
    expect(out.reason).toContain(`${R2}: waived twice`);
    const after = readJournalLines(task.dir, task.taskId).lines.slice(before);
    expect(after.map((l) => l.kind)).toEqual(['command.received', 'command.rejected']);
    task.close();
  });
});
