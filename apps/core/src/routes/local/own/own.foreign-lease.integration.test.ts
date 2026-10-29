import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteDecisionRecord, RouteLease } from '@agentdeck/contracts/core/routes';
import { acquireExclusive, releaseExclusive } from '../../../platform/exclusive-lock.ts';
import { createLivenessProbe, type LivenessProbe } from '../../../platform/process-identity.ts';
import { stopTree } from '../../../platform/tree-stop.ts';
import { RouteAborted } from '../../lease.ts';
import {
  dropWait,
  leasePlace,
  markWaitPoint,
  readLeaseState,
  waitOwnedBy,
  waitPointTold,
  waitRank,
  writeLeaseState,
  type WaitOwner,
} from './lease-state.ts';
import { OWN_LOCK_FILE } from './route/lock.ts';
import { TREE_MARKER_NAME } from './server.ts';
import { alive } from './__fixtures__/fake-gpu.ts';
import {
  deadMarks,
  recorder,
  restartKit,
  serverPid,
  settle,
  until,
  waitFiles,
} from './__fixtures__/restart-kit.ts';
import { ownDir } from './__fixtures__/own-options.ts';

/**
 * F-88 для аренд `local:own` (решение владельца 28.10): аренда ЖИВОГО чужого ядра — его. Возврат
 * состояния этим ядром не принимает её сервер, освобождение и остановка этого ядра его не
 * останавливают; слот держится за ней, ждущая задача дольше срока получает ОДНУ точку человека
 * с ядром-владельцем и арендой (и через перезапуск). Владелец умер — аренда принимается обычным
 * путём. «Неизвестно» — руки прочь, одна точка после срока. Запись прежнего вида (владелец не
 * записан) принимается, только если её сервер доказанно мёртв. Принятие и снятие места ждущего —
 * под замком каталога: другое ядро, успевшее между чтением и записью, не теряет своё.
 */

const root = mkdtempSync(join(tmpdir(), 'own-foreign-lease-'));
const { track, restartedRoute, liveCore, killedCore, sweep } = restartKit(root);
const sleepers: ChildProcess[] = [];

afterAll(async () => {
  for (const child of sleepers) if (child.exitCode === null) child.kill();
  await sweep();
}, 120_000);

const MODEL = 'tiny-model';
const SLOT = 'gpu';
const HOUR = 3_600_000;
/** Срок класса `slot-wait` (повторы `process.alive`) в этих проверках. */
const DEADLINE = 1_000;

/** Живой процесс «чужого ядра» с личностью, как её читает проба. */
async function sleeper(bootId: string): Promise<{ owner: WaitOwner; kill(): Promise<void> }> {
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

function unknownFor(pids: Set<number>): LivenessProbe {
  const real = createLivenessProbe();
  return { ...real, isAlive: async (id) => (pids.has(id.pid) ? 'unknown' : real.isAlive(id)) };
}

/** Аренда, которую маршрут не держит: её освобождение только дожидается возврата состояния. */
const NONE: RouteLease = { leaseId: 'none', routeId: 'local:own', model: MODEL, resources: [] };

/**
 * Проба, чей ответ о живости `pid` ждёт ворот, пока они взведены: принятие аренды (запись себя
 * владельцем → чтение живости сервера → `held`) останавливается ровно посередине.
 */
function gatedFor(pid: number) {
  const real = createLivenessProbe();
  let armed = false;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((done) => (open = done));
  const probe: LivenessProbe = {
    ...real,
    isAlive: async (id, ...rest) => {
      if (armed && id.pid === pid) await gate;
      return real.isAlive(id, ...rest);
    },
  };
  return { probe, arm: () => void (armed = true), open: () => open() };
}

const leasePoints = (decisions: RouteDecisionRecord[]): RouteDecisionRecord[] =>
  decisions.filter(
    (d) => d.humanPoint && (d.output as { subject?: string } | undefined)?.subject === 'lease',
  );

function waiting(route: ReturnType<typeof restartedRoute>['route'], taskId: string) {
  const controller = new AbortController();
  const r = recorder();
  const acquired: Promise<RouteLease> = track(
    route.acquire({ taskId, model: MODEL, signal: controller.signal }, r.record),
  );
  const slotTaken = (): boolean => r.resources.some((res) => res.kind === 'model-slot');
  return { r, acquired, abort: () => controller.abort(), slotTaken };
}

const options = (bootId: string, journal = recorder()) => ({
  core: { bootId },
  journal: journal.record,
  reissueWindowMs: 200,
  livenessRetryMs: DEADLINE,
  recheckMs: 50,
});

/** Замок каталога аренд, взятый «другим ядром» (этим процессом под чужой меткой). */
async function holdLock(workRoot: string): Promise<() => void> {
  const path = join(workRoot, OWN_LOCK_FILE);
  const me = await createLivenessProbe().identityOf(process.pid);
  if (!('value' in me)) throw new Error('no identity for this process');
  const got = await acquireExclusive(
    path,
    {
      leaseId: 'test-holder',
      pid: process.pid,
      pidStart: me.value.start,
      bootId: 'test',
      build: 'test',
      acquiredAt: Date.now(),
    },
    { isAlive: async () => 'alive', isSilent: () => false, now: Date.now },
  );
  if (!got.acquired) throw new Error(`lock not taken: ${got.reason}`);
  return () => void releaseExclusive(path, 'test-holder');
}

describe('F-88 local:own — a live foreign core’s lease is never adopted, released or stopped', () => {
  it('F-88 local:own: a live foreign core’s lease and model server survive this core’s restore and shutdown; the task behind it gets ONE human point naming the owner core and the lease, also after a restart; owner dies → the lease is adopted and its server stopped by this core', async () => {
    const a = await liveCore('live');
    const leaseDir = join(a.layout.workRoot, a.lease.leaseId);
    const server = serverPid(a.lease);
    expect(readLeaseState(leaseDir)?.owner?.pid).toBe(a.corePid);
    const { route: first, slots: firstSlots } = restartedRoute(a.layout, options('core-1'));
    const mine = waiting(first, 'mine');
    expect(await until(() => leasePoints(mine.r.decisions).length > 0, 15_000)).toBe(true);
    await settle(1_500);
    expect(leasePoints(mine.r.decisions)).toHaveLength(1);
    const owner = readLeaseState(leaseDir)?.owner;
    expect(leasePoints(mine.r.decisions)[0]).toMatchObject({
      class: 'slot-wait',
      facts: [{ readClass: 'process.alive', kind: 'value' }],
      output: {
        subject: 'lease',
        action: 'human-point',
        lease: { slotKey: SLOT, leaseId: a.lease.leaseId },
        owner,
      },
      humanPoint: {
        subject: `lease ${a.lease.leaseId} on slot ${SLOT} of core pid ${a.corePid} start ${owner?.start} boot ${owner?.bootId}`,
        reason: `core pid ${a.corePid} start ${owner?.start} boot ${owner?.bootId} is alive and keeps its lease; no takeover`,
      },
    });
    expect(mine.slotTaken()).toBe(false);
    mine.abort();
    await expect(mine.acquired).rejects.toBeInstanceOf(RouteAborted);
    // Остановка этого ядра: чужая аренда не освобождается, её сервер жив, запись та же.
    const r1 = recorder();
    expect(await first.shutdown(r1.record)).toEqual({ verified: [], leaks: [] });
    // Слот за чужой арендой отпущен вместе с этим ядром (в памяти), сервер — не его.
    expect(firstSlots.held(SLOT)).toBe(false);
    expect(alive(a.corePid)).toBe(true);
    expect(alive(server)).toBe(true);
    expect(readLeaseState(leaseDir)?.owner).toEqual(owner);

    // Перезапуск этого ядра: срок прошёл снова, но задаче уже сказано — точки нет.
    const serverId = readLeaseState(leaseDir)?.server?.identity;
    if (!serverId) throw new Error('lease record without a server');
    const gated = gatedFor(server);
    const { route: second } = restartedRoute(a.layout, {
      ...options('core-2'),
      probe: gated.probe,
    });
    const again = waiting(second, 'mine');
    await settle(DEADLINE + 1_500);
    expect(leasePoints(again.r.decisions)).toEqual([]);
    expect(again.slotTaken()).toBe(false);

    // Ядро-владелец умерло — аренда принимается этим ядром (запись — его), сервер останавливает оно.
    // Принятие стоит посередине (запись уже его, `held` ещё нет): остановка ядра ждёт его конца —
    // иначе вернула бы «утечек нет», а принятая следом аренда с живым сервером осталась бы ничьей
    // (полный прогон 29.10: `verified` пуст).
    gated.arm();
    // Ворота открываются при любом исходе: закрытые, они держали бы перепроверку, а с ней и
    // остановку ядра в уборке файла (прогон под нагрузкой 29.10: тайм-аут опыта + зависший afterAll).
    try {
      await a.kill();
      expect(await until(() => readLeaseState(leaseDir)?.owner?.bootId === 'core-2', 15_000)).toBe(
        true,
      );
      expect(again.slotTaken()).toBe(false);
      again.abort();
      await expect(again.acquired).rejects.toBeInstanceOf(RouteAborted);
      const r2 = recorder();
      const closing = second.shutdown(r2.record);
      const early = await Promise.race([closing.then(() => 'returned'), settle(3_000)]);
      expect(early).toBeUndefined();
      gated.open();
      const out = await closing;
      expect(out.leaks).toEqual([]);
      expect(out.verified.length).toBeGreaterThan(0);
      expect(await createLivenessProbe().isAlive(serverId)).toBe('dead');
    } finally {
      gated.open();
    }
  }, 120_000);

  it('F-88 local:own: a foreign lease whose owner liveness is unknown is left alone — one human point past the deadline, not repeated when the owner later reads alive after a restart', async () => {
    const a = await liveCore('unknown');
    const leaseDir = join(a.layout.workRoot, a.lease.leaseId);
    const server = serverPid(a.lease);
    const { route: first } = restartedRoute(a.layout, {
      ...options('core-1'),
      probe: unknownFor(new Set([a.corePid])),
    });
    const mine = waiting(first, 'mine');
    expect(await until(() => leasePoints(mine.r.decisions).length > 0, 15_000)).toBe(true);
    await settle(1_000);
    expect(leasePoints(mine.r.decisions)).toHaveLength(1);
    expect(leasePoints(mine.r.decisions)[0]).toMatchObject({
      facts: [{ readClass: 'process.alive', kind: 'unknown' }],
      output: { subject: 'lease', action: 'human-point' },
    });
    expect(mine.slotTaken()).toBe(false);
    mine.abort();
    await expect(mine.acquired).rejects.toBeInstanceOf(RouteAborted);
    expect(await first.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
    expect(alive(server)).toBe(true);
    expect(readLeaseState(leaseDir)?.owner?.pid).toBe(a.corePid);

    // Тот же владелец прочитан живым — точка о нём уже сказана этой задаче.
    const { route: second } = restartedRoute(a.layout, options('core-2'));
    const again = waiting(second, 'mine');
    await settle(DEADLINE + 1_500);
    expect(leasePoints(again.r.decisions)).toEqual([]);
    again.abort();
    await expect(again.acquired).rejects.toBeInstanceOf(RouteAborted);
    expect(await second.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
    expect(alive(server)).toBe(true);
    await a.kill();
  }, 120_000);

  it('F-88 local:own: an old lease record without an owner is left alone while its model server lives (its core cannot be proven gone); once the server is dead by identity it is adopted and the slot goes on', async () => {
    const k = await killedCore('legacy');
    const leaseDir = join(k.layout.workRoot, k.lease.leaseId);
    const state = readLeaseState(leaseDir);
    if (!state?.server) throw new Error('lease record without a server');
    // Запись прежнего вида: владелец не записан (ядро до F-88).
    const legacy = { ...state };
    delete legacy.owner;
    writeLeaseState(leaseDir, legacy);
    const server = serverPid(k.lease);
    const { route: first } = restartedRoute(k.layout, options('core-1'));
    const mine = waiting(first, 'mine');
    expect(await until(() => leasePoints(mine.r.decisions).length > 0, 15_000)).toBe(true);
    const label = `lease ${k.lease.leaseId} on slot ${SLOT} (owner core not recorded; judged by model server pid ${server} `;
    expect(leasePoints(mine.r.decisions)[0]?.humanPoint?.subject.startsWith(label)).toBe(true);
    expect(leasePoints(mine.r.decisions)[0]?.humanPoint?.reason).toMatch(
      /: alive by identity, owner core not recorded; no takeover$/,
    );
    mine.abort();
    await expect(mine.acquired).rejects.toBeInstanceOf(RouteAborted);
    expect(await first.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
    expect(alive(server)).toBe(true);
    expect(readLeaseState(leaseDir)?.owner).toBeUndefined();

    // Сервер остановлен (человеком): запись принимается, слот достаётся ждущей задаче.
    const { route: second } = restartedRoute(k.layout, options('core-2'));
    const again = waiting(second, 'mine');
    // Место «queued» мёртвого ядра снято окном (200 мс); слот держит только чужая аренда.
    await settle(1_000);
    expect(again.slotTaken()).toBe(false);
    const report = await stopTree(state.server.identity, {
      group: true,
      marker: { name: TREE_MARKER_NAME, value: state.server.marker },
    });
    expect(report.residual).toEqual([]);
    const lease = await again.acquired;
    expect(readLeaseState(leaseDir)?.owner?.bootId).toBe('core-2');
    expect((await second.release(lease, again.r.record)).leaks).toEqual([]);
    // Принятая аренда освобождается полным протоколом; выгрузку у убитого сервера доказать нечем —
    // это и только это называется (память, дерево и каталог сверены).
    expect((await second.shutdown(recorder().record)).leaks).toEqual([
      { rid: expect.any(String), reason: 'unload unproven: fetch failed' },
    ]);
    expect(readLeaseState(leaseDir)).toBeUndefined();
  }, 120_000);
});

describe('F-88 local:own — a foreign lease released by its live core frees the slot', () => {
  it('F-88 local:own: a live foreign core that releases its lease (directory gone) frees the slot it held here — the task behind it gets the slot; points about leases whose directory is gone are swept at restore', async () => {
    const a = await liveCore('released');
    const leaseDir = join(a.layout.workRoot, a.lease.leaseId);
    const state = readLeaseState(leaseDir);
    if (!state?.server || !state.owner) throw new Error('lease record without a server or owner');
    // След прошлого ядра: точка об аренде, которой уже нет.
    const gone = leasePlace(SLOT, 'gone-lease', state.owner);
    markWaitPoint(a.layout.workRoot, gone, 'someone');
    const { route } = restartedRoute(a.layout, options('core-1'));
    const mine = waiting(route, 'mine');
    // Возврат состояния — событием: освобождение не держимой аренды ждёт его конца (под общей
    // нагрузкой возврат дольше 600 мс — полный прогон 29.10 читал точку до уборки).
    expect(await route.release(NONE, recorder().record)).toEqual({ verified: [], leaks: [] });
    expect(waitPointTold(a.layout.workRoot, gone, 'someone')).toBe(false);
    await settle(600);
    expect(mine.slotTaken()).toBe(false);
    // Живое ядро A освобождает своё: сервер остановлен, каталог аренды и место «queued» убраны.
    const report = await stopTree(state.server.identity, {
      group: true,
      marker: { name: TREE_MARKER_NAME, value: state.server.marker },
    });
    expect(report.residual).toEqual([]);
    dropWait(a.layout.workRoot, SLOT, 'queued');
    rmSync(leaseDir, { recursive: true, force: true });
    const lease = await mine.acquired;
    expect(alive(a.corePid)).toBe(true);
    expect((await route.release(lease, mine.r.record)).leaks).toEqual([]);
    expect(await route.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
    await a.kill();
  }, 120_000);
});

describe('F-88 local:own — the lease directory lock closes the read-then-write races between cores', () => {
  it('F-88 local:own: a dead owner’s lease taken by another live core while this core waits for the directory lock is not adopted — its server survives this core’s shutdown', async () => {
    const k = await killedCore('lock-lease');
    const leaseDir = join(k.layout.workRoot, k.lease.leaseId);
    const server = serverPid(k.lease);
    const b = await sleeper('core-b');
    const release = await holdLock(k.layout.workRoot);
    const { route: c } = restartedRoute(k.layout, options('core-c'));
    // Возврат состояния: владелец A мёртв → принятие ждёт замка.
    const restoring = c.release(
      { leaseId: 'none', routeId: 'local:own', model: MODEL, resources: [] },
      recorder().record,
    );
    await settle(600);
    // Ядро B под замком приняло аренду раньше.
    const state = readLeaseState(leaseDir);
    if (!state) throw new Error('lease record gone');
    writeLeaseState(leaseDir, { ...state, owner: b.owner });
    release();
    await restoring;
    expect(await c.shutdown(recorder().record)).toEqual({ verified: [], leaks: [] });
    expect(alive(server)).toBe(true);
    expect(readLeaseState(leaseDir)?.owner).toEqual(b.owner);
  }, 120_000);

  it('F-88 local:own: a dead owner’s place re-issued to a live core while the reap waits for the directory lock is kept — the reservation stays, no release decision; this core writes its own place only under the lock too', async () => {
    const layout = ownDir(mkdtempSync(join(root, 'lock-place-')));
    const x = await sleeper('core-x');
    await x.kill();
    const b = await sleeper('core-b');
    waitRank(
      layout.workRoot,
      { slotKey: SLOT, taskId: 'other', owner: x.owner },
      Date.now() - HOUR,
    );
    const journal = recorder();
    const { route } = restartedRoute(layout, {
      ...options('core-1', journal),
      reissueWindowMs: 800,
    });
    const release = await holdLock(layout.workRoot);
    const mine = waiting(route, 'mine');
    // Возврат состояния прошёл (смерть владельца «other» записана) — дальше «mine» пишет место.
    expect(await until(() => deadMarks(layout).length === 1, 30_000)).toBe(true);
    await settle(500);
    // Своё место ядро пишет только под замком: пока замок у «другого ядра», места «mine» нет.
    expect(waitFiles(layout)).toHaveLength(1);
    // Окно мёртвого владельца проходит, пока замок у «другого ядра».
    await settle(1_500);
    waitRank(layout.workRoot, { slotKey: SLOT, taskId: 'other', owner: b.owner }, Date.now());
    release();
    await settle(800);
    expect(waitFiles(layout)).toHaveLength(2);
    expect(
      journal.decisions.filter((d) => (d.output as { action?: string }).action === 'release'),
    ).toEqual([]);
    expect(waitOwnedBy(layout.workRoot, { slotKey: SLOT, taskId: 'other', owner: b.owner })).toBe(
      true,
    );
    expect(mine.slotTaken()).toBe(false);
    mine.abort();
    await expect(mine.acquired).rejects.toBeInstanceOf(RouteAborted);
    expect((await route.shutdown(recorder().record)).leaks).toEqual([]);
  }, 120_000);
});
