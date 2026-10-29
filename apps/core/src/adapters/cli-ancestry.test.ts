import { describe, expect, it } from 'vitest';
import {
  ancestryChain,
  callerAncestry,
  imageKey,
  nearestCliAncestor,
  type AncestorRow,
} from './cli-ancestry.ts';

/** Предок-CLI проверки (04:41-42, G5): цепочка по ppid, обрыв на переиспользованном pid. */

const row = (pid: number, ppid: number, startMs: number, image?: string): AncestorRow => ({
  pid,
  ppid,
  start: `S${pid}`,
  startMs,
  ...(image ? { image } : {}),
});

describe('CLI ancestry', () => {
  const rows = [
    row(1, 0, 0, 'init'),
    row(300, 1, 1000, 'C:\\Program Files\\Claude\\Claude.EXE'),
    row(400, 300, 2000, 'node.exe'),
    row(500, 400, 3000),
    row(700, 300, 500),
    row(800, 800, 100),
  ];

  it('walks up by ppid from the parent, the process itself excluded', () => {
    expect(ancestryChain(rows, 500).map((r) => r.pid)).toEqual([400, 300, 1]);
  });

  it('a parent started after the child is a reused pid: the chain stops there', () => {
    expect(ancestryChain(rows, 700)).toEqual([]);
  });

  it('a self-parent loop and an unknown pid end the walk', () => {
    expect(ancestryChain(rows, 800)).toEqual([]);
    expect(ancestryChain(rows, 999)).toEqual([]);
  });

  it('an unknown start time ends the walk: unknown never becomes membership of the tree (B2r2-F04)', () => {
    const blind = [row(10, 0, NaN), row(11, 10, 4), row(12, 11, 5)];
    expect(ancestryChain(blind, 12).map((r) => r.pid)).toEqual([11]);
    expect(ancestryChain([row(11, 10, 4), row(12, 11, NaN)], 12)).toEqual([]);
  });

  it("the caller's chain only when its table row matches the start it named; else absent or unknown", () => {
    expect(callerAncestry(rows, { pid: 500, pidStart: 3400 })).toEqual({
      value: ancestryChain(rows, 500),
    });
    expect(callerAncestry(rows, { pid: 999, pidStart: 1 })).toEqual({ absent: true });
    // Чужой pid (или переиспользованный): старт строки не тот, что назван.
    expect(callerAncestry(rows, { pid: 500, pidStart: 3000 + 60_000 })).toEqual({
      unknown: expect.stringMatching(/caller pid 500 started at 3000, the call names 63000/),
    });
    expect(callerAncestry([row(12, 11, NaN)], { pid: 12, pidStart: 5 })).toEqual({
      unknown: 'start of caller pid 12 unknown',
    });
  });

  it('image key ignores directory, .exe and case', () => {
    expect(imageKey('C:\\x\\Claude.EXE')).toBe('claude');
    expect(imageKey('/usr/bin/qwen')).toBe('qwen');
  });

  it('nearest CLI ancestor: the first matching image; none → undefined', () => {
    const chain = ancestryChain(rows, 500);
    expect(nearestCliAncestor(chain, ['claude'])?.pid).toBe(300);
    expect(nearestCliAncestor(chain, ['node', 'claude'])?.pid).toBe(400);
    expect(nearestCliAncestor(chain, ['codex'])).toBeUndefined();
    expect(nearestCliAncestor(chain, [])).toBeUndefined();
  });
});
