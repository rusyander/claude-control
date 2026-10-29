import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostileHomes } from '../platform/__fixtures__/hostile-homes.ts';
import { CREATED, deps, openFresh } from './__fixtures__/journal-harness.ts';
import { readTaskView } from './read-view.ts';
import { readJournalLines } from './read-lines.ts';
import { resume } from './resume.ts';
import { SNAPSHOT_EVERY, snapshotPath } from './snapshot.ts';
import { TASK_FILES } from './journal.types.ts';

const err = (code: string) => ({
  kind: 'error' as const,
  actor: 'core',
  data: { code, detail: '' },
});

describe('resume', () => {
  it('P74 torn last line: readers skip it, the lease owner cuts it on open and journals journal.repaired', async () => {
    const { task, dir, taskId } = await openFresh();
    task.append({ kind: 'task.created', actor: 'core', data: CREATED });
    task.append(err('a'));
    const before = task.state;
    task.close();
    appendFileSync(join(dir, TASK_FILES.journal), '{"v":1,"seq":5,"kind":"err');
    const view = readTaskView(dir, taskId);
    expect(view.tornBytes).toBeGreaterThan(0);
    expect(view.state.counters.errors).toBe(1);
    const reopened = await resume(dir, taskId, deps());
    if (!reopened.ok) throw new Error(reopened.reason);
    const kinds = readJournalLines(dir, taskId).lines.map((l) => l.kind);
    expect(kinds.slice(-2)).toEqual(['journal.repaired', 'lease.acquired']);
    expect(reopened.task.state.counters.repairedBytes).toBe('{"v":1,"seq":5,"kind":"err'.length);
    expect(reopened.task.state.created).toEqual(before.created);
    expect(readTaskView(dir, taskId).tornBytes).toBe(0);
    reopened.task.close();
  });

  it('P74 one writer per task: a second core cannot open a task whose lease is held by a live core', async () => {
    const { task, dir, taskId } = await openFresh();
    const second = await resume(dir, taskId, deps());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder?.pid).toBe(process.pid);
    task.close();
    const third = await resume(dir, taskId, deps());
    expect(third.ok).toBe(true);
    if (third.ok) third.task.close();
  });

  it('snapshot every 200 events is trusted only when its h matches the chain; a tampered one → full replay, same state', async () => {
    const { task, dir, taskId } = await openFresh();
    for (let i = 0; i < SNAPSHOT_EVERY + 5; i += 1) task.append(err(`e${i}`));
    task.close();
    const viaSnapshot = await resume(dir, taskId, deps());
    if (!viaSnapshot.ok) throw new Error(viaSnapshot.reason);
    expect(viaSnapshot.fromSnapshot).not.toBeNull();
    expect(viaSnapshot.replayed).toBeLessThan(10);
    const stateA = viaSnapshot.task.state;
    viaSnapshot.task.close();
    const snap = JSON.parse(readFileSync(snapshotPath(dir), 'utf8')) as { h: string };
    writeFileSync(snapshotPath(dir), JSON.stringify({ ...snap, h: '0'.repeat(64) }));
    const full = await resume(dir, taskId, deps());
    if (!full.ok) throw new Error(full.reason);
    expect(full.fromSnapshot).toBeNull();
    expect(full.task.state.counters.errors).toBe(stateA.counters.errors);
    expect(full.task.state.seq).toBe(stateA.seq + 2);
    full.task.close();
  });

  it('P78 journal append + fold on a non-Latin, 8.3 short-name and >260-char core home', async () => {
    for (const { name, dir: home } of hostileHomes()) {
      const { task, dir, taskId } = await openFresh(join(home, `tasks-${name}`));
      task.append({
        kind: 'task.created',
        actor: 'core',
        data: { ...CREATED, title: 'задача 汉字' },
      });
      task.append(err('x'));
      task.close();
      const reopened = await resume(dir, taskId, deps());
      if (!reopened.ok) throw new Error(`${name}: ${reopened.reason}`);
      expect({ name, title: reopened.task.state.created?.title }).toEqual({
        name,
        title: 'задача 汉字',
      });
      expect(reopened.task.state.counters.errors).toBe(1);
      reopened.task.close();
    }
  });
});
