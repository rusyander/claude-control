import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { createLivenessProbe, fakeProcessTable } from '../../platform/process-identity.ts';
import { sessionFile } from '../../session-host/protocol.ts';
import { sessionDirOf } from '../conductor-wiring/session-start.ts';
import { createObserverWiring } from './index.ts';

/**
 * Проводка наблюдателя передаёт сторожу шаг сверки хостов (`options.hostCheckMs`, этап 11): ядро
 * с коротким шагом (проверки, стенды) узнаёт о мёртвом хосте на следующем тике, а не через 5 с
 * умолчания `HOST_CHECK_MS`. Настоящие журнал, наблюдатель, сторож и суд хоста над каталогом
 * сеанса; подделаны часы и таблица процессов (граница ОС).
 */

async function rig(hostCheckMs: number | undefined) {
  const { task } = await openFresh();
  const seeded = seedSession(task, { stepKind: 'work' });
  const session = task.state.sessions[seeded.sessionId]!;
  const host = { pid: session.hostPid, start: session.hostStart };
  // Каталог сеанса с записью хоста — как его оставляет хост сеанса; дочернего CLI нет.
  const dir = sessionDirOf(task, seeded.sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    sessionFile(dir, 'host'),
    JSON.stringify({ v: 1, host, channel: 'x', startedAt: 1 }),
  );
  const at = { t: 0 };
  const table = fakeProcessTable([{ ...host, ppid: 1, startMs: 1, cpuMs: 10 }]);
  const wiring = createObserverWiring({
    note: () => undefined,
    now: () => at.t,
    options: {
      probe: createLivenessProbe(table, 0, () => at.t),
      stallDefaultMs: 600_000,
      ...(hostCheckMs === undefined ? {} : { hostCheckMs }),
    },
    tickEveryMs: 0,
  });
  wiring.attach(task);
  const lost = () =>
    readJournalLines(task.dir, task.taskId).lines.filter(
      (l) =>
        l.kind === 'session.transition' &&
        l.sessionId === seeded.sessionId &&
        (l.data as { to: string }).to === 'lost',
    );
  return { at, table, wiring, lost };
}

describe('observer wiring: the host check step reaches the stall watch', () => {
  it('hostCheckMs 0: a host that died after the first pass is lost on the very next tick (1 s later)', async () => {
    const r = await rig(0);
    await r.wiring.tick();
    expect(r.lost()).toEqual([]);
    r.table.set([]);
    r.at.t = 1_000;
    await r.wiring.tick();
    expect(r.lost()).toHaveLength(1);
    expect(r.lost()[0]!.data).toMatchObject({ event: 'host-dead', to: 'lost' });
    r.wiring.stop();
  });

  it('no hostCheckMs: the default 5 s step holds the check 1 s later, and finds the dead host at 5 s', async () => {
    const r = await rig(undefined);
    await r.wiring.tick();
    r.table.set([]);
    r.at.t = 1_000;
    await r.wiring.tick();
    expect(r.lost()).toEqual([]);
    r.at.t = 5_000;
    await r.wiring.tick();
    expect(r.lost()).toHaveLength(1);
    r.wiring.stop();
  });
});
