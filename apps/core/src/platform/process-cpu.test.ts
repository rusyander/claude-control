import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { hasValue } from './os-kind.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  identityOfPid,
  probeTrees,
  treeCpuMs,
} from './process-identity.ts';
import { osProcessTable, type ProcessRow } from './process-table.ts';
import { waitFor } from './__fixtures__/harness.ts';

/**
 * Процессор дерева для пробы тишины (этап 8, F9): сумма по одному снимку (корень + потомки по
 * `ppid`), пачка личностей — одним снимком, и настоящий снимок ЭТОЙ ОС, где процессор растёт у
 * крутящегося ребёнка и входит в дерево родителя (Windows — столбец помощника, Linux — `/proc`).
 */

const row = (pid: number, ppid: number, cpuMs: number | null, start = `s${pid}`): ProcessRow => ({
  pid,
  ppid,
  start,
  startMs: 1000,
  cpuMs,
});

describe('stage 8 process tree CPU — one snapshot', () => {
  it('stage 8 treeCpuMs: root + every descendant by ppid, a stranger and a ppid cycle excluded; a child without CPU skipped; root without CPU → null', () => {
    const rows = [
      row(0, 0, 999), // System Idle — свой родитель
      row(10, 1, 100),
      row(11, 10, 40),
      row(12, 11, 7),
      row(13, 10, null),
      row(20, 1, 5_000),
    ];
    expect(treeCpuMs(rows, 10)).toBe(147);
    expect(treeCpuMs(rows, 12)).toBe(7);
    expect(treeCpuMs(rows, 0)).toBe(999 + 0);
    expect(treeCpuMs(rows, 13)).toBeNull();
    expect(treeCpuMs(rows, 99)).toBeNull();
  });

  it('stage 8 probeTrees: a batch of identities → one OS read, verdict + tree CPU each; dead re-checked fresh, no CPU; no snapshot → all unknown', async () => {
    const table = fakeProcessTable([row(10, 1, 100), row(11, 10, 40), row(20, 1, 5)]);
    const probe = createLivenessProbe(table, 1_000, () => 0);
    const got = await probeTrees(probe, [
      { pid: 10, start: 's10' },
      { pid: 20, start: 's20' },
    ]);
    expect(got).toEqual([
      { verdict: 'alive', cpuMs: 140 },
      { verdict: 'alive', cpuMs: 5 },
    ]);
    expect(table.reads()).toBe(1);
    const dead = await probeTrees(probe, [{ pid: 20, start: 'reused' }]);
    expect(dead).toEqual([{ verdict: 'dead', cpuMs: null }]);
    expect(table.reads()).toBe(2);
    table.fail('powershell timed out');
    const blind = await probeTrees(createLivenessProbe(table, 0), [{ pid: 10, start: 's10' }]);
    expect(blind).toEqual([{ verdict: 'unknown', cpuMs: null }]);
    expect(await probeTrees(probe, [])).toEqual([]);
  });
});

describe('stage 8 process CPU — this OS, real processes', () => {
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // вышел
      }
    }
  });

  it.runIf(process.platform !== 'darwin')(
    'stage 8 real snapshot: a spinning child gains CPU between two reads, and the parent tree sum carries it',
    async () => {
      // Ребёнок крутит процессор ~1,5 с только ПОСЛЕ первого снимка (сигнал в stdin), потом спит:
      // под нагрузкой первое чтение таблицы длится секунды, и прирост иначе уходил до него.
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.stdin.once('data',()=>{const t=Date.now();while(Date.now()-t<1500){}});setInterval(()=>{},1000)",
        ],
        { stdio: ['pipe', 'ignore', 'ignore'] },
      );
      const pid = child.pid ?? 0;
      spawned.push(pid);
      const first = await osProcessTable().read();
      if (!hasValue(first)) throw new Error(JSON.stringify(first));
      const before = first.value.find((r) => r.pid === pid)?.cpuMs ?? 0;
      child.stdin?.write('go\n');
      const gained = await waitFor(
        async () => {
          const next = await osProcessTable().read();
          if (!hasValue(next)) return undefined;
          const cpu = next.value.find((r) => r.pid === pid)?.cpuMs;
          if (typeof cpu !== 'number' || cpu - before < 500) return undefined;
          return { cpu, rows: next.value };
        },
        15_000,
        'child CPU growth',
      );
      expect(gained.cpu - before).toBeGreaterThanOrEqual(500);
      // Дерево ЭТОГО процесса включает ребёнка: сумма не меньше его процессора.
      expect(treeCpuMs(gained.rows, process.pid) ?? 0).toBeGreaterThanOrEqual(gained.cpu);
      const self = await identityOfPid(process.pid);
      if (!hasValue(self)) throw new Error(JSON.stringify(self));
      const [probe] = await probeTrees(createLivenessProbe(undefined, 0), [self.value]);
      expect(probe?.verdict).toBe('alive');
      expect(probe?.cpuMs ?? 0).toBeGreaterThanOrEqual(gained.cpu);
    },
    30_000,
  );
});
