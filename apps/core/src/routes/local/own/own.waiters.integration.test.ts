import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteLease } from '@agentdeck/contracts/core/routes';
import { createLivenessProbe, type LivenessProbe } from '../../../platform/process-identity.ts';
import type { OwnDir } from './__fixtures__/own-options.ts';
import {
  deadMarks,
  recorder,
  restartKit,
  serverPid,
  settle,
  until,
  waitFiles,
} from './__fixtures__/restart-kit.ts';

/**
 * P10 для `local:own` (11 R:PR-04, 01 §Facts F09/F25): судьба мест в очереди слота после
 * перезапуска решается по фактам, не по возрасту. Ждущий упавшего ядра держит место окно
 * повторной выдачи (даже когда слот освободился раньше), не вернулся — место снято с решением в
 * журнал. Живость «неизвестно» (сервера или ядра-владельца места) — повторы до срока класса,
 * потом точка человека у ждущей задачи; слот / место не снимаются молча и без срока не висят.
 */

const root = mkdtempSync(join(tmpdir(), 'own-waiters-'));
const { track, restartedRoute, killedCore, leasesOfDeadCore, sweep } = restartKit(root);

afterAll(sweep, 120_000);

/** Живость по-настоящему, но для названных pid — «неизвестно» (ОС не назвала время старта). */
function unknownFor(pids: Set<number>): LivenessProbe {
  const real = createLivenessProbe();
  return {
    ...real,
    isAlive: async (id) => (pids.has(id.pid) ? 'unknown' : real.isAlive(id)),
  };
}

/** Время первой смерти владельца места задачи — из записи рядом с местом (начало окна). */
function deadSince(layout: OwnDir, taskId: string): number {
  const name = `${Buffer.from(`gpu\n${taskId}`).toString('base64url')}.dead`;
  const raw = readFileSync(join(layout.workRoot, '.slot-waiting', name), 'utf8');
  return (JSON.parse(raw) as { at: number }).at;
}

const MODEL = 'tiny-model';

describe('P10 local:own — places in the slot queue after a core restart are decided by facts', () => {
  it('P10 local:own: a dead core’s waiter keeps its place for the re-issue window even when the slot frees first; never re-issued → removed with a journaled decision, the live waiter then gets the slot', async () => {
    const { layout, lease, corePid } = await killedCore('reap');
    // Живость ядра ниже «неизвестна» только ради окна места; аренда — за доказанно мёртвым.
    leasesOfDeadCore(layout);
    // Окно идёт от первого чтения «мёртв». Освобождение сервера под нагрузкой длится секунды и
    // съело бы окно до проверки, поэтому пока оно идёт, ядро-владелец читается «неизвестно»
    // («неизвестно» окна не начинает); слот при этом освобождается раньше, чем место решено.
    const hidden = new Set([corePid]);
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      journal: journal.record,
      probe: unknownFor(hidden),
      reissueWindowMs: 3_000,
      livenessRetryMs: 600_000,
      recheckMs: 200,
    });
    const r = recorder();
    // Слот освобождается РАНЬШЕ, чем ждущий упавшего ядра вернулся.
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    expect(deadMarks(layout)).toEqual([]);
    let granted: RouteLease | undefined;
    const fresh = track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record)).then(
      (got) => (granted = got),
    );
    expect(await until(() => waitFiles(layout).length === 2, 30_000)).toBe(true);
    hidden.clear();
    // Первое чтение «мёртв» после освобождения слота — начало окна (запись на диске).
    expect(await until(() => deadMarks(layout).length === 1, 30_000)).toBe(true);
    const deadAt = deadSince(layout, 'queued');
    // Внутри окна место «queued» держится: новый запрос ждёт за ним.
    await settle(300);
    expect(Date.now() - deadAt).toBeLessThan(3_000);
    expect(granted).toBeUndefined();
    expect(waitFiles(layout)).toHaveLength(2);
    const second = await fresh;
    expect(Date.now() - deadAt).toBeGreaterThanOrEqual(3_000);
    // Не вернулся за окно — место снято, файл тоже, решение — в журнале ядра с фактами.
    expect(waitFiles(layout)).toEqual([]);
    expect(journal.decisions).toEqual([
      expect.objectContaining({
        class: 'slot-wait',
        facts: [{ readClass: 'process.alive', kind: 'value' }],
        reasons: [
          'waiter core dead by identity; not re-issued within 3000 ms: place removed',
          expect.stringMatching(/^waiter queued on slot gpu of core pid \d+ start \S+ boot \S+$/),
        ],
        output: { subject: 'waiter', action: 'release', taskId: 'queued' },
      }),
    ]);
    // Ждавшая задача получила то же решение (оно её касалось), без точки человека.
    const told = r.decisions.filter((d) => d.class === 'slot-wait');
    expect(told).toHaveLength(1);
    expect(told[0]?.humanPoint).toBeUndefined();
    expect((await route.release(second, r.record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: the dead core’s waiter re-issued after the slot freed takes the kept slot at once; the newer request waits for its release', async () => {
    const { layout, lease } = await killedCore('claim');
    const { route, slots } = restartedRoute(layout, { reissueWindowMs: 60_000, recheckMs: 200 });
    const r = recorder();
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    const granted: string[] = [];
    const fresh = track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record)).then(
      (got) => (granted.push('fresh'), got),
    );
    await settle(300);
    expect(granted).toEqual([]);
    const queued = await track(route.acquire({ taskId: 'queued', model: MODEL }, r.record));
    granted.push('queued');
    await settle(300);
    expect(granted).toEqual(['queued']);
    expect(slots.waiting('gpu')).toBe(1);
    expect((await route.release(queued, r.record)).leaks).toEqual([]);
    expect((await route.release(await fresh, r.record)).leaks).toEqual([]);
    expect(granted).toEqual(['queued', 'fresh']);
    expect(waitFiles(layout)).toEqual([]);
  }, 120_000);

  it('P10 local:own: waiter owner liveness unknown → place kept past the window (never removed silently), human point to the task behind it after the retry deadline; once the owner reads dead → removed and journaled', async () => {
    const { layout, lease, corePid } = await killedCore('unknown-owner');
    // «Неизвестно» здесь — о владельце места; аренда — за доказанно мёртвым ядром.
    leasesOfDeadCore(layout);
    const pids = new Set([corePid]);
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      journal: journal.record,
      probe: unknownFor(pids),
      reissueWindowMs: 500,
      // Срок длиннее освобождения сервера (оно само идёт секунды): точка раньше срока различима.
      livenessRetryMs: 4_000,
      recheckMs: 200,
    });
    const r = recorder();
    // Возврат состояния — не раньше этой отметки: точка человека раньше срока повторов — красный.
    const restoreFrom = Date.now();
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    let granted: RouteLease | undefined;
    const fresh = track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record)).then(
      (got) => (granted = got),
    );
    const point = () => r.decisions.filter((d) => d.humanPoint);
    expect(await until(() => point().length > 0, 15_000)).toBe(true);
    expect(Date.now() - restoreFrom).toBeGreaterThanOrEqual(4_000);
    await settle(800);
    // Одна точка, место и файл на месте, слот не выдан.
    expect(point()).toHaveLength(1);
    expect(point()[0]).toMatchObject({
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'unknown' }],
      humanPoint: {
        subject: expect.stringMatching(
          new RegExp(`^waiter queued on slot gpu of core pid ${corePid} start `),
        ),
        reason: `pid ${corePid}: start time not exposed by the OS`,
        readClass: 'process.alive',
      },
    });
    expect(granted).toBeUndefined();
    expect(waitFiles(layout)).toHaveLength(2);
    expect(journal.decisions).toEqual([]);
    // Живость прочиталась: ядро мертво, окно давно вышло — место снято, слот пошёл дальше.
    pids.clear();
    const second = await fresh;
    expect(journal.decisions).toEqual([
      expect.objectContaining({
        facts: [{ readClass: 'process.alive', kind: 'value' }],
        output: { subject: 'waiter', action: 'release', taskId: 'queued' },
      }),
    ]);
    expect(waitFiles(layout)).toEqual([]);
    expect((await route.release(second, r.record)).leaks).toEqual([]);
  }, 120_000);

  it('P10 local:own: model server liveness unknown → slot held (no second load), retried until the deadline, then the waiting task gets one journaled decision with a human point naming the server and the reason; the read clearing ends it', async () => {
    const { layout, lease } = await killedCore('unknown-server');
    const pid = serverPid(lease);
    const pids = new Set([pid]);
    const { route, slots } = restartedRoute(layout, {
      probe: unknownFor(pids),
      // Место «queued» (ядро мертво) снимается быстро: дальше слот держит только сервер.
      reissueWindowMs: 300,
      livenessRetryMs: 1_500,
      recheckMs: 200,
    });
    const r = recorder();
    // Возврат состояния — не раньше этой отметки: точка человека раньше срока повторов — красный.
    const restoreFrom = Date.now();
    let granted: RouteLease | undefined;
    const fresh = track(route.acquire({ taskId: 'fresh', model: MODEL }, r.record)).then(
      (got) => (granted = got),
    );
    const point = () => r.decisions.filter((d) => d.humanPoint);
    expect(await until(() => point().length > 0, 10_000)).toBe(true);
    expect(Date.now() - restoreFrom).toBeGreaterThanOrEqual(1_500);
    await settle(800);
    expect(point()).toHaveLength(1);
    expect(point()[0]).toMatchObject({
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'unknown' }],
      reasons: expect.arrayContaining([
        'slot stays held: a second model must not load beside an unproven one',
      ]),
      humanPoint: {
        subject: expect.stringMatching(
          new RegExp(`^model server pid ${pid} start \\S+ http://127\\.0\\.0\\.1:\\d+ \\(lease `),
        ),
        reason: `pid ${pid}: start time not exposed by the OS`,
        readClass: 'process.alive',
      },
    });
    expect(granted).toBeUndefined();
    expect(slots.held('gpu')).toBe(true);
    // Место «queued» снимается — слот держит именно сервер с неизвестной живостью. Срок не
    // фиксированный: под полным набором чтение живости мёртвого ядра идёт секундами (28.10).
    expect(await until(() => waitFiles(layout).length === 1, 10_000)).toBe(true);
    expect(slots.held('gpu')).toBe(true);
    // Живость прочиталась (жив): обычная возвращённая аренда, новых точек нет.
    pids.clear();
    await settle(800);
    expect(point()).toHaveLength(1);
    expect(granted).toBeUndefined();
    expect((await route.release(lease, r.record)).leaks).toEqual([]);
    // Освобождение по протоколу — слот уходит ждавшей задаче.
    expect((await route.release(await fresh, r.record)).leaks).toEqual([]);
    expect(slots.held('gpu')).toBe(false);
  }, 120_000);
});
