import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteDecisionRecord, RouteLease } from '@agentdeck/contracts/core/routes';
import { createLivenessProbe, type LivenessProbe } from '../../../platform/process-identity.ts';
import { RouteAborted } from '../../lease.ts';
import { dropWait, markWaitDead, waitOwnedBy, waitRank, type WaitOwner } from './lease-state.ts';
import { ownDir } from './__fixtures__/own-options.ts';
import {
  deadMarks,
  recorder,
  restartKit,
  settle,
  until,
  waitFiles,
} from './__fixtures__/restart-kit.ts';

/**
 * F-88 для `local:own` (11 R:PR-04, решение владельца 28.10): место ждущего ЖИВОГО чужого ядра
 * не снимается, не отменяется и не перехватывается ни в каком возрасте — ни возвратом, ни
 * перепроверкой, ни окном, ни перезапуском этого ядра. Задача, ждущая за ним дольше срока класса
 * `slot-wait`, получает ОДНУ точку человека с ядром-владельцем (pid, старт, загрузка) и местом —
 * одну на (место, владелец) и через перезапуск этого ядра. Владелец умер — обычное окно; место
 * выдано заново другому ядру — точки о прежнем владельце больше нет.
 */

const root = mkdtempSync(join(tmpdir(), 'own-foreign-'));
const { track, restartedRoute, sweep } = restartKit(root);
const sleepers: ChildProcess[] = [];

afterAll(async () => {
  for (const child of sleepers) if (child.exitCode === null) child.kill();
  await sweep();
}, 120_000);

const MODEL = 'tiny-model';
const HOUR = 3_600_000;
/** Срок класса `slot-wait` (повторы `process.alive`) в этих проверках. */
const DEADLINE = 1_000;
/** Окно повторной выдачи после перезапуска: внутри него приходит ещё одна задача. */
const WINDOW = 2_500;
const SLOT = 'gpu';

/** Живой процесс «чужого ядра» с личностью, как её читает проба; `kill` — дождаться выхода. */
async function liveCore(bootId: string): Promise<{ owner: WaitOwner; kill(): Promise<void> }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  sleepers.push(child);
  const pid = child.pid ?? 0;
  const me = await createLivenessProbe().identityOf(pid);
  if (!('value' in me)) throw new Error(`no identity for live pid ${pid}`);
  const exited = once(child, 'exit');
  return {
    owner: { pid, start: me.value.start, bootId },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/** Живость по-настоящему, но для названных pid — «неизвестно» (ОС не назвала время старта). */
function unknownFor(pids: Set<number>): LivenessProbe {
  const real = createLivenessProbe();
  return {
    ...real,
    isAlive: async (id) => (pids.has(id.pid) ? 'unknown' : real.isAlive(id)),
  };
}

const points = (decisions: RouteDecisionRecord[]): RouteDecisionRecord[] =>
  decisions.filter((d) => d.humanPoint);

const subjectOf = (taskId: string, owner: WaitOwner): string =>
  `waiter ${taskId} on slot ${SLOT} of core pid ${owner.pid} start ${owner.start} boot ${owner.bootId}`;

/** Ждущая задача этого ядра; снимается сигналом (перезапуск ядра посреди ожидания). */
function waiting(route: ReturnType<typeof restartedRoute>['route'], taskId: string) {
  const controller = new AbortController();
  const r = recorder();
  const acquired: Promise<RouteLease> = track(
    route.acquire({ taskId, model: MODEL, signal: controller.signal }, r.record),
  );
  // Слот взят — ресурс `model-slot` записан в тот же миг (запуск сервера после него идёт секунды).
  const slotTaken = (): boolean => r.resources.some((res) => res.kind === 'model-slot');
  return { r, acquired, abort: () => controller.abort(), slotTaken };
}

describe('F-88 local:own — a live foreign core’s place is never cancelled; one human point past the deadline', () => {
  it('F-88 local:own: a live foreign core’s place older than every deadline survives recheck ticks, the window and a restart of this core; the task behind it gets ONE human point naming the owner core and the place, also after the restart; owner dies → the dead-owner window removes it', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'survives-')));
    const b = await liveCore('core-b');
    // Место чужого живого ядра поставлено десять часов назад; час назад кто-то ошибочно счёл
    // владельца мёртвым — старше любого срока: окна, повторов, класса.
    const place = { slotKey: SLOT, taskId: 'other', owner: b.owner };
    waitRank(layout.workRoot, place, Date.now() - 10 * HOUR);
    markWaitDead(layout.workRoot, place, Date.now() - HOUR);
    const journal1 = recorder();
    const { route: first } = restartedRoute(layout, {
      core: { bootId: 'core-1' },
      journal: journal1.record,
      reissueWindowMs: 200,
      livenessRetryMs: DEADLINE,
      recheckMs: 50,
    });
    const restoreFrom = Date.now();
    const mine = waiting(first, 'mine');
    expect(await until(() => points(mine.r.decisions).length > 0, 15_000)).toBe(true);
    expect(Date.now() - restoreFrom).toBeGreaterThanOrEqual(DEADLINE);
    // Десятки перепроверок (такт 50 мс): место на месте, точка одна, слот не выдан.
    await settle(1_500);
    expect(points(mine.r.decisions)).toHaveLength(1);
    expect(points(mine.r.decisions)[0]).toMatchObject({
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'value' }],
      output: {
        subject: 'waiter',
        action: 'human-point',
        place: { slotKey: SLOT, taskId: 'other' },
        owner: b.owner,
      },
      humanPoint: {
        subject: subjectOf('other', b.owner),
        reason: `core pid ${b.owner.pid} start ${b.owner.start} boot core-b is alive and keeps its place; no takeover`,
        readClass: 'process.alive',
      },
    });
    expect(mine.slotTaken()).toBe(false);
    expect(waitOwnedBy(layout.workRoot, place)).toBe(true);
    // Живой владелец опроверг прежний «мёртв»: окна нет.
    expect(deadMarks(layout)).toEqual([]);
    expect(journal1.decisions).toEqual([]);

    // Перезапуск этого ядра посреди ожидания: задача снята, ядро остановлено чисто.
    mine.abort();
    await expect(mine.acquired).rejects.toBeInstanceOf(RouteAborted);
    expect((await first.shutdown(recorder().record)).leaks).toEqual([]);
    expect(waitOwnedBy(layout.workRoot, place)).toBe(true);
    const journal2 = recorder();
    const { route: second } = restartedRoute(layout, {
      core: { bootId: 'core-2' },
      journal: journal2.record,
      reissueWindowMs: WINDOW,
      livenessRetryMs: DEADLINE,
      recheckMs: 50,
    });
    const again = waiting(second, 'mine');
    // Срок класса прошёл и у нового ядра — но задаче об этом месте уже сказано: точки нет.
    await settle(DEADLINE + 1_500);
    expect(points(again.r.decisions)).toEqual([]);
    expect(again.slotTaken()).toBe(false);
    expect(waitOwnedBy(layout.workRoot, place)).toBe(true);
    expect(journal2.decisions).toEqual([]);

    // Ядро-владелец умерло: обычное окно повторной выдачи. Пришедшая внутри окна задача точки о
    // мёртвом владельце не получает: точка была о живом.
    await b.kill();
    expect(await until(() => deadMarks(layout).length === 1, 15_000)).toBe(true);
    const late = waiting(second, 'late');
    await settle(300);
    expect(points(late.r.decisions)).toEqual([]);
    // Окно вышло — место снято с решением в журнал, слот у ждавшей задачи.
    const lease = await again.acquired;
    expect(journal2.decisions).toEqual([
      expect.objectContaining({
        class: 'slot-wait',
        output: { subject: 'waiter', action: 'release', taskId: 'other' },
      }),
    ]);
    expect(points(again.r.decisions)).toEqual([]);
    expect(waitOwnedBy(layout.workRoot, place)).toBe(false);
    expect((await second.release(lease, again.r.record)).leaks).toEqual([]);
    const lateLease = await late.acquired;
    expect(points(late.r.decisions)).toEqual([]);
    expect((await second.release(lateLease, late.r.record)).leaks).toEqual([]);
    expect(waitFiles(layout)).toEqual([]);
  }, 120_000);

  it('F-88 local:own: the unknown road and the alive road give one human point together; the place re-issued to another live core drops the stale one — the new owner gets its own after its own deadline', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'roads-')));
    const b = await liveCore('core-b');
    const place = { slotKey: SLOT, taskId: 'other', owner: b.owner };
    waitRank(layout.workRoot, place, Date.now() - 10 * HOUR);
    const hidden = new Set([b.owner.pid]);
    const { route } = restartedRoute(layout, {
      core: { bootId: 'core-1' },
      probe: unknownFor(hidden),
      reissueWindowMs: 200,
      livenessRetryMs: DEADLINE,
      recheckMs: 50,
    });
    const mine = waiting(route, 'mine');
    expect(await until(() => points(mine.r.decisions).length > 0, 15_000)).toBe(true);
    expect(points(mine.r.decisions)[0]).toMatchObject({
      facts: [{ readClass: 'process.alive', kind: 'unknown' }],
      humanPoint: { subject: subjectOf('other', b.owner) },
    });
    // Живость прочиталась: жив, срок давно прошёл — вторая дорога точки не повторяет.
    hidden.clear();
    await settle(1_000);
    expect(points(mine.r.decisions)).toHaveLength(1);
    expect(mine.slotTaken()).toBe(false);
    expect(waitOwnedBy(layout.workRoot, place)).toBe(true);

    // Место выдано заново другому живому ядру (ранг прежний): о прежнем владельце не говорится,
    // новый получает свой срок, потом свою точку — одну.
    const c = await liveCore('core-c');
    const reissued = { ...place, owner: c.owner };
    const reissuedAt = Date.now();
    waitRank(layout.workRoot, reissued, Date.now());
    await settle(DEADLINE / 2);
    expect(points(mine.r.decisions)).toHaveLength(1);
    expect(await until(() => points(mine.r.decisions).length > 1, 15_000)).toBe(true);
    expect(Date.now() - reissuedAt).toBeGreaterThanOrEqual(DEADLINE);
    await settle(800);
    expect(points(mine.r.decisions).map((d) => d.humanPoint?.subject)).toEqual([
      subjectOf('other', b.owner),
      subjectOf('other', c.owner),
    ]);
    expect(mine.slotTaken()).toBe(false);
    expect(waitOwnedBy(layout.workRoot, reissued)).toBe(true);
    // Ждущий ядра «C» получил слот там и снял своё место: брони больше нечего держать.
    dropWait(layout.workRoot, SLOT, 'other');
    expect(await until(mine.slotTaken, 15_000)).toBe(true);
    expect(points(mine.r.decisions)).toHaveLength(2);
    const lease = await mine.acquired;
    expect((await route.release(lease, mine.r.record)).leaks).toEqual([]);
    expect(waitFiles(layout)).toEqual([]);
    await b.kill();
    await c.kill();
  }, 120_000);

  it('F-88 local:own: a dead owner’s place re-issued to a live core WHILE its liveness is being read is not reaped — the live core’s place keeps its reservation', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'race-')));
    const a = await liveCore('core-a');
    const deadOwner = a.owner;
    await a.kill();
    const c = await liveCore('core-c');
    const place = { slotKey: SLOT, taskId: 'other', owner: deadOwner };
    waitRank(layout.workRoot, place, Date.now() - 10 * HOUR);
    const real = createLivenessProbe();
    let hidden = true;
    let reissued = false;
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      core: { bootId: 'core-1' },
      journal: journal.record,
      // Мёртвый владелец сначала «неизвестен»; на чтении, которое скажет «мёртв», место уже
      // выдано заново живому ядру «C» — между чтением места и его снятием.
      probe: {
        ...real,
        isAlive: async (id, question) => {
          if (id.pid !== deadOwner.pid) return real.isAlive(id, question);
          if (hidden) return 'unknown';
          if (!reissued) {
            reissued = true;
            waitRank(layout.workRoot, { ...place, owner: c.owner }, Date.now());
          }
          return real.isAlive(id, question);
        },
      },
      reissueWindowMs: 200,
      livenessRetryMs: 60_000,
      recheckMs: 50,
    });
    const mine = waiting(route, 'mine');
    await settle(500);
    hidden = false;
    expect(await until(() => reissued, 15_000)).toBe(true);
    await settle(1_000);
    expect(mine.slotTaken()).toBe(false);
    expect(journal.decisions).toEqual([]);
    expect(waitOwnedBy(layout.workRoot, { ...place, owner: c.owner })).toBe(true);
    // Ждущий «C» получил слот там и снял место — бронь уходит, слот у нашей задачи.
    dropWait(layout.workRoot, SLOT, 'other');
    expect(await until(mine.slotTaken, 15_000)).toBe(true);
    const lease = await mine.acquired;
    expect((await route.release(lease, mine.r.record)).leaks).toEqual([]);
    await c.kill();
  }, 120_000);
});
