import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLivenessProbe, fakeProcessTable } from '../platform/process-identity.ts';
import { acquireTaskLease, STALE_MS, type LeaseDeps } from './lease.ts';
import { TASK_FILES } from './journal.types.ts';
import { holdFile } from './__fixtures__/hold-file.ts';
import { identity, tempDir } from './__fixtures__/journal-harness.ts';

/**
 * Ревью core-s2: F-24 (первый удар бросал после записи owner.json — задача запиралась до
 * рестарта ядра), F-113/H4 (отпуск, не удаливший owner.json, больше не пытался), F-30 (аренда
 * судит соперника тем же зондом живости, что и платформа: pid, родившийся после снимка тика,
 * не «мёртв»). Файлы держит настоящий чужой процесс (Windows) или права (POSIX) — `hold-file.ts`.
 */
const alive: LeaseDeps = { isAlive: async () => 'alive', now: Date.now };

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe('core-s2 lease fixes', () => {
  it('F-24 beats.log unwritable on acquire: refusal, not a throw; the lease is not left behind', async () => {
    const dir = tempDir('lease24-');
    const me = identity();
    const first = await acquireTaskLease(dir, me, alive);
    if (!first.ok) throw new Error(first.reason);
    first.lease.release();
    const release = await holdFile(join(dir, TASK_FILES.beats), 'unreadable');
    let during: Awaited<ReturnType<typeof acquireTaskLease>>;
    try {
      during = await acquireTaskLease(dir, me, alive);
    } finally {
      await release();
    }
    expect(during).toMatchObject({ ok: false, reason: 'beats unwritable' });
    expect(existsSync(join(dir, TASK_FILES.owner))).toBe(false);
    // Через 10 минут — тоже не «занято»: брошенной аренды нет.
    const later = await acquireTaskLease(dir, me, { ...alive, now: () => Date.now() + 600_000 });
    expect(later).toMatchObject({ ok: true });
    if (later.ok) later.lease.release();
  }, 30_000);

  it('F-24 a short hold of beats.log is waited out: the acquire succeeds once the reader leaves', async () => {
    const dir = tempDir('lease24-');
    const me = identity();
    const first = await acquireTaskLease(dir, me, alive);
    if (!first.ok) throw new Error(first.reason);
    first.lease.release();
    const release = await holdFile(join(dir, TASK_FILES.beats), 'unreadable');
    const pending = acquireTaskLease(dir, me, alive);
    setTimeout(() => void release(), 100);
    const got = await pending;
    expect(got).toMatchObject({ ok: true });
    if (got.ok) {
      expect(readFileSync(join(dir, TASK_FILES.beats), 'utf8')).toContain(got.lease.leaseId);
      got.lease.release();
    }
  }, 30_000);

  it('F-113/H4 release that could not unlink owner.json retries later and removes it', async () => {
    const dir = tempDir('lease113-');
    const got = await acquireTaskLease(dir, identity(), { ...alive, releaseRetryMs: 50 });
    if (!got.ok) throw new Error(got.reason);
    const owner = join(dir, TASK_FILES.owner);
    const release = await holdFile(owner, 'undeletable');
    try {
      got.lease.release();
      expect(existsSync(owner)).toBe(true);
    } finally {
      await release();
    }
    expect(await waitFor(() => !existsSync(owner), 3_000)).toBe(true);
  }, 30_000);

  it('F-113/H4 a late retry never removes the owner.json of a lease taken after it', async () => {
    const dir = tempDir('lease113-');
    const me = identity();
    const got = await acquireTaskLease(dir, me, { ...alive, releaseRetryMs: 1_500 });
    if (!got.ok) throw new Error(got.reason);
    const owner = join(dir, TASK_FILES.owner);
    const release = await holdFile(owner, 'undeletable');
    try {
      got.lease.release();
    } finally {
      await release();
    }
    const next = await acquireTaskLease(dir, me, alive);
    expect(next).toMatchObject({ ok: true });
    if (!next.ok) return;
    expect(next.lease.takeoverOf).toBe(got.lease.leaseId);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(readFileSync(owner, 'utf8')).toContain(next.lease.leaseId);
    next.lease.release();
    expect(existsSync(owner)).toBe(false);
  }, 30_000);

  it('F-30 a silent rival whose pid was born after the liveness snapshot is held, not taken over', async () => {
    const T0 = 1_760_000_000_000;
    const dir = tempDir('lease30-');
    const rival = identity({ pid: 77, pidStart: 'new' });
    const theirs = await acquireTaskLease(dir, rival, { ...alive, now: () => T0 });
    if (!theirs.ok) throw new Error(theirs.reason);
    const table = fakeProcessTable([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    let probeNow = 5;
    const probe = createLivenessProbe(table, 1_000, () => probeNow);
    // Снимок тика сделан до рождения соперника; вопрос аренды приходит в пределах того же тика.
    await probe.snapshot();
    table.set([
      { pid: 1, ppid: 0, start: 'a', startMs: 1 },
      { pid: 77, ppid: 1, start: 'new', startMs: 2 },
    ]);
    const deps: LeaseDeps = {
      isAlive: (id) => probe.isAlive(id),
      now: () => T0 + STALE_MS + 1_000,
    };
    expect(await acquireTaskLease(dir, identity(), deps)).toMatchObject({
      ok: false,
      reason: 'held',
    });
    // Контроль: соперник действительно умер (следующий тик) — молчащая аренда перехватывается.
    table.set([{ pid: 1, ppid: 0, start: 'a', startMs: 1 }]);
    probeNow += 2_000;
    const taken = await acquireTaskLease(dir, identity(), deps);
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) {
      expect(taken.lease.takeoverOf).toBe(theirs.lease.leaseId);
      taken.lease.release();
    }
  });
});
