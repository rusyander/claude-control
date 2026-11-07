import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, describe, expect, it } from 'vitest';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import {
  createLivenessProbe,
  fakeProcessTable,
  type ProcessIdentity,
} from '../../platform/process-identity.ts';
import type { ProcessRow } from '../../platform/process-table.ts';
import { hostVerdict } from '../../session-host/client.ts';
import { sessionFile } from '../../session-host/protocol.ts';
import { createActivityBook } from './activity.ts';
import { attachObserver } from './attach.ts';
import { createStallWatch } from './stall.ts';

/**
 * Сверка хостов сеансов на ходу ядра (этап 11): хост открытого сеанса доказанно мёртв и исхода
 * нет — остаток дерева CLI снимается, сеанс один раз `host-dead` → lost. Суд — настоящий
 * `hostVerdict` над настоящим каталогом сеанса (`host.json`, `exit.json`) и настоящей пробой
 * жизни; подделаны только таблица процессов ОС и монотонное время.
 */

const HOST = 4242;
const CHILD = 4343;
const row = (pid: number, ppid = 1): ProcessRow => ({
  pid,
  ppid,
  start: `start-${pid}`,
  startMs: 1,
  cpuMs: 10,
});
const id = (pid: number): ProcessIdentity => ({ pid, start: `start-${pid}` });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function rig(
  opts: {
    exit?: boolean;
    host?: boolean;
    hostCheckMs?: number;
    /** Остановка сироты не сняла CLI: `residual` (как `stopTree`) или бросок. */
    orphanStop?: 'residual' | 'throws' | 'unknown';
  } = {},
) {
  const { task } = await openFresh();
  const s = seedSession(task, { stepKind: 'work' });
  const at = { t: 0 };
  const now = () => at.t;
  const notes: string[] = [];
  const note = (event: string) => notes.push(event);
  attachObserver(task, { ctx: { windowOf: () => null, now }, note });
  const dir = mkdtempSync(join(tmpdir(), 'stall-host-'));
  dirs.push(dir);
  if (opts.host !== false)
    writeFileSync(
      sessionFile(dir, 'host'),
      JSON.stringify({ v: 1, host: id(HOST), child: id(CHILD), channel: 'x', startedAt: 1 }),
    );
  if (opts.exit)
    writeFileSync(
      sessionFile(dir, 'exit'),
      JSON.stringify({ v: 1, code: 0, signal: null, stopped: false }),
    );
  const table = fakeProcessTable([row(HOST), row(CHILD, HOST)]);
  const probe = createLivenessProbe(table, 0, now);
  const orphans: number[] = [];
  const stopMode = { now: opts.orphanStop };
  let asked = 0;
  const watch = createStallWatch({
    activity: createActivityBook({ now, note }),
    now,
    probe,
    stop: async () => undefined,
    note,
    options: { stallDefaultMs: 600_000, hostCheckMs: opts.hostCheckMs ?? 0 },
    hostOf: async () => {
      asked += 1;
      return hostVerdict(dir, { probe });
    },
    stopOrphan: async (child) => {
      orphans.push(child.pid);
      if (stopMode.now === 'throws') throw new Error('access denied');
      if (stopMode.now === 'residual') return { residual: [child] };
      if (stopMode.now === 'unknown') return { residual: [child], unknown: 'table unreadable' };
      table.set([]);
      return { residual: [] };
    },
  });
  watch.attach(task);
  const ends = (): JournalLine[] =>
    readJournalLines(task.dir, task.taskId).lines.filter(
      (l) =>
        l.kind === 'session.transition' &&
        l.sessionId === s.sessionId &&
        ['ended', 'lost'].includes((l.data as { to: string }).to),
    );
  return { task, s, at, table, watch, notes, orphans, ends, stopMode, asked: () => asked };
}

describe('host check on the running core: a proven-dead session host ends its session once (stage 11)', () => {
  it('host dead, no exit record, CLI alive: the orphan CLI tree is stopped, host-dead → lost once, a later pass adds nothing', async () => {
    const r = await rig();
    await r.watch.tick();
    expect(r.ends()).toEqual([]);
    // Хост убит, CLI пережил его.
    r.table.set([row(CHILD, HOST)]);
    r.at.t = 1_000;
    await r.watch.tick();
    expect(r.orphans).toEqual([CHILD]);
    expect(r.ends()).toHaveLength(1);
    expect(r.ends()[0]!.data).toMatchObject({ event: 'host-dead', to: 'lost' });
    expect(r.task.state.sessions[r.s.sessionId]?.state).toBe('lost');
    expect(r.notes.filter((n) => n === 'observer.host-dead')).toHaveLength(1);
    r.at.t = 2_000;
    await r.watch.tick();
    expect(r.ends()).toHaveLength(1);
    expect(r.orphans).toEqual([CHILD]);
  });

  it.each(['residual', 'throws', 'unknown'] as const)(
    'host dead, the orphan CLI survives the stop (%s): no lost — the seat stays with the live CLI; once the CLI is gone, lost once',
    async (mode) => {
      const r = await rig({ orphanStop: mode });
      r.table.set([row(CHILD, HOST)]);
      r.at.t = 1_000;
      await r.watch.tick();
      expect(r.orphans).toEqual([CHILD]);
      // `lost` отпускает место шага: при живом CLI это пятый сеанс на четырёх местах.
      expect(r.ends()).toEqual([]);
      expect(r.task.state.sessions[r.s.sessionId]?.state).not.toBe('lost');
      expect(r.notes.filter((n) => n === 'observer.host.stop-failed')).toHaveLength(1);
      // Следующая сверка снова пробует снять; провал не повторяется в записях.
      r.at.t = 2_000;
      await r.watch.tick();
      expect(r.orphans).toEqual([CHILD, CHILD]);
      expect(r.ends()).toEqual([]);
      expect(r.notes.filter((n) => n === 'observer.host.stop-failed')).toHaveLength(1);
      // CLI ушёл (доделал ход или снят): сеанс — lost один раз.
      r.stopMode.now = undefined;
      r.at.t = 3_000;
      await r.watch.tick();
      expect(r.ends()).toHaveLength(1);
      expect(r.ends()[0]!.data).toMatchObject({ event: 'host-dead', to: 'lost' });
    },
  );

  it('host dead WITH an exit record: the normal end is the pump’s — no lost, nothing stopped', async () => {
    const r = await rig({ exit: true });
    r.table.set([]);
    r.at.t = 1_000;
    await r.watch.tick();
    expect(r.ends()).toEqual([]);
    expect(r.orphans).toEqual([]);
  });

  it('host alive, or no host record in the session dir: nothing is judged', async () => {
    const alive = await rig();
    alive.at.t = 1_000;
    await alive.watch.tick();
    expect(alive.ends()).toEqual([]);
    const none = await rig({ host: false });
    none.table.set([]);
    none.at.t = 1_000;
    await none.watch.tick();
    expect(none.ends()).toEqual([]);
    expect(none.orphans).toEqual([]);
  });

  it('host liveness unknown (process table unreadable): no lost — only proven death ends a session', async () => {
    const r = await rig();
    r.table.fail('table unreadable');
    r.at.t = 1_000;
    await r.watch.tick();
    expect(r.ends()).toEqual([]);
  });

  it('hosts are checked no more often than hostCheckMs', async () => {
    const r = await rig({ hostCheckMs: 5_000 });
    await r.watch.tick();
    r.at.t = 1_000;
    await r.watch.tick();
    expect(r.asked()).toBe(1);
    r.at.t = 5_000;
    await r.watch.tick();
    expect(r.asked()).toBe(2);
  });
});
