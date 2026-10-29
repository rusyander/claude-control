import { afterEach, describe, expect, it } from 'vitest';
import { hasValue } from './os-kind.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  identityOfPid,
  type ProcessIdentity,
} from './process-identity.ts';
import { descendantsOf, stopProcesses, stopTree } from './tree-stop.ts';
import { diffListeners, listeningPorts } from './resource-scan.ts';
import { environHas, parsePsEnvironment } from './env-marker.ts';
import { startTree, waitFor, type TreeRun } from './__fixtures__/harness.ts';
import { readFileSync } from 'node:fs';

const isWin = process.platform === 'win32';
const runs: TreeRun[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) run.cleanup();
});

async function identities(pids: Record<string, number>): Promise<Record<string, ProcessIdentity>> {
  const out: Record<string, ProcessIdentity> = {};
  for (const [role, pid] of Object.entries(pids)) {
    const id = await identityOfPid(pid);
    if (!hasValue(id)) throw new Error(`${role}: no identity (${JSON.stringify(id)})`);
    out[role] = id.value;
  }
  return out;
}

async function allDead(ids: readonly ProcessIdentity[]): Promise<boolean> {
  const probe = createLivenessProbe(undefined, 0);
  const states = await Promise.all(ids.map((id) => probe.isAlive(id)));
  return states.every((state) => state === 'dead');
}

describe('P53 tree stop — pure tree walk', () => {
  it('P53 child older than its parent (inherited pid) is not a descendant; leaves first, root last', () => {
    const rows = [
      { pid: 10, ppid: 1, start: 'r', startMs: 100 },
      { pid: 11, ppid: 10, start: 'c', startMs: 200 },
      { pid: 12, ppid: 11, start: 'g', startMs: 300 },
      { pid: 13, ppid: 10, start: 'old', startMs: 50 },
    ];
    expect(descendantsOf(rows, { pid: 10, start: 'r' }, -1).map((r) => r.pid)).toEqual([
      12, 11, 10,
    ]);
    expect(descendantsOf(rows, { pid: 10, start: 'reused' }, -1)).toEqual([]);
  });

  it('P53 no snapshot → nothing claimed: unknown + root named as residual', async () => {
    const table = fakeProcessTable();
    table.fail('helper blocked');
    const report = await stopTree({ pid: 5, start: 's' }, {}, { source: table });
    expect(report).toMatchObject({ unknown: 'helper blocked', residual: [{ pid: 5, start: 's' }] });
  });

  it('P53 marker parsers: /proc environ entry and ps -E word match exactly', () => {
    expect(environHas('A=1\0AGENTDECK_TREE=t1\0B=2\0', 'AGENTDECK_TREE', 't1')).toBe(true);
    expect(environHas('AGENTDECK_TREE=t10\0', 'AGENTDECK_TREE', 't1')).toBe(false);
    const ps = readFileSync(new URL('./__fixtures__/darwin-ps-E.txt', import.meta.url), 'utf8');
    // 61003 — `grep` с меткой в argv: в выводе `ps -E` он неотличим от окружения.
    expect(parsePsEnvironment(ps, 'AGENTDECK_TREE', 'task-7')).toEqual([61002, 61003]);
  });

  it('P53 a marked process older than the root is not ours (argv false positive dropped)', async () => {
    const table = fakeProcessTable([
      { pid: 20, ppid: 1, start: 'root', startMs: 10_000 },
      { pid: 21, ppid: 1, start: 'orphan', startMs: 12_000 },
      { pid: 22, ppid: 1, start: 'grep', startMs: 1_000 },
    ]);
    const killed: number[] = [];
    const report = await stopTree(
      { pid: 20, start: 'root' },
      { marker: { name: 'M', value: 'v' }, graceMs: 0 },
      {
        os: 'linux',
        source: table,
        pollMs: 1,
        sweep: async () => ({
          value: [
            { pid: 21, start: 'orphan' },
            { pid: 22, start: 'grep' },
          ],
        }),
        signal: (pid, name) => {
          if (name === 'SIGKILL' || name === 'SIGTERM') killed.push(pid);
          if (pid > 0) table.set([]);
        },
      },
    );
    expect(report.sweepFound.map((s) => s.pid)).toEqual([21]);
    expect(killed).not.toContain(22);
    expect(report.residual).toEqual([]);
  });

  // Таблица — граница ОС: процесс, который после KILL ещё несколько опросов в ней (выход под
  // нагрузкой не мгновенный; так упал полный прогон в контейнере Linux 28.10, остаток pid 947).
  it('P53 POSIX: a KILLed process still listed for a few polls (slow exit) is waited out, not named a residual', async () => {
    const table = fakeProcessTable([{ pid: 30, ppid: 1, start: 'r', startMs: 1 }]);
    let killedAt: number | undefined;
    const source = {
      read: () => {
        if (killedAt !== undefined && table.reads() >= killedAt + 3) table.set([]);
        return table.read();
      },
    };
    const report = await stopTree(
      { pid: 30, start: 'r' },
      { graceMs: 0 },
      {
        os: 'linux',
        source,
        pollMs: 1,
        signal: (_pid, name) => {
          if (name === 'SIGKILL') killedAt ??= table.reads();
        },
      },
    );
    expect(killedAt).toBeDefined();
    expect(report.residual).toEqual([]);
  });

  it('P53 POSIX: a process that never leaves after KILL is named a residual once `killWaitMs` runs out (bounded)', async () => {
    const table = fakeProcessTable([{ pid: 31, ppid: 1, start: 'r', startMs: 1 }]);
    const started = Date.now();
    const report = await stopTree(
      { pid: 31, start: 'r' },
      { graceMs: 0, killWaitMs: 80 },
      { os: 'linux', source: table, pollMs: 5, signal: () => undefined },
    );
    expect(report.residual).toEqual([{ pid: 31, start: 'r' }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('P53 tree stop — real processes on this OS', () => {
  it('P53 grandchildren → none alive after stop, residual empty', async () => {
    const run = startTree('root>mid,mid>leaf,mid>leaf2');
    runs.push(run);
    const ids = await identities(await run.waitPids(['root', 'mid', 'leaf', 'leaf2']));
    const report = await stopTree(ids.root as ProcessIdentity, { graceMs: 2_000 });
    expect(report.residual).toEqual([]);
    // На Windows у каждого консольного node ещё свой conhost.exe — тоже потомок, тоже снят.
    expect(report.targeted.map((t) => t.pid)).toEqual(
      expect.arrayContaining(Object.values(ids).map((i) => i.pid)),
    );
    expect(await allDead(Object.values(ids))).toBe(true);
  });

  it('P53 orphan seen in the last snapshot (parent exited since) → stopped through `known`', async () => {
    const run = startTree('root>mid,mid>orphan*');
    runs.push(run);
    const ids = await identities(await run.waitPids(['root', 'mid', 'orphan']));
    // Снимок тика: сирота ещё потомок.
    const probe = createLivenessProbe(undefined, 0);
    const snap = await probe.snapshot();
    if (!hasValue(snap)) throw new Error('no snapshot');
    const known = descendantsOf(snap.value, ids.root as ProcessIdentity, -1).map(
      ({ pid, start }) => ({ pid, start }),
    );
    expect(known.some((k) => k.pid === ids.orphan?.pid)).toBe(true);
    run.exit('mid');
    await waitFor(async () =>
      (await probe.isAlive(ids.mid as ProcessIdentity)) === 'dead' ? true : undefined,
    );
    const report = await stopTree(ids.root as ProcessIdentity, { graceMs: 2_000, known });
    expect(report.residual).toEqual([]);
    expect(await allDead([ids.root as ProcessIdentity, ids.orphan as ProcessIdentity])).toBe(true);
  });

  it('P53 orphan whose parent exited, carrying the env marker → found by the sweep (Windows: PEB environment)', async () => {
    const marker = { name: 'AGENTDECK_TREE', value: `t-${process.pid}-${Date.now()}` };
    const run = startTree('root>mid,mid>orphan*', { [marker.name]: marker.value });
    runs.push(run);
    const ids = await identities(await run.waitPids(['root', 'mid', 'orphan']));
    run.exit('mid');
    const probe = createLivenessProbe(undefined, 0);
    await waitFor(async () =>
      (await probe.isAlive(ids.mid as ProcessIdentity)) === 'dead' ? true : undefined,
    );
    const report = await stopTree(ids.root as ProcessIdentity, { graceMs: 2_000, marker });
    expect(report.sweepFound.map((s) => s.pid)).toContain(ids.orphan?.pid);
    expect(report.residual).toEqual([]);
    expect(await allDead([ids.root as ProcessIdentity, ids.orphan as ProcessIdentity])).toBe(true);
  });

  it.runIf(!isWin)('P53 POSIX: a child ignoring TERM is KILLed after the grace', async () => {
    const run = startTree('root>stubborn', { TREE_IGNORE_TERM: 'stubborn' });
    runs.push(run);
    const ids = await identities(await run.waitPids(['root', 'stubborn']));
    const started = Date.now();
    const report = await stopTree(ids.root as ProcessIdentity, { graceMs: 700 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(report.residual).toEqual([]);
  });

  it.runIf(isWin)(
    'P53 Windows orphan detached between snapshots holding a port → found by the step-end listener diff, then stopped',
    async () => {
      const before = await listeningPorts();
      if (!hasValue(before)) throw new Error('no listener snapshot');
      const run = startTree('root>mid,mid>listener*');
      runs.push(run);
      const ids = await identities(await run.waitPids(['root', 'mid', 'listener']));
      // Родитель уходит раньше любого снимка дерева: дереву сирота не видна.
      run.exit('mid');
      const probe = createLivenessProbe(undefined, 0);
      await waitFor(async () =>
        (await probe.isAlive(ids.mid as ProcessIdentity)) === 'dead' ? true : undefined,
      );
      const report = await stopTree(ids.root as ProcessIdentity, { graceMs: 1_000 });
      expect(report.targeted.map((t) => t.pid)).not.toContain(ids.listener?.pid);
      expect(await probe.isAlive(ids.listener as ProcessIdentity)).toBe('alive');
      const after = await listeningPorts();
      if (!hasValue(after)) throw new Error('no listener snapshot');
      const fresh = diffListeners(before.value, after.value);
      const port = Number(readFileSync(`${run.dir}/listener.port`, 'utf8'));
      const hit = fresh.find((l) => l.port === port);
      expect(hit?.pid).toBe(ids.listener?.pid);
      const stopped = await stopProcesses([ids.listener as ProcessIdentity]);
      expect(stopped.residual).toEqual([]);
    },
  );
});
