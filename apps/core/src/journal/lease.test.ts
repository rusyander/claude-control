import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newId } from '../lib/ids/uuidv7.ts';
import { acquireTaskLease, BEATS_ROTATE_BYTES, STALE_MS, type LeaseDeps } from './lease.ts';
import { TASK_FILES } from './journal.types.ts';
import { holdFile } from './__fixtures__/hold-file.ts';
import { identity, tempDir } from './__fixtures__/journal-harness.ts';

/**
 * Аренда задачи на ударах сердца (01 §Lease): чужой читатель файла — не потеря аренды и не
 * падение процесса (ревью M3, M4); устаревание — «молчит 15 с» И «мёртв», молчание считается
 * по ударам именно этой аренды (ревью m1). Файлы держит настоящий чужой процесс (Windows) или
 * права (POSIX) — `hold-file.ts`.
 */
const alive: LeaseDeps = { isAlive: async () => 'alive', now: Date.now };

async function acquired(dir: string, me = identity(), deps: LeaseDeps = alive) {
  const got = await acquireTaskLease(dir, me, deps);
  if (!got.ok) throw new Error(got.reason);
  return got.lease;
}

describe('task lease beats', () => {
  it('M3 owner.json unreadable for a beat is not a lost lease: no onLost, ownership back on the next beat', async () => {
    const dir = tempDir('lease-');
    const lease = await acquired(dir);
    const lost: string[] = [];
    const release = await holdFile(join(dir, TASK_FILES.owner), 'unreadable');
    try {
      lease.tick(() => lost.push('lost'));
      // Пока файл не прочитан, владение не доказано: записи ждут.
      expect(lease.holds()).toBe(false);
    } finally {
      await release();
    }
    lease.tick(() => lost.push('lost'));
    expect(lost).toEqual([]);
    expect(lease.holds()).toBe(true);
    // Контроль: файл действительно чужой — потеря, ровно один раз.
    writeFileSync(join(dir, TASK_FILES.owner), JSON.stringify({ ...identity(), leaseId: newId() }));
    lease.tick(() => lost.push('lost'));
    expect(lost).toEqual(['lost']);
    lease.release();
  }, 30_000);

  it('M3 a leftover owner.json of this very process does not lock its own core out; a live lease of it still does', async () => {
    const dir = tempDir('lease-');
    const me = identity();
    const first = await acquired(dir, me);
    // Живая аренда того же процесса — «занято», не «брошено».
    const whileLive = await acquireTaskLease(dir, me, alive);
    expect(whileLive).toMatchObject({ ok: false, reason: 'held' });
    const release = await holdFile(join(dir, TASK_FILES.owner), 'unreadable');
    try {
      // Отпуск не смог прочитать файл — файл остался на диске.
      first.release();
    } finally {
      await release();
    }
    expect(existsSync(join(dir, TASK_FILES.owner))).toBe(true);
    const again = await acquireTaskLease(dir, me, alive);
    expect(again).toMatchObject({ ok: true });
    if (again.ok) {
      expect(again.lease.takeoverOf).toBe(first.leaseId);
      again.lease.release();
    }
    // Другой процесс, живой: его файл по-прежнему «занято».
    const other = await acquired(dir, identity({ pid: process.pid + 1 }));
    expect(await acquireTaskLease(dir, me, alive)).toMatchObject({ ok: false, reason: 'held' });
    other.release();
  }, 30_000);

  it('M4 rotation blocked by a reader: the beat timer never throws, the beat lands in the old file, rotation follows later', async () => {
    const dir = tempDir('lease-');
    const lease = await acquired(dir);
    const beats = join(dir, TASK_FILES.beats);
    appendFileSync(beats, `${'x'.repeat(BEATS_ROTATE_BYTES + 1024)}\n`);
    const sizeBefore = statSync(beats).size;
    const lost: string[] = [];
    const release = await holdFile(beats, 'undeletable');
    try {
      expect(() => lease.tick(() => lost.push('lost'))).not.toThrow();
    } finally {
      await release();
    }
    expect(statSync(beats).size).toBeGreaterThan(sizeBefore);
    expect(readFileSync(beats, 'utf8')).toContain(lease.leaseId);
    expect(existsSync(join(dir, 'beats.1.log'))).toBe(false);
    lease.tick(() => lost.push('lost'));
    expect(existsSync(join(dir, 'beats.1.log'))).toBe(true);
    expect(statSync(beats).size).toBeLessThan(1024);
    expect(lost).toEqual([]);
    lease.release();
  }, 30_000);
});

// Держатель с другой машины: смерть его pid здесь не доказать — правило молчания (fallback).
// Доказанно мёртвый держатель этой машины перехватывается сразу — `lease.proven-dead.test.ts`.
describe('m1 lease staleness (holder of another host) = silent 15 s by THIS lease AND dead', () => {
  const T0 = 1_760_000_000_000;
  const dead = (now: number): LeaseDeps => ({ isAlive: async () => 'dead', now: () => now });
  const elsewhere = (now: number): LeaseDeps => ({ ...dead(now), host: 'other-machine' });

  it('a dead holder that beat recently is kept; silent past STALE_MS it is taken over', async () => {
    const dir = tempDir('stale-');
    const holder = await acquired(dir, identity({ pid: process.pid + 2 }), elsewhere(T0));
    expect(await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS - 1_000))).toMatchObject({
      ok: false,
      reason: 'held',
    });
    const taken = await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS + 1_000));
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) {
      expect(taken.lease.takeoverOf).toBe(holder.leaseId);
      taken.lease.release();
    }
  });

  it('a fresh beat of ANOTHER lease does not keep a silent holder alive', async () => {
    const dir = tempDir('stale-');
    const holder = await acquired(dir, identity({ pid: process.pid + 3 }), elsewhere(T0));
    appendFileSync(
      join(dir, TASK_FILES.beats),
      `${JSON.stringify({ leaseId: newId(), at: T0 + STALE_MS })}\n`,
    );
    const taken = await acquireTaskLease(dir, identity(), dead(T0 + STALE_MS + 1_000));
    expect(taken).toMatchObject({ ok: true });
    if (taken.ok) {
      expect(taken.lease.takeoverOf).toBe(holder.leaseId);
      taken.lease.release();
    }
  });
});
