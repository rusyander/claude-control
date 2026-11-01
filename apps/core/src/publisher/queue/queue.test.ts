import { describe, expect, it } from 'vitest';
import { decideShape } from '../compose/compose.ts';
import { syncWithBase } from '../sync/sync.ts';
import { backoffMs, createPublishQueue, nextBackoffAttempt } from './queue.ts';

/** Очередь публикаций, ожидание форжа по единице, форма коммитов и синхронизация с базой. */

describe('publisher queue', () => {
  it('one unit per repository at a time, in arrival order; publish-now moves a waiter to the head', async () => {
    const q = createPublishQueue();
    const order: string[] = [];
    const first = await q.enter('r', 'u1');
    const p2 = q.enter('r', 'u2').then((rel) => (order.push('u2'), rel));
    const p3 = q.enter('r', 'u3').then((rel) => (order.push('u3'), rel));
    expect(q.waiting('r')).toEqual(['u2', 'u3']);
    q.promote('u3');
    expect(q.waiting('r')).toEqual(['u3', 'u2']);
    first();
    (await p3)();
    (await p2)();
    expect(order).toEqual(['u3', 'u2']);
    expect(q.waiting('r')).toEqual([]);
  });

  it('another repository does not wait', async () => {
    const q = createPublishQueue();
    await q.enter('r1', 'u1');
    await expect(q.enter('r2', 'u2')).resolves.toBeTypeOf('function');
  });

  it('backoff grows per unit: 1, 2, 5, 10, 30 minutes, then 30', () => {
    expect([1, 2, 3, 4, 5, 9].map((a) => backoffMs(a) / 60_000)).toEqual([1, 2, 5, 10, 30, 30]);
  });

  it("a unit's wait counts only its own rows: a success resets it", () => {
    expect(nextBackoffAttempt(null, 0)).toBe(1);
    expect(nextBackoffAttempt({ attempt: 2, seq: 10 }, 5)).toBe(3);
    expect(nextBackoffAttempt({ attempt: 2, seq: 10 }, 12)).toBe(1);
  });
});

describe('publisher compose shape', () => {
  const commit = (message: string) => ({
    sha: 's'.repeat(40),
    tree: 't'.repeat(40),
    message,
    author: { name: 'a', email: 'a@x', date: '2026-01-01T00:00:00Z' },
  });
  const kept = (t: string) => ({ kind: 'pass' as const, text: t });

  it('author commits that pass the sieve and the convention are kept', () => {
    expect(
      decideShape({
        commits: [commit('feat: a')],
        unitMessage: 'm',
        sieve: kept,
        convention: null,
      }),
    ).toEqual({ shape: 'kept' });
  });

  it('a refused message squashes the unit into one commit with the journal message', () => {
    const sieve = (t: string) =>
      t.includes('WIP') ? ({ kind: 'refused', reasons: [] } as never) : kept(t);
    expect(
      decideShape({
        commits: [commit('feat: a'), commit('WIP')],
        unitMessage: 'feat: unit',
        sieve,
        convention: null,
      }),
    ).toEqual({ shape: 'squashed', message: 'feat: unit' });
  });

  it('a stripped message is re-messaged with the same tree', () => {
    const sieve = (t: string) => ({
      kind: 'stripped' as const,
      text: t.replace(/\nCo-Authored-By:.*/, ''),
    });
    const got = decideShape({
      commits: [commit('feat: a\nCo-Authored-By: x')],
      unitMessage: 'm',
      sieve: sieve as never,
      convention: null,
    });
    expect(got).toMatchObject({
      shape: 're-messaged',
      rows: [{ tree: 't'.repeat(40), message: 'feat: a' }],
    });
  });
});

describe('publisher sync with base', () => {
  const deps = (merge: 'clean' | 'conflict', rebase: 'rebased' | 'stopped' = 'rebased') => {
    const calls: string[] = [];
    return {
      calls,
      mergeTree: async () => {
        calls.push('merge-tree');
        return merge === 'clean'
          ? { value: { kind: 'clean' as const, tree: 'T' } }
          : { value: { kind: 'conflict' as const, tree: 'T', files: ['a.txt'] } };
      },
      rebase: async () => {
        calls.push('rebase');
        return rebase === 'rebased'
          ? { kind: 'rebased' as const, head: 'H2' }
          : { kind: 'stopped' as const, files: ['a.txt'] };
      },
    };
  };

  it('no conflict: the core never rebases', async () => {
    const d = deps('clean');
    expect(await syncWithBase(d, { baseSha: 'B', head: 'H', mrExists: false })).toEqual({
      kind: 'clean',
    });
    expect(d.calls).toEqual(['merge-tree']);
  });

  it('a conflict before the MR rebases; after the MR it never does', async () => {
    const before = deps('conflict');
    expect(await syncWithBase(before, { baseSha: 'B', head: 'H', mrExists: false })).toEqual({
      kind: 'rebased',
      head: 'H2',
    });
    const after = deps('conflict');
    expect(await syncWithBase(after, { baseSha: 'B', head: 'H', mrExists: true })).toEqual({
      kind: 'conflict',
      files: ['a.txt'],
    });
    expect(after.calls).toEqual(['merge-tree']);
  });

  it('a stopped rebase is a conflict for a fix step', async () => {
    expect(
      await syncWithBase(deps('conflict', 'stopped'), { baseSha: 'B', head: 'H', mrExists: false }),
    ).toEqual({
      kind: 'conflict',
      files: ['a.txt'],
    });
  });
});
