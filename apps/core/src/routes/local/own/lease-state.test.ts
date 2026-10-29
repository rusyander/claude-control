import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clearWaitDead,
  dropLeasePoints,
  dropWait,
  LEASE_STATE_FILE,
  leasePlace,
  markWaitDead,
  markWaitPoint,
  readLeaseState,
  readWait,
  readWaits,
  sweepLeasePoints,
  waitOwnedBy,
  waitPointTold,
  waitRank,
  writeLeaseState,
  type WaitOwner,
} from './lease-state.ts';

/**
 * Запись первой смерти владельца места ждущего (11 R:PR-04, P113): одна на все ядра, не
 * сбрасывается, привязана к владельцу; новое место (повторная выдача) и снятие места её убирают.
 */

const A: WaitOwner = { pid: 101, start: 's-a', bootId: 'boot-a' };
const base = mkdtempSync(join(tmpdir(), 'own-dead-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const root = () => mkdtempSync(join(base, 'w-'));
const entries = (workRoot: string) => readdirSync(join(workRoot, '.slot-waiting')).sort();
const at = (owner?: WaitOwner) => ({ slotKey: 'gpu', taskId: 't1', ...(owner ? { owner } : {}) });
const placeOf = (owner: WaitOwner) => ({ slotKey: 'gpu', taskId: 't1', owner });

describe('P113 local:own wait place — first death record', () => {
  it('P113 local:own: the first death time is kept — a later mark (another core) gets the first back, never its own', () => {
    const workRoot = root();
    waitRank(workRoot, placeOf(A), 1);
    expect(markWaitDead(workRoot, at(A), 1_000)).toBe(1_000);
    expect(markWaitDead(workRoot, at(A), 9_000)).toBe(1_000);
    // Запись места не мешает чтению мест: `readWaits` видит одно место.
    expect(readWaits(workRoot, 'gpu').map((p) => p.taskId)).toEqual(['t1']);
  });

  it('P113 local:own: a record about another owner (pid, start or boot differs) or an unreadable one is replaced, then kept', () => {
    for (const other of [
      { ...A, pid: 202 },
      { ...A, start: 's-b' },
      { ...A, bootId: 'boot-b' },
    ]) {
      const workRoot = root();
      markWaitDead(workRoot, at(other), 1_000);
      expect(markWaitDead(workRoot, at(A), 5_000)).toBe(5_000);
      expect(markWaitDead(workRoot, at(A), 7_000)).toBe(5_000);
    }
    const workRoot = root();
    markWaitDead(workRoot, at(A), 1_000);
    const mark = entries(workRoot).find((name) => name.endsWith('.dead')) ?? '';
    writeFileSync(join(workRoot, '.slot-waiting', mark), '{"at":');
    expect(markWaitDead(workRoot, at(A), 3_000)).toBe(3_000);
    expect(markWaitDead(workRoot, at(A), 4_000)).toBe(3_000);
  });

  it('P113 local:own: an owner-less place keeps its own record; a recorded owner does not reuse it', () => {
    const workRoot = root();
    expect(markWaitDead(workRoot, at(), 1_000)).toBe(1_000);
    expect(markWaitDead(workRoot, at(), 2_000)).toBe(1_000);
    expect(markWaitDead(workRoot, at(A), 3_000)).toBe(3_000);
  });

  it('P113 local:own: re-issue (a new place owner), clearing and dropping the place remove the record', () => {
    const workRoot = root();
    waitRank(workRoot, placeOf(A), 1);
    markWaitDead(workRoot, at(A), 1_000);
    waitRank(workRoot, placeOf({ ...A, pid: 303 }), 2);
    expect(entries(workRoot).filter((n) => n.endsWith('.dead'))).toEqual([]);
    markWaitDead(workRoot, at(A), 2_000);
    clearWaitDead(workRoot, 'gpu', 't1');
    expect(markWaitDead(workRoot, at(A), 3_000)).toBe(3_000);
    dropWait(workRoot, 'gpu', 't1');
    expect(entries(workRoot)).toEqual([]);
  });

  it('P113 local:own: the place counts as still owned only by the very owner that wrote it', () => {
    const workRoot = root();
    expect(waitOwnedBy(workRoot, at(A))).toBe(false);
    waitRank(workRoot, placeOf(A), 1);
    expect(waitOwnedBy(workRoot, at(A))).toBe(true);
    expect(waitOwnedBy(workRoot, at({ ...A, pid: 202 }))).toBe(false);
    expect(waitOwnedBy(workRoot, at({ ...A, start: 's-b' }))).toBe(false);
    expect(waitOwnedBy(workRoot, at({ ...A, bootId: 'boot-b' }))).toBe(false);
    expect(waitOwnedBy(workRoot, at())).toBe(false);
  });
});

describe('F-88 local:own human point about a place — one per (place, owner core, waiting task), on disk', () => {
  it('F-88 local:own: a told record holds across readers (a restarted core reads it), per waiting task, bound to the place owner', () => {
    const workRoot = root();
    waitRank(workRoot, placeOf(A), 1);
    expect(waitPointTold(workRoot, at(A), 'mine')).toBe(false);
    markWaitPoint(workRoot, at(A), 'mine');
    expect(waitPointTold(workRoot, at(A), 'mine')).toBe(true);
    // Другая ждущая задача — своя точка.
    expect(waitPointTold(workRoot, at(A), 'theirs')).toBe(false);
    // Запись про этого владельца; другой владелец того же места — не сказано.
    for (const other of [
      { ...A, pid: 202 },
      { ...A, start: 's-b' },
      { ...A, bootId: 'boot-b' },
    ])
      expect(waitPointTold(workRoot, at(other), 'mine')).toBe(false);
    expect(waitPointTold(workRoot, at(), 'mine')).toBe(false);
    // Запись точки — не место: очередь видит одно место.
    expect(readWaits(workRoot, 'gpu').map((p) => p.taskId)).toEqual(['t1']);
  });

  it('F-88 local:own: re-issue (a new place owner) and dropping the place remove its told records', () => {
    const workRoot = root();
    waitRank(workRoot, placeOf(A), 1);
    markWaitPoint(workRoot, at(A), 'mine');
    markWaitPoint(workRoot, at(A), 'theirs');
    waitRank(workRoot, placeOf({ ...A, pid: 303 }), 2);
    expect(entries(workRoot).filter((n) => !n.endsWith('.json'))).toEqual([]);
    markWaitPoint(workRoot, at({ ...A, pid: 303 }), 'mine');
    dropWait(workRoot, 'gpu', 't1');
    expect(entries(workRoot)).toEqual([]);
  });

  it('F-88 local:own: one place is read with its owner; a missing place reads absent', () => {
    const workRoot = root();
    expect(readWait(workRoot, 'gpu', 't1')).toEqual({ absent: true });
    waitRank(workRoot, placeOf(A), 7);
    expect(readWait(workRoot, 'gpu', 't1')).toEqual({
      value: { rank: 7, slotKey: 'gpu', taskId: 't1', owner: A },
    });
  });

  it('F-88 local:own: a lease record carries its owner core; a malformed owner reads as none (judged as an old record, never as a foreign core)', () => {
    const workRoot = root();
    const dir = join(workRoot, 'L1');
    mkdirSync(dir);
    const lease = {
      v: 1 as const,
      leaseId: 'L1',
      routeId: 'local:own',
      model: 'm',
      dialect: 'openai-chat' as const,
      slotKey: 'gpu',
      resources: [],
    };
    writeLeaseState(dir, { ...lease, owner: A });
    expect(readLeaseState(dir)?.owner).toEqual(A);
    for (const bad of [{ pid: '1', start: 's', bootId: 'b' }, { pid: 1, start: 's' }, 'core']) {
      writeFileSync(join(dir, LEASE_STATE_FILE), JSON.stringify({ ...lease, owner: bad }));
      expect(readLeaseState(dir)).toEqual(lease);
    }
  });

  it('F-88 local:own: points about a foreign lease are owner-bound like place points; restore sweeps only the points of leases whose directory is gone', () => {
    const workRoot = root();
    mkdirSync(join(workRoot, 'L1'));
    markWaitPoint(workRoot, leasePlace('gpu', 'L1', A), 'mine');
    markWaitPoint(workRoot, leasePlace('gpu', 'L2', A), 'mine');
    markWaitPoint(workRoot, at(A), 'mine');
    expect(waitPointTold(workRoot, leasePlace('gpu', 'L1', A), 'mine')).toBe(true);
    expect(waitPointTold(workRoot, leasePlace('gpu', 'L1', { ...A, pid: 9 }), 'mine')).toBe(false);
    sweepLeasePoints(workRoot);
    expect(waitPointTold(workRoot, leasePlace('gpu', 'L1', A), 'mine')).toBe(true);
    expect(waitPointTold(workRoot, leasePlace('gpu', 'L2', A), 'mine')).toBe(false);
    // Точка о месте ждущего — не об аренде: уборка её не трогает.
    expect(waitPointTold(workRoot, at(A), 'mine')).toBe(true);
    dropLeasePoints(workRoot, 'gpu', 'L1');
    expect(waitPointTold(workRoot, leasePlace('gpu', 'L1', A), 'mine')).toBe(false);
    expect(readWaits(workRoot, 'gpu')).toEqual([]);
  });
});

describe('local:own wait places on disk — only whole, ranked places queue (F-62, F-68)', () => {
  const placeFile = (workRoot: string, taskId: string): string =>
    join(workRoot, '.slot-waiting', `${Buffer.from(`gpu\n${taskId}`).toString('base64url')}.json`);

  it('F-62 local:own: a place whose rank did not parse is not a place — never rank 0 ahead of a valid waiter', () => {
    const workRoot = root();
    waitRank(workRoot, { slotKey: 'gpu', taskId: 'valid', owner: A }, 1_000);
    writeFileSync(
      placeFile(workRoot, 'broken'),
      JSON.stringify({ v: 2, rank: 'garbage', slotKey: 'gpu', taskId: 'broken', owner: A }),
    );
    expect(readWaits(workRoot, 'gpu').map((p) => [p.taskId, p.rank])).toEqual([['valid', 1_000]]);
  });

  it('F-68 local:own: a half-written atomic-write temp file beside a place is not a second place', () => {
    const workRoot = root();
    waitRank(workRoot, { slotKey: 'gpu', taskId: 't1', owner: A }, 7);
    const name = entries(workRoot)[0] ?? '';
    // Временный файл writeFileAtomic: `.<имя>.tmp-<pid>-<n>` с тем же содержимым.
    writeFileSync(
      join(workRoot, '.slot-waiting', `.${name}.tmp-1-1`),
      JSON.stringify({ v: 2, rank: 3, slotKey: 'gpu', taskId: 't-tmp', owner: A }),
    );
    writeFileSync(
      join(workRoot, '.slot-waiting', 'stray.txt'),
      JSON.stringify({ v: 2, rank: 2, slotKey: 'gpu', taskId: 't-stray', owner: A }),
    );
    expect(readWaits(workRoot, 'gpu').map((p) => p.taskId)).toEqual(['t1']);
  });
});
