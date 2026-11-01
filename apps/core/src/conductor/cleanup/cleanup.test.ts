import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { readHumanLedger } from '../human/ledger.ts';
import { applyCleanup, decideCleanup } from './cleanup.ts';

/**
 * Уборка (F10, P90): на конце единицы ядро снимает свои ресурсы единицы (и шаговые, пережившие
 * шаг), с чтением назад; ресурсы сессии, копию, оставленное по политике и чужую единицу не трогает;
 * на конце задачи — всё своё, оставленное — с причиной.
 */

function resource(
  task: LiveTask,
  over: {
    kind?: string;
    owner?: 'core' | 'session';
    release?: unknown;
    unitId?: string;
    ref?: string;
  },
): string {
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    ...(over.unitId ? { unitId: over.unitId } : {}),
    data: {
      rid,
      kind: (over.kind ?? 'tmpdir') as never,
      owner: over.owner ?? 'core',
      release: (over.release ?? 'unit-end') as never,
      ref: over.ref ?? '/tmp/none',
    },
  });
  return rid;
}

describe('cleanup', () => {
  it('F10 unit end releases own unit resources only; session, copy, kept and other units stay', async () => {
    const { task } = await openFresh();
    const u1 = newId();
    const u2 = newId();
    const own = resource(task, { unitId: u1 });
    const stepLeft = resource(task, { unitId: u1, release: 'step-end' });
    const session = resource(task, { unitId: u1, owner: 'session' });
    const copy = resource(task, { unitId: u1, kind: 'copy' });
    const other = resource(task, { unitId: u2 });
    const taskEnd = resource(task, { unitId: u1, release: 'task-end' });
    const kept = resource(task, { unitId: u1, release: { keep: 'debug stand' } });
    const unit = decideCleanup(readHumanLedger(task), { kind: 'unit-end', unitId: u1 });
    expect(unit.release.map((r) => r.rid)).toEqual([own, stepLeft]);
    expect(unit.keep.map((r) => r.rid)).toEqual([session, copy]);
    const end = decideCleanup(readHumanLedger(task), { kind: 'task-end' });
    expect(end.release.map((r) => r.rid)).toEqual([own, stepLeft, other, taskEnd]);
    expect(end.keep).toContainEqual({ rid: kept, kind: 'tmpdir', why: 'kept: debug stand' });
    task.close();
  });

  it('P90 a released tmpdir is read back as absent, the decision is journaled, and a verified row is not judged again', async () => {
    const { task } = await openFresh();
    const unitId = newId();
    const dir = mkdtempSync(join(tmpdir(), 'adk-clean-'));
    const rid = resource(task, { unitId, ref: dir });
    const decision = decideCleanup(readHumanLedger(task), { kind: 'unit-end', unitId });
    const got = await applyCleanup(task, decision);
    expect(got.verified).toMatchObject([{ rid }]);
    expect(existsSync(dir)).toBe(false);
    const lines = readJournalLines(task.dir, task.taskId).lines;
    expect(lines.find((l) => l.kind === 'decision')?.data).toMatchObject({ class: 'cleanup' });
    expect(lines.some((l) => l.kind === 'resource.verified')).toBe(true);
    expect(decideCleanup(readHumanLedger(task), { kind: 'task-end' }).release).toEqual([]);
    task.close();
  });
});
