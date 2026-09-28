import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StatMemo } from './stat-memo.ts';

const PAST = new Date(Date.now() - 60_000);

describe('StatMemo', () => {
  let dir = '';
  let file = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-stat-memo-'));
    file = join(dir, 'a.txt');
    writeFileSync(file, 'a');
    utimesSync(file, PAST, PAST);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const counting = () => {
    let calls = 0;
    const compute = (touch: (path: string) => void) => {
      calls += 1;
      touch(file);
      touch(join(dir, 'missing.txt'));
      return { calls };
    };
    return { compute, calls: () => calls };
  };

  it('пока подпись та же — один расчёт; правка файла или появление пути — новый', () => {
    const memo = new StatMemo<{ calls: number }>({ ttlMs: 60_000 });
    const probe = counting();
    memo.get('k', probe.compute);
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(1);

    utimesSync(file, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(2);

    writeFileSync(join(dir, 'missing.txt'), 'now here');
    utimesSync(join(dir, 'missing.txt'), PAST, PAST);
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(3);
  });

  it('срок жизни, forget и потолок ключей', () => {
    let now = 1_000;
    const memo = new StatMemo<{ calls: number }>({ ttlMs: 100, maxEntries: 2, now: () => now });
    const probe = counting();
    memo.get('k', probe.compute);
    now += 99;
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(1);
    now += 1;
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(2);

    memo.forget('k');
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(3);

    memo.get('b', probe.compute);
    memo.get('c', probe.compute);
    memo.get('k', probe.compute);
    expect(probe.calls()).toBe(6);
  });

  it('путь, правленный посреди расчёта, не даёт запомнить результат', () => {
    const memo = new StatMemo<number>({ ttlMs: 60_000 });
    let calls = 0;
    const compute = (touch: (path: string) => void) => {
      calls += 1;
      touch(file);
      writeFileSync(file, `edit ${calls}`);
      return calls;
    };
    memo.get('k', compute);
    memo.get('k', compute);
    expect(calls).toBe(2);
  });
});
