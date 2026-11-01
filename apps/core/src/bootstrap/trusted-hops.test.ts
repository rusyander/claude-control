import { describe, expect, it } from 'vitest';
import type { Liveness, ProcessIdentity } from '../platform/process-identity.ts';
import { createTrustedHops } from './trusted-hops.ts';

/**
 * Набор доверенных звеньев (P131): замена, а не дополнение; pid сессии и pid без личности не
 * принимаются; сверка снимает умершее звено. Таблица процессов — подставная граница ОС.
 */

function book(opts: {
  alive?: Set<number>;
  session?: Map<number, boolean | 'unknown'>;
  liveness?: Map<number, Liveness>;
}) {
  const notes: [string, Record<string, unknown>][] = [];
  const hops = createTrustedHops({
    identityOf: async (pid) =>
      (opts.alive ?? new Set()).has(pid)
        ? { value: { pid, start: `start-${pid}` } satisfies ProcessIdentity }
        : { absent: true },
    isAlive: async (id) => opts.liveness?.get(id.pid) ?? 'alive',
    isSessionDescendant: async (pid) => opts.session?.get(pid) ?? false,
    note: (event, data) => notes.push([event, data]),
    now: () => 1_000,
  });
  return { hops, notes };
}

describe('trusted hops: replace, refuse session and dead pids, sweep the gone (P131)', () => {
  it('hops.set replaces the set; a refused new pid still drops the old ones', async () => {
    const { hops, notes } = book({ alive: new Set([10, 20]) });
    expect(await hops.set([10])).toMatchObject({ ok: true, accepted: [10], refused: [] });
    expect([...hops.pids]).toEqual([10]);
    await hops.set([20, 20]);
    expect([...hops.pids]).toEqual([20]);
    const dead = await hops.set([30]);
    expect(dead).toMatchObject({ ok: true, accepted: [], refused: [{ pid: 30 }] });
    expect(hops.pids.size).toBe(0);
    expect(hops.view()).toEqual({ count: 0, recordedAt: 1_000 });
    expect(notes.map(([event]) => event)).toEqual(['hops.set', 'hops.set', 'hops.set']);
  });

  it('a session descendant, or a pid whose membership is unknown, is never a hop', async () => {
    const { hops } = book({
      alive: new Set([10, 11, 12]),
      session: new Map<number, boolean | 'unknown'>([
        [11, true],
        [12, 'unknown'],
      ]),
    });
    const reply = await hops.set([10, 11, 12]);
    expect(reply).toMatchObject({
      ok: true,
      accepted: [10],
      refused: [
        { pid: 11, reason: 'session descendant' },
        { pid: 12, reason: 'session membership unknown' },
      ],
    });
    expect([...hops.pids]).toEqual([10]);
  });

  it('concurrent sets apply one after another — never their union', async () => {
    const { hops } = book({ alive: new Set([10, 20]) });
    await Promise.all([hops.set([10]), hops.set([20])]);
    expect([...hops.pids]).toEqual([20]);
  });

  it('sweep drops a hop whose process is dead; unknown liveness keeps it', async () => {
    const liveness = new Map<number, Liveness>([
      [10, 'dead'],
      [20, 'unknown'],
    ]);
    const { hops, notes } = book({ alive: new Set([10, 20]), liveness });
    await hops.set([10, 20]);
    await hops.sweep();
    expect([...hops.pids]).toEqual([20]);
    expect(notes.at(-1)).toEqual(['hops.gone', { pid: 10 }]);
  });
});
